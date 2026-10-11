# .github/dottore-review/dottore_review.py
import argparse
import base64
import dataclasses
import fnmatch
import hashlib
import itertools
import json
import os
import pathlib
import posixpath
import re
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from types import SimpleNamespace

REPO_ROOT = pathlib.Path.cwd().resolve()
DOTTORE_MARKER = "<!-- dottore:walkthrough -->"
COMMAND_STATUS_MARKER = "<!-- dottore:command-status -->"
FINDING_MARKER_RE = re.compile(r"<!-- dottore:finding=([0-9a-f]{16}) -->")
STATE_MARKER_RE = re.compile(r"<!-- dottore:last-reviewed-sha=([0-9a-f]{40}) -->")
CONTRACT_STATE_RE = re.compile(r"<!-- dottore:contract-state=([A-Za-z0-9_=-]+) -->")
MAX_REVIEW_PACKET_CHARS = 180_000
MAX_SECTION_CHARS = 60_000
MAX_CONTEXT_FILE_CHARS = 20_000
MAX_SEARCH_HITS = 30
# Search skips minified lines, not large files, so large real sources stay findable; the Python
# fallback still skips files over MAX_SEARCH_FILE_BYTES.
MAX_SEARCH_FILE_BYTES = 5_000_000
MAX_SEARCH_LINE_CHARS = 1_000
# Every finder turn resends the packet, so it carries the change, a few nearby lines and a short
# usage sample; agents read_file and search_repo for more. Wider context mostly diluted the change.
MAX_IDENTIFIER_CONTEXT_CHARS = 12_000
MAX_IDENTIFIER_TERMS = 12
MAX_IDENTIFIER_HITS_PER_TERM = 6
DIFF_CONTEXT_LINES = 8
MAX_FILE_PATCH_CHARS = 55_000
MAX_FILE_SUMMARY_CHARS = 9_000
MAX_REVIEW_CHUNKS = 8
MAX_CHUNK_PATCH_CHARS = 90_000
MAX_INLINE_COMMENT_CHARS = 1_200
MAX_CONTRACT_STATE_ENTRIES = 12
MAX_CONTRACT_STATE_TEXT_CHARS = 320
MAX_CONTRACT_STATE_LIST_ITEMS = 3
# Replies stream, so these limit silence on the stream, not the reply: an attempt that sends nothing for
# this long is retried. An agent's first call has nothing cached yet and has stalled for minutes in the
# provider's queue, while a working one starts replying within about a minute, so it is retried sooner.
MODEL_REQUEST_TIMEOUT = 360
FIRST_CALL_TIMEOUT = 180
# Caps one attempt that keeps streaming; such an attempt is not retried.
MODEL_STREAM_LIMIT = 900
MODEL_MAX_RETRIES = 1
# Waits before resending a call that hit a transient gateway error (unavailable, overloaded, cut stream).
RETRY_DELAYS = (15, 45)
REVIEW_ROLES = ("trace", "finder", "broad", "skeptic", "verify", "scout")
# ponytail: lab hypothesis that one finder per packet, covering both segments' focus, keeps recall at half the
# finder cost, since every packet's finders are most of a review's spend; ("broad", "skeptic") restores two.
FINDER_ROLES = ("finder",)
# A cheaper model traces the diff's blast radius before the finders run; the code quotes what it picks.
# ponytail: lab default for the tracer A/B; DOTTORE_MODELS "trace" overrides it until it earns a setting. It
# runs on the scout's cheap model, since the code quotes its picks and every cent counts against the $0.25 bar.
# ponytail: lab hypothesis that a cheaper model can do the finders' reading for them, so the strong model
# reads a short quoted report instead of every file; keep it only if recall holds and cost falls.
# LinkAPI refuses function tools with reasoning for gpt-6-luna on Chat Completions, so it uses Responses.
SCOUT_MODEL = {"provider": "responses", "model": "gpt-6-luna", "effort": "medium"}
TRACE_MODEL = SCOUT_MODEL
SCOUT_TOOL_BUDGET = 40
SCOUT_TOOL_CHARS = 160_000
# Every scout turn resends all it has read, so it reads in few turns with large batched calls: read_files takes
# several ranges at once, and its search shows a few lines around the first hits so most need no follow-up read.
SCOUT_TURNS = 5
SCOUT_READ_LINES = 400
SCOUT_READ_CHARS = 30_000
MAX_READ_RANGES = 8
SEARCH_CONTEXT_LINES = 3
MAX_CONTEXT_HITS = 12
SCOUT_DEADLINE_SECONDS = 5 * 60
SCOUT_ATTEMPTS = 2
SCOUT_CONCURRENCY = 4
# Scouts in flight across both finders, and the waits that ride out the scout model's per-minute rate limit.
SCOUTS_IN_FLIGHT = 2
SCOUT_RETRY_DELAYS = (5, 10, 20, 40)
# ponytail: lab circuit breaker. A review whose scouts are down tests nothing and still pays the finders, so
# this many failed questions in a row stop it; a shipped scout would fall back to direct reads instead.
SCOUT_OUTAGE_FAILURES = 3
MAX_SCOUT_REPORT_CHARS = 10_000
# The scout model rarely plans or batches, so code does its first step: it reads the path:line references and
# searches the backticked names in the question, and the scout starts from those leads.
LEAD_REF_RE = re.compile(r"([\w./-]+\.\w+):(\d+)(?:\s*[-–]\s*(\d+))?")
LEAD_NAME_RE = re.compile(r"[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*")
LEAD_PATH_RE = re.compile(r"[\w.-]+\.\w{1,5}")
MAX_LEAD_REFS = 3
MAX_LEAD_NAMES = 4
LEAD_LINES_BEFORE = 20
LEAD_LINES_AFTER = 40
MAX_LEAD_CHARS = 12_000
FINDER_READ_BUDGET = 12
# Every finder turn resends the packet and reasons at the strong model's price, so a scouting finder asks in
# one turn, follows up in a second and then must submit; the scout does the reading in between.
FINDER_TURNS = 2
# ponytail: lab hypothesis that the finder misses bugs it would catch by reading the code itself, because the
# scout's reports drop the details that reveal them. False lets it read directly within FINDER_TOOL_BUDGET,
# FINDER_TOOL_CHARS and the time box, as in the uncapped-finder round; True restores the scout.
FINDER_SCOUTS = True
# ponytail: lab hypothesis that the scout's answers and its choice of lines drop the details that reveal a bug.
# True has the scout only find the code: it submits lines, and code quotes the whole named block around each
# (or the lines around it in a long one), so the finder reads the code itself; False restores the answers.
SCOUT_LOCATES = True
MAX_LOCATIONS = 6
LOCATED_BLOCK_LINES = 150
LOCATED_WINDOW = 40
MAX_LOCATED_CHARS = 24_000
# ponytail: lab spending ceiling. A review that costs more than CodeRabbit's $0.25 a PR is no replacement, so
# once a review has spent this much every further model call is refused (calls already in flight still
# finish). Prices are LinkAPI's per 1M tokens in CNY (input, cached input, output); an unpriced model counts at
# the dearest input rate. A shipped ceiling would take its limit and prices from configuration.
REVIEW_COST_LIMIT_USD = 0.25
CNY_PER_USD = 7.0
MODEL_PRICES_CNY = {
    "gpt-6-astra": (3.0, 0.3, 15.0),
    "gpt-6.1-sol": (2.0, 0.08, 8.0),
    "gpt-6-luna": (0.0375, 0.003, 0.15),
    "gpt-5.6-luna": (0.075, 0.006, 0.36),
}
# When a model's gateway fails with a transient error, the same call goes at once to its fallback, an older model
# of the same tier, instead of waiting out the outage. A fallback that refuses a request is not tried again.
FALLBACK_MODELS = {"gpt-6-luna": "gpt-5.6-luna"}
TRACE_TOOL_BUDGET = 12
TRACE_TOOL_CHARS = 48_000
MAX_TRACE_SEEDS = 40
MAX_SEED_HITS_PER_NAME = 10
MAX_SEED_CHARS = 12_000
MAX_TRACE_LOCATIONS = 12
MAX_TRACE_LOCATION_LINES = 60
# Questions the tracer raises where the change meets code it did not change; the finder settles each one.
MAX_TRACE_CHECKS = 8
MAX_TRACE_CHECK_CHARS = 400
MAX_BLAST_RADIUS_CHARS = 24_000
# The changed code the tracer reads before its first tool call, quoted by code so its view of the change does not
# depend on which reads it chooses: each changed line with the lines around it, each short named block containing
# a change in full, and the same-file functions the changed lines call.
CHANGED_CODE_WINDOW = 20
MAX_CHANGED_BLOCK_LINES = 150
MAX_CALLEE_LINES = 60
MAX_CHANGED_CODE_CHARS = 150_000
# Definitions of the local values the change reads, quoted by code so the finders always see them.
MAX_DEFINITIONS = 40
MAX_DEFINITION_LINES = 8
MAX_DEFINITION_CHARS = 10_000
DEFINITION_HOPS = 2
SITE_LINES_AFTER = 2
CODE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".kt", ".swift")
SEGMENT_LABELS = {
    "finder": "Finder",
    "broad": "Broad segment",
    "skeptic": "Skeptical segment",
}
# ponytail: lab hypothesis that the call cap stops finders before they find the bug. MAX_TOOL_LINES and
# MAX_TOOL_CHARS bound each read; the call count is nominal, the time box keeps the checker's share of
# the review deadline, and the character total only guards the context window.
FINDER_TOOL_BUDGET = 100
FINDER_DEADLINE_SECONDS = 15 * 60
# The skeptic starts this long after the broad segment, so its first call can reuse the packet prefix
# the broad call has just cached instead of both paying for it in full.
FINDER_STAGGER_SECONDS = 8
# The checker gets the finders' ceilings: it stops once it has a verdict, so the cap only guards against
# runaway reads, and a tight one left real bugs uncertain when their cause spanned several sections.
VERIFIER_TOOL_BUDGET = 20
# Each agent also has a tool-output budget, since every later turn resends its tool results.
# Verifiers get their own, so finders can never starve verification.
FINDER_TOOL_CHARS = 400_000
VERIFIER_TOOL_CHARS = 96_000
VERIFIER_TOOL_CHARS_PER_EXTRA = 6_000
MAX_SUBMIT_ATTEMPTS = 3
# Every later turn resends a tool result, so reads are kept to a section.
MAX_TOOL_LINES = 120
MAX_TOOL_CHARS = 8_000
NEARBY_LINES = 3
MAX_VERIFIED_CANDIDATES = 20
MAX_OPEN_QUESTIONS = 2
MAX_REVIEW_LIMITATIONS = 2
MAX_GUIDANCE_HEADINGS = 40
EVIDENCE_WINDOW = 3
# Each role talks to OpenAI's Chat Completions format or Claude's Messages format; gateways such as
# LinkAPI serve Claude only through the latter when tools are used.
PROVIDERS = ("openai", "anthropic", "responses")
# Claude requires an output cap; it covers thinking and the reply, and every current model allows it.
CLAUDE_MAX_TOKENS = 32_000
CACHE_BREAKPOINT = {"type": "ephemeral"}
DEFAULT_CONCURRENCY = 4
MAX_CONCURRENCY = 16
# The review step times out at 35 minutes; after this, agents submit and no new verifier starts.
REVIEW_DEADLINE_SECONDS = 25 * 60
# The checker always gets this long after the finders, within a hard limit that leaves the 35-minute step
# time to finish.
VERIFY_RESERVE_SECONDS = 5 * 60
REVIEW_HARD_LIMIT_SECONDS = 30 * 60
SECRET_VALUE_RE = re.compile(
    r"(?i)(api[_-]?key|token|secret|password|passwd|authorization|bearer|client[_-]?secret)"
    r"(\s*[:=]\s*|\s+)([^\s'\"`;&|]+)"
)
SECRET_FILE_PART_RE = re.compile(
    r"(?i)(^|[/\\])(\.env[^/\\]*|.*secret.*|.*credential.*|id_rsa|id_ed25519|\.npmrc|\.netrc)([/\\]|$)"
)


class ReviewTooLarge(Exception):
    pass


@dataclass
class Finding:
    severity: str
    path: str
    line: int | None
    title: str
    body: str
    fix_hint: str
    repair_contract: dict | None = None
    side: str = "RIGHT"
    segment: str = ""
    # A defect on an unchanged line of a changed file: reported in the walkthrough, not inline.
    outside_diff: bool = False


def _safe_path(rel: str) -> pathlib.Path:
    full = (REPO_ROOT / rel).resolve()
    if full != REPO_ROOT and REPO_ROOT not in full.parents:
        raise ValueError("path escapes repo root")
    name = full.name.lower()
    if name.startswith(".env") or name in {
        "credentials.json",
        "id_rsa",
        "id_ed25519",
        ".npmrc",
        ".netrc",
    }:
        raise ValueError("blocked sensitive file")
    return full


def run(args, *, input_text=None, timeout=120, check=False):
    # Without input, give the command an empty stdin: rg with no path reads a piped stdin and hangs.
    stdin = {"input": input_text} if input_text is not None else {"stdin": subprocess.DEVNULL}
    result = subprocess.run(
        args,
        cwd=REPO_ROOT,
        **stdin,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"{' '.join(args)} failed with {result.returncode}:\n"
            f"{result.stdout}{result.stderr}"
        )
    return result


def run_git_raw(args):
    result = run(["git", *args], timeout=90)
    return result.stdout + result.stderr


def run_git(args, limit=MAX_SECTION_CHARS):
    result = run(["git", *args], timeout=90)
    return truncate(result.stdout + result.stderr, limit)


def run_gh(args, *, input_text=None, timeout=120, check=False):
    return run(["gh", *args], input_text=input_text, timeout=timeout, check=check)


def truncate(text, limit):
    if len(text) <= limit:
        return text
    return (
        text[:limit]
        + f"\n\n[truncated: section was {len(text)} chars, limit is {limit} chars]\n"
    )


def redact_for_model(text):
    text = str(text or "")
    text = SECRET_VALUE_RE.sub(lambda match: match.group(1) + match.group(2) + "[REDACTED]", text)
    redacted_lines = []
    for line in text.splitlines():
        if line.startswith(("diff --git ", "+++ ", "--- ", "rename from ", "rename to ")):
            redacted_lines.append(SECRET_FILE_PART_RE.sub(r"\1[REDACTED-SENSITIVE-PATH]\3", line))
            continue
        if SECRET_FILE_PART_RE.search(line) and line.startswith(("+", "-")):
            redacted_lines.append(line[:1] + "[REDACTED-SENSITIVE-LINE]")
            continue
        redacted_lines.append(line)
    return "\n".join(redacted_lines)


def inline_truncate(text, limit=MAX_INLINE_COMMENT_CHARS):
    if len(text) <= limit:
        return text
    suffix = f"\n\n[truncated: inline finding was {len(text)} chars, limit is {limit} chars]"
    keep = max(0, limit - len(suffix))
    return text[:keep].rstrip() + suffix


def compact_state_text(value, limit=MAX_CONTRACT_STATE_TEXT_CHARS):
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def compact_state_values(value):
    values = compact_list(value)
    return [
        compact_state_text(item)
        for item in values[:MAX_CONTRACT_STATE_LIST_ITEMS]
        if compact_state_text(item)
    ]


def read_text(path, limit=MAX_SECTION_CHARS):
    p = _safe_path(path)
    return truncate(p.read_text(encoding="utf-8", errors="replace"), limit)


def search_repo(pattern, code=False):
    """Literal search; code=True matches whole identifiers in code files, sorted by path so the tracer's seeds repeat."""
    if not pattern or len(pattern) > 120:
        return "refused: search pattern must be 1-120 characters"
    if not shutil.which("rg"):
        return search_repo_with_python(pattern, code)
    rg = run(
        [
            "rg",
            "--fixed-strings",
            "--line-number",
            *(["--word-regexp", "--sort=path", "--glob", "*.{" + ",".join(s[1:] for s in CODE_SUFFIXES) + "}"] if code else []),
            "--glob",
            "!node_modules",
            "--glob",
            "!target",
            "--glob",
            "!dist",
            "--glob",
            "!build",
            "--glob",
            "!coverage",
            "--glob",
            "!playwright-report",
            pattern,
        ],
        timeout=60,
    )
    if rg.returncode not in (0, 1):
        return truncate(rg.stdout + rg.stderr, MAX_CONTEXT_FILE_CHARS)
    lines = []
    for line in rg.stdout.splitlines():
        try:
            rel, line_no, body = line.split(":", 2)
            _safe_path(rel)
            if excluded_path(rel) or len(body) > MAX_SEARCH_LINE_CHARS:
                continue
            lines.append(f"{rel}:{line_no}: {body.strip()[:220]}")
        except Exception:
            continue
        if len(lines) >= MAX_SEARCH_HITS:
            break
    return "\n".join(lines) or "no matches"


def search_repo_with_python(pattern, code=False):
    hits = []
    whole = re.compile(rf"(?<!\w){re.escape(pattern)}(?!\w)")
    ignored_parts = {
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        "coverage",
        "playwright-report",
    }
    for path in sorted(REPO_ROOT.rglob("*")) if code else REPO_ROOT.rglob("*"):
        if len(hits) >= MAX_SEARCH_HITS:
            break
        if any(part in ignored_parts for part in path.parts):
            continue
        if not path.is_file() or (code and not path.name.endswith(CODE_SUFFIXES)):
            continue
        try:
            if path.stat().st_size > MAX_SEARCH_FILE_BYTES:
                continue
            rel = path.relative_to(REPO_ROOT)
            # rg skips hidden folders such as .agents/ (tooling, not product code); keep the tracer's seeds the same.
            if excluded_path(rel.as_posix()) or (code and any(part.startswith(".") for part in rel.parts)):
                continue
            text = path.read_text("utf-8", "replace")
        except Exception:
            continue
        if "\0" in text[:8_000]:
            continue
        for line_no, line in enumerate(text.splitlines(), 1):
            if (whole.search(line) if code else pattern in line) and len(line) <= MAX_SEARCH_LINE_CHARS:
                hits.append(f"{rel}:{line_no}: {line.strip()[:220]}")
                if len(hits) >= MAX_SEARCH_HITS:
                    break
    return "\n".join(hits) or "no matches"


def search_repo_hits(pattern, max_hits):
    result = search_repo(pattern)
    if result == "no matches" or result.startswith("refused:"):
        return []
    return result.splitlines()[:max_hits]


def extract_changed_identifiers(patch):
    stop_words = {
        "true",
        "false",
        "null",
        "none",
        "some",
        "string",
        "value",
        "json",
        "expect",
        "should",
        "test",
        "result",
        "state",
        "data",
        "content",
        "message",
        "messages",
        "chat",
        "chats",
        "role",
        "rows",
        "row",
        "import",
        "imported",
        "storage",
        "create",
        "get",
        "list",
        "id",
    }
    counts = {}
    for line in patch.splitlines():
        if not line.startswith(("+", "-")) or line.startswith(("+++", "---")):
            continue
        for token in re.findall(r"[A-Za-z_][A-Za-z0-9_]{3,}", line):
            if token.lower() in stop_words:
                continue
            counts[token] = counts.get(token, 0) + 1
    preferred = sorted(
        counts,
        key=lambda token: (
            not any(char.isupper() for char in token) and "_" not in token,
            -counts[token],
            token.lower(),
        ),
    )
    return preferred[:MAX_IDENTIFIER_TERMS]


def build_identifier_context(patch):
    terms = extract_changed_identifiers(patch)
    sections = []
    for term in terms:
        hits = search_repo_hits(term, MAX_IDENTIFIER_HITS_PER_TERM)
        if not hits:
            continue
        sections.append(f"### {term}\n" + "\n".join(hits))
    if not sections:
        return "No changed identifier usage context found."
    return truncate("\n\n".join(sections), MAX_IDENTIFIER_CONTEXT_CHARS)


def diff_command(base, *options, paths=None):
    command = ["diff", *options, f"{base}...HEAD"]
    if paths is not None:
        command.extend(["--", *paths])
    return command


def excluded_path(path):
    """True for paths rules.json excludes, such as generated bundles; tools neither read nor search them."""
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in load_rules().get("exclude_paths", []))


def changed_files(base, excluded=False):
    """Changed paths the review reads, or with excluded=True the changed paths rules.json excludes."""
    names = run_git(["diff", "--find-renames", "--name-status", f"{base}...HEAD"])
    patterns = load_rules().get("exclude_paths", [])
    paths = []
    for line in names.splitlines():
        fields = line.split("\t")
        if len(fields) < 2:
            continue
        changed = fields[1:] if fields[0].startswith("R") else fields[1:2]
        if any(fnmatch.fnmatchcase(path, pattern) for path in changed for pattern in patterns) == excluded:
            paths.extend(changed)
    return list(dict.fromkeys(paths))


def load_json_file(path):
    try:
        return json.loads(read_text(path, 50_000))
    except FileNotFoundError:
        return None
    except Exception as exc:
        return {"_load_error": str(exc)}


def dottore_prompt_path():
    prompt_path = pathlib.Path(
        os.environ.get("DOTTORE_REVIEW_PROMPT_PATH")
        or ".github/dottore-review/reviewer-prompt.md"
    )
    if not prompt_path.is_absolute():
        prompt_path = REPO_ROOT / prompt_path
    return prompt_path


def dottore_skill_dir():
    return dottore_prompt_path().parent


def load_rules():
    rules_path = pathlib.Path(
        os.environ.get("DOTTORE_REVIEW_RULES_PATH")
        or dottore_skill_dir() / "rules.json"
    )
    if not rules_path.is_absolute():
        rules_path = REPO_ROOT / rules_path
    try:
        return json.loads(rules_path.read_text("utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as exc:
        return {"_load_error": str(exc)}


def guidance_from_rules(files, rules):
    guidance = ["AGENTS.md"]
    for item in rules.get("path_instructions", []):
        prefixes = item.get("prefixes", [])
        if any(any(path.startswith(prefix) for prefix in prefixes) for path in files):
            guidance.extend(item.get("guidance", []))
    return list(dict.fromkeys(guidance))


def select_guidance(files):
    rules = load_rules()
    if rules and "_load_error" not in rules:
        return guidance_from_rules(files, rules)
    guidance = ["AGENTS.md"]
    joined = "\n".join(files)
    if any(
        marker in joined
        for marker in ("packages/shared/", "packages/server/src/", "packages/client/src/")
    ):
        guidance.append("docs/development/architecture-map.md")
    if "packages/client/" in joined:
        guidance.extend(["docs/development/frontend.md", "packages/client/.instructions.md", "docs/development/localization.md"])
    if "packages/server/" in joined:
        guidance.extend(["CONTRIBUTING.md", "docs/development/logging.md"])
    if any(
        marker in joined
        for marker in (
            "chat",
            "roleplay",
            "game",
            "conversation",
            "prompt",
            "generation",
            "summary",
            "memory",
        )
    ):
        guidance.append("packages/client/.instructions.md")
    if any(
        marker in joined
        for marker in ("storage", "import", "provider", "db/", "migration", "services/")
    ):
        guidance.append("docs/development/file-storage.md")
    if any(marker in joined for marker in ("README", "docs/", "AGENTS.md", "CONTRIBUTING.md", "CLAUDE.md")):
        guidance.append("CONTRIBUTING.md")
    return list(dict.fromkeys(guidance))


def guidance_index(path):
    """List a guidance file's size and headings so an agent can read_file just the section it needs."""
    lines = _safe_path(path).read_text("utf-8", "replace").splitlines()
    headings = [
        f"  {number}: {line.strip()}"
        for number, line in enumerate(lines, 1)
        if re.match(r"#{1,3} ", line)
    ]
    if len(headings) > MAX_GUIDANCE_HEADINGS:
        headings = headings[:MAX_GUIDANCE_HEADINGS] + ["  ..."]
    return "\n".join([f"{path} ({len(lines)} lines)", *headings])


def matching_path_rules(files):
    rules = load_rules()
    if not rules or "_load_error" in rules:
        return "No additional Dottore path rules loaded."
    matched = []
    for item in rules.get("path_instructions", []):
        prefixes = item.get("prefixes", [])
        if any(any(path.startswith(prefix) for prefix in prefixes) for path in files):
            matched.append(item)
    payload = {
        "severity_policy": rules.get("severity_policy", {}),
        "review_focus": rules.get("review_focus", []),
        "matched_path_instructions": matched,
        "repo_concerns": rules.get("repo_concerns", []),
    }
    return json.dumps(payload, indent=2, sort_keys=True)


def diff_for_path(base, path):
    return redact_for_model(
        run_git_raw(["diff", "--find-renames", f"--unified={DIFF_CONTEXT_LINES}", f"{base}...HEAD", "--", path])
    )


def build_file_context(base, files):
    sections = []
    for path in files:
        patch = diff_for_path(base, path)
        if not patch:
            continue
        if len(patch) <= MAX_FILE_PATCH_CHARS:
            sections.append(f"### {path}\n```diff\n{patch}\n```")
            continue
        sections.append(
            "### "
            + path
            + "\n```text\n"
            + truncate(run_git(diff_command(base, "--stat", paths=[path]), 2_000), 2_000)
            + truncate(patch, MAX_FILE_SUMMARY_CHARS)
            + "\n```"
        )
    return "\n\n".join(sections) or "No per-file patch context found."


def build_review_packet(base, mode, focus_files=None, include_full_patch=True):
    files = changed_files(base)
    context_files = focus_files or files
    if focus_files is None or include_full_patch:
        patch = (
            redact_for_model(
                run_git_raw(
                    diff_command(base, "--find-renames", f"--unified={DIFF_CONTEXT_LINES}", paths=files)
                )
            )
            if files
            else ""
        )
    else:
        patch = "\n".join(diff_for_path(base, path) for path in focus_files)
    # Send the diff once: whole when it fits, otherwise per file, since every agent turn resends it.
    if len(patch) <= MAX_SECTION_CHARS:
        patch_body = patch
        file_context = "The patch overview above holds every focus file's patch."
    else:
        patch_body = (
            "Full patch exceeded the inline packet limit; see the per-file patch context below "
            "and use the file_diff tool for a file summarized there."
        )
        file_context = build_file_context(base, context_files)
    # Guidance is indexed, not inlined, because every agent turn resends the packet.
    # Agents read_file the sections that bear on a suspicion.
    index = []
    for path in select_guidance(files):
        try:
            index.append(guidance_index(path))
        except Exception as exc:
            index.append(f"{path}: could not read: {exc}")
    sections = [
        ("review mode", mode),
        ("git status", run_git(["status", "--short", "--branch"], 12_000)),
        ("repo root", run_git(["rev-parse", "--show-toplevel"], 4_000)),
        ("merge base", run_git(["merge-base", "HEAD", base], 4_000)),
        ("diff stat", run_git(diff_command(base, "--stat", paths=files), 20_000) if files else "No included changes."),
        ("changed files", "\n".join(files) or "No changed files reported."),
        # Listed so a finder does not mistake an excluded file, such as a rebuilt bundle, for one the PR forgot.
        (
            "changed but excluded from review (generated or excluded by the review rules; not shown)",
            "\n".join(changed_files(base, excluded=True)) or "None.",
        ),
        ("numstat", run_git(diff_command(base, "--numstat", paths=files), 20_000) if files else "No included changes."),
        ("focus files", "\n".join(context_files) or "All changed files."),
        # Rules and guidance precede the diff so the packet limit trims the diff, not them.
        ("Dottore path rules", matching_path_rules(files)),
        ("selected guidance index", "\n\n".join(index) or "No guidance selected."),
        ("patch overview", patch_body),
        ("per-file patch context", file_context),
        ("changed identifier usage", build_identifier_context(patch)),
    ]

    packet = "\n\n".join(
        f"## {title}\n```text\n{redact_for_model(body)}\n```" for title, body in sections
    )
    if len(packet) > MAX_REVIEW_PACKET_CHARS:
        packet = truncate(packet, MAX_REVIEW_PACKET_CHARS)
    return packet


def chunk_changed_files(base, files):
    chunks = []
    current = []
    current_size = 0
    for path in files:
        patch_size = len(diff_for_path(base, path))
        if current and current_size + patch_size > MAX_CHUNK_PATCH_CHARS:
            chunks.append(current)
            current = []
            current_size = 0
        current.append(path)
        current_size += patch_size
    if current:
        chunks.append(current)
    if len(chunks) <= MAX_REVIEW_CHUNKS:
        return chunks
    merged = chunks[: MAX_REVIEW_CHUNKS - 1]
    overflow = [path for chunk in chunks[MAX_REVIEW_CHUNKS - 1 :] for path in chunk]
    merged.append(overflow)
    return merged


def usage_value(usage, *path):
    current = usage
    for key in path:
        if current is None:
            return 0
        if isinstance(current, dict):
            current = current.get(key)
        else:
            current = getattr(current, key, None)
    return current or 0


def add_usage(totals, usage):
    totals["prompt_tokens"] += usage_value(usage, "prompt_tokens")
    totals["completion_tokens"] += usage_value(usage, "completion_tokens")
    totals["total_tokens"] += usage_value(usage, "total_tokens")
    totals["cached_tokens"] += usage_value(usage, "prompt_tokens_details", "cached_tokens")
    totals["reasoning_tokens"] += usage_value(
        usage, "completion_tokens_details", "reasoning_tokens"
    )


def build_stats(review_packet):
    return {
        "started_at": time.monotonic(),
        "review_packet_chars": len(review_packet),
        "roles": {
            role: {
                "model": "",
                "model_calls": 0,
                "tool_calls": 0,
                "tool_chars": 0,
                "stop_own": 0,
                "stop_calls": 0,
                "stop_turns": 0,
                "stop_chars": 0,
                "stop_time": 0,
                "scout_asks": 0,
                "follow_ups": 0,
                "fallbacks": 0,
                "retries": 0,
                "failures": 0,
                "prompt_tokens": 0,
                "cached_tokens": 0,
                "completion_tokens": 0,
                "reasoning_tokens": 0,
                "total_tokens": 0,
            }
            for role in REVIEW_ROLES
        },
        "verification": {},
    }


def print_telemetry(stats):
    elapsed = time.monotonic() - stats["started_at"]
    roles = stats["roles"]
    counters = ("model_calls", "tool_calls", "prompt_tokens", "cached_tokens", "completion_tokens", "reasoning_tokens", "total_tokens")
    parts = [f"elapsed_s={elapsed:.1f}", f"review_packet_chars={stats['review_packet_chars']}"]
    parts += [f"{key}={sum(role[key] for role in roles.values())}" for key in counters]
    for name, role in roles.items():
        parts.append(f"{name}=" + ",".join(f"{key}:{value}" for key, value in role.items() if value))
    parts += [f"{key}={value}" for key, value in stats["verification"].items()]
    print("Dottore telemetry: " + "; ".join(parts), flush=True)


def role_models():
    """Resolve each role's provider, model and effort; DOTTORE_MODELS overrides the shared defaults per role."""
    default_provider = os.environ.get("DOTTORE_PROVIDER", "").strip().lower() or PROVIDERS[0]
    default_model = os.environ.get("LLM_MODEL", "").strip() or "gpt-5.5"
    default_effort = os.environ.get("DOTTORE_REASONING_EFFORT", "").strip()
    raw = os.environ.get("DOTTORE_MODELS", "").strip()
    try:
        overrides = json.loads(raw) if raw else {}
    except ValueError as exc:
        raise ValueError(f"DOTTORE_MODELS is not valid JSON: {exc}") from exc
    if not isinstance(overrides, dict) or not all(
        role in REVIEW_ROLES and isinstance(value, dict) for role, value in overrides.items()
    ):
        raise ValueError(
            'DOTTORE_MODELS must map "trace", "finder", "broad", "skeptic", "verify" or "scout" to {"provider", "model", "effort"} objects.'
        )
    defaults = {role: {"model": default_model, "effort": default_effort} for role in REVIEW_ROLES}
    defaults["trace"] = TRACE_MODEL
    defaults["scout"] = SCOUT_MODEL
    models = {
        role: {
            "provider": str(
                overrides.get(role, {}).get("provider") or defaults[role].get("provider") or default_provider
            )
            .strip()
            .lower(),
            "model": str(overrides.get(role, {}).get("model") or defaults[role]["model"]).strip(),
            "effort": str(overrides.get(role, {}).get("effort") or defaults[role]["effort"]).strip(),
            "endpoint": role if any(role_endpoint(role)) else "",
        }
        for role in REVIEW_ROLES
    }
    unknown = sorted({settings["provider"] for settings in models.values()} - set(PROVIDERS))
    if unknown:
        raise ValueError(f"Unknown Dottore provider {', '.join(unknown)}; use {' or '.join(PROVIDERS)}.")
    return models


def role_endpoint(role):
    """A role's own endpoint, from the DOTTORE_<ROLE>_BASE_URL and DOTTORE_<ROLE>_API_KEY secrets; either one left
    empty falls back to the shared value for the role's provider. GitHub refuses an empty secret, so a placeholder
    without a letter or digit, such as ".", counts as empty."""
    prefix = f"DOTTORE_{role.upper()}_"
    values = (os.environ.get(prefix + name, "").strip() for name in ("BASE_URL", "API_KEY"))
    return tuple(value if re.search(r"[A-Za-z0-9]", value) else "" for value in values)


def review_clients(models):
    """One client per API family and endpoint the roles use: "openai" or "anthropic" for the shared endpoint, and
    "openai:<role>" or "anthropic:<role>" for a role with its own."""
    clients = {}
    for role, settings in models.items():
        family = "anthropic" if settings["provider"] == "anthropic" else "openai"
        key = f"{family}:{settings['endpoint']}" if settings["endpoint"] else family
        if key in clients:
            continue
        base_url, api_key = role_endpoint(role) if settings["endpoint"] else ("", "")
        if family == "openai":
            from openai import OpenAI

            clients[key] = OpenAI(
                api_key=api_key or os.environ["OPENAI_API_KEY"],
                base_url=base_url or os.environ.get("LLM_BASE_URL") or None,
                max_retries=MODEL_MAX_RETRIES,
            )
        else:
            from anthropic import Anthropic

            # Gateways such as LinkAPI take one key for both formats, so the shared key is the fallback.
            clients[key] = Anthropic(
                api_key=api_key or os.environ.get("ANTHROPIC_API_KEY") or os.environ["OPENAI_API_KEY"],
                base_url=base_url or os.environ.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com",
                max_retries=MODEL_MAX_RETRIES,
            )
    return clients


def endpoint_summary(models):
    """Which roles have their own endpoint and which of its values they set, never the values themselves."""
    own = [
        f"{role}=own " + "+".join(name for name, value in zip(("base_url", "api_key"), role_endpoint(role)) if value)
        for role, settings in models.items()
        if settings["endpoint"]
    ]
    return "; ".join(own) or "shared"


def role_client(ctx, family, settings):
    """The client for a call: the role's own endpoint when it has one, else the shared one. A fallback model keeps
    its role's endpoint."""
    endpoint = settings.get("endpoint")
    return ctx.clients[f"{family}:{endpoint}" if endpoint else family]


def review_concurrency():
    raw = os.environ.get("DOTTORE_CONCURRENCY", "").strip()
    if not raw:
        return DEFAULT_CONCURRENCY
    if not raw.isdigit() or int(raw) < 1:
        raise ValueError("DOTTORE_CONCURRENCY must be a positive whole number.")
    return min(int(raw), MAX_CONCURRENCY)


@dataclass
class ReviewRun:
    """What every agent in one review shares: the clients, models, telemetry and the diff scope."""

    clients: dict
    skill: str
    models: dict
    stats: dict
    base: str
    merge_base: str
    files: frozenset
    deadline: float
    cache_key: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)
    scouts: threading.Semaphore = field(default_factory=lambda: threading.Semaphore(SCOUTS_IN_FLIGHT))
    scout_streak: int = 0
    spent_usd: float = 0.0
    # Each answered scout's conversation by id, so a follow-up goes to the scout that already read the code.
    scout_sessions: dict = field(default_factory=dict)
    scout_count: int = 0
    dead_fallbacks: set = field(default_factory=set)


def function_tool(name, description, properties, required):
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }


PATH_PARAM = {"type": "string", "description": "Repository-relative path."}
LINE_RANGE = {
    "start": {"type": "integer", "description": "First line, 1-based."},
    "end": {"type": "integer", "description": "Last line, inclusive."},
}
READ_TOOLS = [
    function_tool(
        "read_file",
        f"Read numbered lines of a repository file at the PR head, at most {MAX_TOOL_LINES} lines per call.",
        {"path": PATH_PARAM, **LINE_RANGE},
        ["path"],
    ),
    function_tool(
        "search",
        f"Find literal text in the repository at the PR head; returns up to {MAX_SEARCH_HITS} path:line hits.",
        {"literal": {"type": "string", "description": "Exact text to find, 1-120 characters."}},
        ["literal"],
    ),
    function_tool(
        "file_diff",
        "Show the pull request's diff for one changed file.",
        {"path": PATH_PARAM},
        ["path"],
    ),
    function_tool(
        "base_version",
        f"Read numbered lines of a file at the review base, for code the PR removes or rewrites; at most {MAX_TOOL_LINES} lines per call.",
        {"path": PATH_PARAM, **LINE_RANGE},
        ["path"],
    ),
]
SCOUT_READ_TOOLS = [
    function_tool(
        "read_files",
        f"Read numbered lines of repository files at the PR head: up to {MAX_READ_RANGES} ranges from any files in "
        f"one call, {SCOUT_READ_LINES} lines in total. Ask for every range you need in the same call.",
        {
            "ranges": {
                "type": "array",
                "items": {"type": "object", "properties": {"path": PATH_PARAM, **LINE_RANGE}, "required": ["path"]},
            },
        },
        ["ranges"],
    ),
    function_tool(
        "search",
        f"Find literal text in the repository at the PR head; returns up to {MAX_SEARCH_HITS} hits, the first "
        f"{MAX_CONTEXT_HITS} with {SEARCH_CONTEXT_LINES} lines either side.",
        {"literal": {"type": "string", "description": "Exact text to find, 1-120 characters."}},
        ["literal"],
    ),
    *READ_TOOLS[2:],
]
STRING_LIST = {"type": "array", "items": {"type": "string"}}
REVIEW_ITEM = {
    "type": "object",
    "properties": {
        "severity": {"type": "string", "enum": ["blocking", "high", "medium", "low"]},
        "path": {"type": "string"},
        "line": {"type": "integer"},
        "side": {"type": "string", "enum": ["LEFT", "RIGHT"]},
        "title": {"type": "string"},
        "body": {"type": "string"},
        "fix_hint": {"type": "string"},
        "repair_contract": {"type": "object"},
    },
    "required": ["path", "line", "title", "body"],
}
EVIDENCE = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "line": {"type": "integer"},
            "snippet": {"type": "string"},
        },
        "required": ["path", "line", "snippet"],
    },
}
SUBMIT_FINDINGS = function_tool(
    "submit_findings",
    "Submit this segment's candidate findings and notes. This ends the segment.",
    {
        "change_summary": STRING_LIST,
        "findings": {"type": "array", "items": REVIEW_ITEM},
        "nitpicks": {"type": "array", "items": REVIEW_ITEM},
        "pre_merge_checks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "status": {"type": "string", "enum": ["pass", "warn", "fail", "unknown"]},
                    "type": {"type": "string", "enum": ["Proof Gap", "Review Limitation", "Non-blocking Coverage"]},
                    "detail": {"type": "string"},
                },
                "required": ["name", "status", "detail"],
            },
        },
        "open_questions": STRING_LIST,
        "what_i_checked": STRING_LIST,
    },
    ["change_summary", "findings", "nitpicks", "pre_merge_checks", "open_questions", "what_i_checked"],
)
SUBMIT_VERDICTS = function_tool(
    "submit_verdicts",
    "Submit Dottore's verdict on each candidate finding. This ends the verification.",
    {
        "verdicts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "candidate": {"type": "integer"},
                    "verdict": {"type": "string", "enum": ["confirmed", "rejected", "uncertain"]},
                    "severity": {"type": "string", "enum": ["blocking", "high", "medium", "low"]},
                    "evidence": EVIDENCE,
                    "note": {"type": "string"},
                },
                "required": ["candidate", "verdict", "severity", "evidence", "note"],
            },
        },
    },
    ["verdicts"],
)
SCOUT_TOOL = function_tool(
    "scout",
    "Send a cheaper model to read the repository at the PR head and answer one self-contained question with "
    "quoted evidence. Put everything you need about the same code in one question; questions asked in the "
    "same turn run in parallel. Cite code as path:line and put code names in backticks: Dottore reads and "
    "searches those for the scout before it starts.",
    {
        "question": {
            "type": "string",
            "description": "Everything the scout needs on its own: the file, symbol or line, and exactly what to find out.",
        },
        "follow_up": {
            "type": "string",
            "description": "Optional: the id of an earlier scout, shown as 'Scout s3' on its report, to send this "
            "question to that scout, which keeps everything it read.",
        },
    },
    ["question"],
)
SUBMIT_REPORT = function_tool(
    "submit_report",
    "Submit the answer to the reviewer's question. This ends the scouting.",
    {
        "answer": {"type": "string", "description": "The facts that answer the question, without judging the change."},
        "evidence": EVIDENCE,
        "unresolved": {"type": "string", "description": "What the code did not settle, or empty."},
    },
    ["answer", "evidence", "unresolved"],
)
SCOUT_LOCATE_TOOL = function_tool(
    "scout",
    "Send a cheaper model to find the code at the PR head that settles one self-contained question; Dottore "
    "quotes each place it finds verbatim, the whole function where it is short. Put everything you need about "
    "the same code in one question; questions asked in the same turn run in parallel. Cite code as path:line "
    "and put code names in backticks: Dottore reads and searches those for the scout before it starts.",
    SCOUT_TOOL["function"]["parameters"]["properties"],
    ["question"],
)
SUBMIT_LOCATIONS = function_tool(
    "submit_locations",
    "Submit where the code that settles the reviewer's question is. Dottore quotes the whole function around "
    "each line verbatim for the reviewer. This ends the scouting.",
    {
        "locations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": PATH_PARAM,
                    "line": {"type": "integer", "description": "A line at the PR head inside the code that settles the question."},
                    "what": {
                        "type": "string",
                        "description": "A few words naming this code, such as the function and what it does with the "
                        "value asked about, without judging the change.",
                    },
                },
                "required": ["path", "line", "what"],
            },
        },
        "not_found": {
            "type": "string",
            "description": "What you searched for and did not find, such as no other callers, or empty.",
        },
    },
    ["locations", "not_found"],
)


def tool_path(path):
    """Normalize a model-supplied path; refuse anything outside the tree, in .git, or secret-looking."""
    normalized = posixpath.normpath(str(path or "").strip())
    if (
        normalized in {".", ".."}
        or normalized.startswith(("/", "../"))
        or ".git" in normalized.split("/")
        or SECRET_FILE_PART_RE.search(normalized)
    ):
        raise ValueError(f"path {path!r} is outside the reviewable repository")
    return normalized


def readable_text(path, text):
    if excluded_path(path):
        raise ValueError(f"{path} is generated or excluded by the review rules; read its source instead")
    if "\0" in text[:8_000]:
        raise ValueError(f"{path} is a binary file")
    return text


def head_file_text(path):
    full = _safe_path(tool_path(path))
    # Check the resolved path too, so a symlink cannot lead into .git or a secret file.
    relative = tool_path(full.relative_to(REPO_ROOT).as_posix())
    return readable_text(relative, full.read_text("utf-8", "replace"))


def head_line_exists(path, line):
    try:
        return line <= len(head_file_text(path).splitlines())
    except Exception:
        return False


def base_file_text(ctx, path):
    shown = run(["git", "show", f"{ctx.merge_base}:{tool_path(path)}"], timeout=60)
    if shown.returncode != 0:
        raise ValueError(f"{path} does not exist at the review base")
    return readable_text(tool_path(path), shown.stdout)


def numbered_lines(text, start=None, end=None, max_lines=MAX_TOOL_LINES, max_chars=MAX_TOOL_CHARS):
    lines = text.splitlines()
    first = max(1, int(start or 1))
    last = min(len(lines), int(end or first + max_lines - 1), first + max_lines - 1)
    if first > last:
        return f"No lines in that range; the file has {len(lines)} lines."
    body = "\n".join(f"{number}: {lines[number - 1]}" for number in range(first, last + 1))
    return truncate(body, max_chars)


def read_ranges(ranges):
    """Read several head-file ranges in one call; they share SCOUT_READ_LINES and SCOUT_READ_CHARS in order."""
    if not isinstance(ranges, list) or not ranges:
        raise ValueError("ranges must be a non-empty list of {path, start, end} objects")
    lines_left, chars_left, parts = SCOUT_READ_LINES, SCOUT_READ_CHARS, []
    for item in ranges[:MAX_READ_RANGES]:
        path = item.get("path") if isinstance(item, dict) else None
        if lines_left <= 0 or chars_left <= 0:
            body = "skipped: this call's line or character limit is used; read it in another call."
        else:
            try:
                body = numbered_lines(head_file_text(path), item.get("start"), item.get("end"), lines_left, chars_left)
                lines_left -= body.count("\n") + 1
            except Exception as exc:
                body = f"refused: {exc}"
        parts.append(f"## {path}\n{body}")
        chars_left -= len(parts[-1])
    if len(ranges) > MAX_READ_RANGES:
        parts.append(f"skipped {len(ranges) - MAX_READ_RANGES} ranges past the {MAX_READ_RANGES}-range limit.")
    return "\n\n".join(parts)


def search_context(hits):
    """Show the first search hits with a few lines either side, merging overlapping windows within a file."""
    found = [re.match(r"([^:]+):(\d+): ", hit) for hit in hits]
    if not all(found):
        return "\n".join(hits)
    windows = {}
    for match in found[:MAX_CONTEXT_HITS]:
        windows.setdefault(match[1], []).append(int(match[2]))
    parts = []
    for path, numbers in windows.items():
        try:
            text = head_file_text(path)
        except Exception:
            parts.append("\n".join(hit for hit in hits[:MAX_CONTEXT_HITS] if hit.startswith(f"{path}:")))
            continue
        spans = []
        for number in sorted(numbers):
            first, last = max(1, number - SEARCH_CONTEXT_LINES), number + SEARCH_CONTEXT_LINES
            if spans and first <= spans[-1][1] + 1:
                spans[-1][1] = last
            else:
                spans.append([first, last])
        shown = (numbered_lines(text, first, last, last - first + 1, MAX_TOOL_CHARS) for first, last in spans)
        parts.append(f"## {path}\n" + "\n...\n".join(shown))
    if hits[MAX_CONTEXT_HITS:]:
        parts.append("More hits:\n" + "\n".join(hits[MAX_CONTEXT_HITS:]))
    return truncate("\n\n".join(parts), SCOUT_READ_CHARS)


def searchable_hit(hit):
    try:
        tool_path(hit.split(":", 1)[0])
    except ValueError:
        return False
    return True


def run_tool(ctx, name, arguments, context=False):
    """Run one read-only tool call; every result is redacted and every failure becomes a refusal.

    With context, search shows lines around its first hits, as the scout's search tool promises."""
    try:
        args = json.loads(arguments or "{}")
        if not isinstance(args, dict):
            raise ValueError("arguments must be a JSON object")
        if name == "read_file":
            result = numbered_lines(head_file_text(args.get("path")), args.get("start"), args.get("end"))
        elif name == "read_files":
            result = read_ranges(args.get("ranges"))
        elif name == "base_version":
            result = numbered_lines(base_file_text(ctx, args.get("path")), args.get("start"), args.get("end"))
        elif name == "file_diff":
            path = tool_path(args.get("path"))
            if path not in ctx.files:
                raise ValueError(f"{path} is not a changed file; use read_file")
            result = truncate(diff_for_path(ctx.base, path), MAX_FILE_PATCH_CHARS)
        elif name == "search":
            hits = [hit for hit in search_repo(str(args.get("literal") or "")).splitlines() if searchable_hit(hit)]
            result = (search_context(hits) if context else "\n".join(hits)) if hits else "no matches"
        else:
            raise ValueError(f"unknown tool {name}")
    except Exception as exc:
        return f"refused: {exc}"
    return redact_for_model(result)


class StreamStalled(Exception):
    """The connection went quiet or dropped after the reply stream opened."""


class ResponseFailed(Exception):
    """The provider reported a failed response inside the stream, such as an unavailable or rate-limited upstream."""


def watched(stream, started, timing):
    """Yield a stream's events, noting when the first arrived and stopping one that runs too long."""
    for event in stream:
        elapsed = time.monotonic() - started
        timing.setdefault("first_chunk", elapsed)
        if elapsed > MODEL_STREAM_LIMIT:
            raise TimeoutError(f"the reply was still streaming after {MODEL_STREAM_LIMIT}s")
        yield event


def read_stream(stream, started, timing):
    """Assemble a streamed Chat Completions reply; return (message, usage)."""
    content, calls, usage = [], {}, None
    for chunk in watched(stream, started, timing):
        usage = getattr(chunk, "usage", None) or usage
        for choice in chunk.choices or []:
            delta = choice.delta
            content.append(delta.content or "")
            for part in delta.tool_calls or []:
                call = calls.setdefault(part.index, {"id": "", "name": "", "arguments": ""})
                call["id"] = call["id"] or part.id or ""
                if part.function:
                    call["name"] = call["name"] or part.function.name or ""
                    call["arguments"] += part.function.arguments or ""
    tool_calls = [
        SimpleNamespace(id=call["id"], function=SimpleNamespace(name=call["name"], arguments=call["arguments"]))
        for _, call in sorted(calls.items())
    ]
    return SimpleNamespace(content="".join(content) or None, tool_calls=tool_calls or None), usage


def openai_reply(ctx, settings, messages, tools, tool_choice, read_timeout, started, timing):
    import httpx
    import openai

    request = {
        "model": settings["model"],
        "messages": messages,
        "tools": tools,
        "tool_choice": tool_choice,
        "stream": True,
        "stream_options": {"include_usage": True},
        "timeout": openai.Timeout(read_timeout, connect=30),
    }
    if settings["effort"]:
        request["reasoning_effort"] = settings["effort"]
    if ctx.cache_key:
        # One key per review keeps its requests, which share long prefixes, on the same cache.
        request["extra_body"] = {"prompt_cache_key": ctx.cache_key}
    try:
        with role_client(ctx, "openai", settings).chat.completions.create(**request) as stream:
            return read_stream(stream, started, timing)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise StreamStalled(error_text(exc)) from exc


def claude_messages(messages):
    """Chat Completions messages as Claude's system blocks and turns, with cache breakpoints after the
    system prompt, on the first message (the packet both finders share) and on the newest block."""
    system, turns = [], []
    for message in messages:
        role, content = message["role"], message.get("content")
        if role == "system":
            system.append({"type": "text", "text": content})
            continue
        if role == "assistant":
            # Claude's own blocks go back unchanged: thinking must be returned with its signature.
            blocks = message.get("claude_blocks") or ([{"type": "text", "text": content}] if content else [])
        elif role == "tool":
            blocks = [{"type": "tool_result", "tool_use_id": message["tool_call_id"], "content": content}]
        else:
            blocks = [{"type": "text", "text": content}] if content else []
        speaker = "assistant" if role == "assistant" else "user"
        if not blocks:
            continue
        if turns and turns[-1]["role"] == speaker:
            turns[-1]["content"].extend(blocks)
        else:
            turns.append({"role": speaker, "content": list(blocks)})
    if system:
        system[-1] = {**system[-1], "cache_control": CACHE_BREAKPOINT}
    for blocks, index in ((turns[0]["content"], 0), (turns[-1]["content"], -1)) if turns else ():
        blocks[index] = {**blocks[index], "cache_control": CACHE_BREAKPOINT}
    return system, turns


def claude_reply(ctx, settings, messages, tools, tool_choice, read_timeout, started, timing):
    """One streamed Claude Messages call, returned in the Chat Completions shape the agents use."""
    import anthropic
    import httpx2

    system, turns = claude_messages(messages)
    request = {
        "model": settings["model"],
        "max_tokens": CLAUDE_MAX_TOKENS,
        "system": system,
        "messages": turns,
        "tools": [
            {
                "name": tool["function"]["name"],
                "description": tool["function"]["description"],
                "input_schema": tool["function"]["parameters"],
            }
            for tool in tools
        ],
        # Opus 5.5 and Sonnet 5.5 reject forced tool use, so the tool choice is always left to Claude;
        # once a budget is spent, run_agent refuses every tool but the submit tool.
        "tool_choice": {"type": "auto"},
        "timeout": anthropic.Timeout(read_timeout, connect=30),
    }
    if settings["effort"]:
        request["output_config"] = {"effort": settings["effort"]}
    try:
        with role_client(ctx, "anthropic", settings).messages.stream(**request) as stream:
            for _ in watched(stream, started, timing):
                pass
            reply = stream.get_final_message()
    except (httpx2.TimeoutException, httpx2.TransportError) as exc:
        raise StreamStalled(error_text(exc)) from exc
    if reply.stop_reason is None:
        # A connection that closes mid-reply ends the stream without an error or a stop reason.
        raise StreamStalled("the reply stream ended before Claude finished")
    blocks, text, calls = [], [], []
    for block in reply.content:
        if block.type == "tool_use":
            blocks.append({"type": "tool_use", "id": block.id, "name": block.name, "input": block.input})
            calls.append(
                SimpleNamespace(id=block.id, function=SimpleNamespace(name=block.name, arguments=json.dumps(block.input)))
            )
        elif block.type == "text":
            text.append(block.text)
            if block.text:
                blocks.append({"type": "text", "text": block.text})
        else:
            blocks.append(block.model_dump(exclude_none=True))
    cached = reply.usage.cache_read_input_tokens or 0
    prompt = reply.usage.input_tokens + (reply.usage.cache_creation_input_tokens or 0) + cached
    usage = {
        "prompt_tokens": prompt,
        "completion_tokens": reply.usage.output_tokens,
        "total_tokens": prompt + reply.usage.output_tokens,
        "prompt_tokens_details": {"cached_tokens": cached},
        "completion_tokens_details": {"reasoning_tokens": usage_value(reply.usage, "output_tokens_details", "thinking_tokens")},
    }
    message = SimpleNamespace(content="".join(text) or None, tool_calls=calls or None, claude_blocks=blocks)
    return message, usage


def responses_input(messages):
    """Chat Completions messages as Responses instructions and input items. An assistant turn's reasoning
    goes back before its calls, so the model keeps its train of thought between turns."""
    instructions, items = [], []
    for message in messages:
        role, content = message["role"], message.get("content")
        if role == "system":
            instructions.append(content)
        elif role == "tool":
            items.append({"type": "function_call_output", "call_id": message["tool_call_id"], "output": content})
        elif role == "assistant":
            items.extend(message.get("reasoning_items") or [])
            if content:
                items.append({"role": "assistant", "content": content})
            items.extend(
                {
                    "type": "function_call",
                    "call_id": call["id"],
                    "name": call["function"]["name"],
                    "arguments": call["function"]["arguments"],
                }
                for call in message.get("tool_calls") or []
            )
        elif content:
            items.append({"role": "user", "content": content})
    return "\n\n".join(instructions), items


def responses_reply(ctx, settings, messages, tools, tool_choice, read_timeout, started, timing):
    """One streamed Responses call, returned in the Chat Completions shape the agents use."""
    import httpx
    import openai

    instructions, items = responses_input(messages)
    request = {
        "model": settings["model"],
        "input": items,
        "tools": [{"type": "function", "strict": False, **tool["function"]} for tool in tools],
        "tool_choice": tool_choice if tool_choice == "auto" else {"type": "function", "name": tool_choice["function"]["name"]},
        # Nothing is kept on the provider; the encrypted reasoning comes back so the next turn can resend it.
        "store": False,
        "include": ["reasoning.encrypted_content"],
        "stream": True,
        "timeout": openai.Timeout(read_timeout, connect=30),
    }
    if instructions:
        request["instructions"] = instructions
    if settings["effort"]:
        request["reasoning"] = {"effort": settings["effort"]}
    if ctx.cache_key:
        request["extra_body"] = {"prompt_cache_key": ctx.cache_key}
    response = None
    try:
        with role_client(ctx, "openai", settings).responses.create(**request) as stream:
            for event in watched(stream, started, timing):
                if event.type in ("response.completed", "response.incomplete"):
                    response = event.response
                elif event.type in ("response.failed", "error"):
                    detail = getattr(getattr(event, "response", None), "error", None) or getattr(event, "message", "")
                    raise ResponseFailed(f"the response failed: {detail}")
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise StreamStalled(error_text(exc)) from exc
    if response is None:
        raise StreamStalled("the reply stream ended before the response completed")
    text, calls, reasoning = [], [], []
    for item in response.output or []:
        if item.type == "message":
            text += [part.text for part in item.content or [] if getattr(part, "type", "") == "output_text"]
        elif item.type == "function_call":
            calls.append(SimpleNamespace(id=item.call_id, function=SimpleNamespace(name=item.name, arguments=item.arguments)))
        elif item.type == "reasoning" and getattr(item, "encrypted_content", None):
            reasoning.append(item.model_dump(exclude_none=True))
    usage = response.usage
    prompt = usage_value(usage, "input_tokens")
    output = usage_value(usage, "output_tokens")
    usage = {
        "prompt_tokens": prompt,
        "completion_tokens": output,
        "total_tokens": prompt + output,
        "prompt_tokens_details": {"cached_tokens": usage_value(usage, "input_tokens_details", "cached_tokens")},
        "completion_tokens_details": {"reasoning_tokens": usage_value(usage, "output_tokens_details", "reasoning_tokens")},
    }
    message = SimpleNamespace(
        content="".join(text) or None,
        tool_calls=calls or None,
        reasoning_items=reasoning,
        # Encrypted reasoning serves only the model that wrote it; see own_reasoning.
        reasoning_model=settings["model"] if reasoning else None,
    )
    return message, usage


def transient_error(exc):
    """A gateway error worth retrying: unavailable, overloaded, rate limited, or a dropped connection.

    A gateway can report these inside the reply stream, as a bare APIError the client never retries.
    """
    if isinstance(exc, (StreamStalled, ResponseFailed)):
        return True
    import openai

    if isinstance(exc, openai.APIStatusError):
        return exc.status_code == 429 or exc.status_code >= 500
    return isinstance(exc, openai.APIError)


class CostLimitReached(Exception):
    """The review has spent its ceiling, so no further model call is made."""


def call_cost_usd(model, usage):
    rates = MODEL_PRICES_CNY.get(model) or max(MODEL_PRICES_CNY.values())
    prompt = usage_value(usage, "prompt_tokens")
    cached = usage_value(usage, "prompt_tokens_details", "cached_tokens")
    output = usage_value(usage, "completion_tokens")
    return ((prompt - cached) * rates[0] + cached * rates[1] + output * rates[2]) / 1e6 / CNY_PER_USD


def own_reasoning(messages, model):
    """The messages without the reasoning another model wrote, which only the model that wrote it can read."""
    return [
        message
        if message.get("reasoning_model", model) == model
        else {key: value for key, value in message.items() if key not in ("reasoning_items", "reasoning_model")}
        for message in messages
    ]


def reply_with_fallback(ctx, role, settings, messages, tools, tool_choice, read_timeout):
    """One model call. When it fails with a transient error and the model has a usable fallback, the same call
    goes to the fallback at once. Returns (message, usage, settings used, started, timing); when both fail, the
    original model's error is raised so the caller's retry schedule applies."""
    reply = {"anthropic": claude_reply, "responses": responses_reply}.get(settings["provider"], openai_reply)
    fallback = FALLBACK_MODELS.get(settings["model"])
    started = time.monotonic()
    timing = {}
    try:
        own = own_reasoning(messages, settings["model"])
        message, usage = reply(ctx, settings, own, tools, tool_choice, read_timeout, started, timing)
        return message, usage, settings, started, timing
    except Exception as exc:
        if not fallback or fallback in ctx.dead_fallbacks or not transient_error(exc):
            raise
        failure = exc
    print(
        f"Dottore call fallback: role={role}; from={settings['model']}; to={fallback}; {error_text(failure)}",
        flush=True,
    )
    alternate = {**settings, "model": fallback}
    started = time.monotonic()
    timing = {}
    try:
        own = own_reasoning(messages, fallback)
        message, usage = reply(ctx, alternate, own, tools, tool_choice, read_timeout, started, timing)
        return message, usage, alternate, started, timing
    except Exception as exc:
        if not transient_error(exc):
            with ctx.lock:
                ctx.dead_fallbacks.add(fallback)
        print(f"Dottore call fallback failed: role={role}; model={fallback}; {error_text(exc)}", flush=True)
    raise failure


def chat(ctx, role, messages, tools, tool_choice):
    if ctx.spent_usd >= REVIEW_COST_LIMIT_USD:
        raise CostLimitReached(
            f"the review has spent ${ctx.spent_usd:.3f}, past its ${REVIEW_COST_LIMIT_USD:.2f} ceiling, "
            "so it makes no more model calls"
        )
    settings = ctx.models[role]
    first_call = not any(message.get("role") == "assistant" for message in messages)
    read_timeout = FIRST_CALL_TIMEOUT if first_call else MODEL_REQUEST_TIMEOUT
    # The client retries a request that fails before its stream opens. This retries one that stalls after
    # it at once, at most MODEL_MAX_RETRIES times since each stall has already used a read timeout, and
    # waits out a transient gateway error, which can arrive mid-stream with a request to resend.
    stalls = 0
    delays = SCOUT_RETRY_DELAYS if role == "scout" else RETRY_DELAYS
    for attempt in range(len(delays) + 1):
        started = time.monotonic()
        try:
            message, usage, used, started, timing = reply_with_fallback(
                ctx, role, settings, messages, tools, tool_choice, read_timeout
            )
            break
        except Exception as exc:
            stalled = isinstance(exc, StreamStalled)
            stalls += stalled
            retry = stalls <= MODEL_MAX_RETRIES if stalled else transient_error(exc)
            if not retry or attempt == len(delays):
                raise
            wait = 0 if stalled else delays[attempt]
            print(
                f"Dottore call retry: role={role}; attempt={attempt + 1}; after_s={time.monotonic() - started:.1f}; "
                f"wait_s={wait}; {error_text(exc)}",
                flush=True,
            )
            time.sleep(wait)
    with ctx.lock:
        totals = ctx.stats["roles"][role]
        totals["model"] = settings["model"]
        totals["model_calls"] += 1
        totals["fallbacks"] += used is not settings
        add_usage(totals, usage)
        ctx.spent_usd += call_cost_usd(used["model"], usage)
    # request_chars lets the provider's token counts be compared with what was actually sent.
    print(
        f"Dottore call: role={role}; messages={len(messages)}; "
        f"request_chars={len(json.dumps([messages, tools], ensure_ascii=False))}; "
        f"prompt_tokens={usage_value(usage, 'prompt_tokens')}; "
        f"cached_tokens={usage_value(usage, 'prompt_tokens_details', 'cached_tokens')}; "
        f"completion_tokens={usage_value(usage, 'completion_tokens')}; "
        f"reasoning_tokens={usage_value(usage, 'completion_tokens_details', 'reasoning_tokens')}; "
        f"first_chunk_s={timing.get('first_chunk', 0):.1f}; elapsed_s={time.monotonic() - started:.1f}; "
        f"review_spent_usd={ctx.spent_usd:.3f}"
        + (f"; fallback_model={used['model']}" if used is not settings else ""),
        flush=True,
    )
    return message


def assistant_turn(message, **fields):
    """The assistant message to keep in history, with Claude's original blocks or the Responses reasoning
    when the provider sent them."""
    kept = {key: getattr(message, key, None) for key in ("claude_blocks", "reasoning_items", "reasoning_model")}
    return {"role": "assistant", **fields, **{key: value for key, value in kept.items() if value}}


def tool_call_key(call):
    try:
        args = json.dumps(json.loads(call.function.arguments or "{}"), sort_keys=True)
    except ValueError:
        args = call.function.arguments
    return call.function.name, args


def run_agent(
    ctx, role, messages, submit_tool, budget, output_budget, deadline=None, reads=None, turns=None, transcript=None
):
    """Let one agent read with the tools until it calls its submit tool; return the submitted arguments.

    The budget counts tool calls, turns the turns that may call them (the budget by default), and
    output_budget their characters; a repeated call is answered from the earlier result for free. Once
    any is spent, or the deadline (the review's by default) has passed, the model is made to call the
    submit tool, and a few malformed submissions are tolerated. Given reads, the agent also gets the scout
    tool and at most that many direct reads. The scout reads with batched tools. The role's stats record
    which limit, if any, ended the run. Given transcript, a list, it is filled with the conversation up to and
    including the submitting turn.
    """
    submit = submit_tool["function"]["name"]
    scouting = reads is not None
    scout_tool = SCOUT_LOCATE_TOOL if SCOUT_LOCATES else SCOUT_TOOL
    tools = [*(SCOUT_READ_TOOLS if role == "scout" else READ_TOOLS), *([scout_tool] if scouting else []), submit_tool]
    messages = list(messages)
    used = 0
    read = 0
    spent = 0
    answered = {}
    deadline = deadline or ctx.deadline
    turns = min(turns or budget, budget)
    for turn in range(turns + MAX_SUBMIT_ATTEMPTS):
        limits = [
            name
            for name, hit in (
                ("calls", used >= budget),
                ("turns", turn >= turns),
                ("chars", spent >= output_budget),
                ("time", time.monotonic() > deadline),
            )
            if hit
        ]
        forced = bool(limits)
        choice = {"type": "function", "function": {"name": submit}} if forced else "auto"
        message = chat(ctx, role, messages, tools, choice)
        calls = list(message.tool_calls or [])
        if not calls:
            messages += [
                assistant_turn(message, content=message.content or ""),
                {"role": "user", "content": f"Call {submit} to finish."},
            ]
            continue
        messages.append(
            assistant_turn(
                message,
                content=message.content,
                tool_calls=[
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {"name": call.function.name, "arguments": call.function.arguments},
                    }
                    for call in calls
                ],
            )
        )
        replies = {}
        outputs = set()
        questions = []
        for call in calls:
            key = tool_call_key(call)
            if call.function.name == submit:
                try:
                    submitted = json.loads(call.function.arguments or "{}")
                except ValueError:
                    submitted = None
                if isinstance(submitted, dict):
                    with ctx.lock:
                        ctx.stats["roles"][role][f"stop_{limits[0] if limits else 'own'}"] += 1
                    if transcript is not None:
                        transcript[:] = messages
                    return submitted
                replies[call.id] = f"refused: {submit} needs one JSON object as its arguments; call it again."
                continue
            if key in answered:
                replies[call.id] = f"Already returned above as tool call {answered[key]}; reuse that result."
                continue
            if forced or used >= budget or spent >= output_budget:
                replies[call.id] = f"refused: the tool budget is spent; call {submit} now."
                continue
            if scouting and call.function.name == "scout":
                questions.append(call)
            elif scouting and read >= reads:
                replies[call.id] = "refused: your direct reads are spent; ask the scout."
                continue
            else:
                read += 1
                replies[call.id] = run_tool(ctx, call.function.name, call.function.arguments, role == "scout")
            used += 1
            answered[key] = used
            outputs.add(call.id)
        if questions:
            with ThreadPoolExecutor(max_workers=min(SCOUT_CONCURRENCY, len(questions))) as scouts:
                results = list(scouts.map(lambda call: run_scout(ctx, call.function.arguments, deadline), questions))
            for call, (report, ok) in zip(questions, results):
                replies[call.id] = report
                if not ok:
                    # A failed scout may be asked the same question again.
                    answered.pop(tool_call_key(call), None)
            if ctx.scout_streak >= SCOUT_OUTAGE_FAILURES:
                raise RuntimeError(
                    f"the scout model failed {ctx.scout_streak} questions in a row, so the lab review stopped "
                    "before the finders spent more without it"
                )
        asked = {call.id for call in questions}
        for call in calls:
            reply = replies[call.id]
            if call.id in outputs:
                reply = truncate(reply, output_budget - spent)
                spent += len(reply)
                with ctx.lock:
                    totals = ctx.stats["roles"][role]
                    totals["scout_asks" if call.id in asked else "tool_calls"] += 1
                    totals["tool_chars"] += len(reply)
            messages.append({"role": "tool", "tool_call_id": call.id, "content": reply})
    raise RuntimeError(f"The {role} agent never called {submit}.")


SCOUT_SYSTEM = (
    "You scout code for a pull request reviewer. The reviewer has the diff and sends you one question about "
    "code it has not read. Answer it from the repository at the PR head with the read-only tools. The question "
    "may come with leads: the lines it cites and searches for the names it mentions, already run for you, so "
    "start from them and do not repeat them. The reviewer may later send a follow-up; answer it the same way, "
    "reusing what you have already read. For each question you have "
    f"{SCOUT_TURNS} turns of tool calls before you must report, and every turn resends everything read so "
    "far, so plan first and fetch in as few turns as possible: make every search you need in one turn (each "
    "shows a few lines around its first hits), then one read_files call with every range that decides the "
    "answer, whole functions rather than slices. Use file_diff or base_version for a changed file's diff or "
    "its text before the change. Stop reading once the question is answered. Report facts, not opinions on "
    "whether the change is correct; the reviewer judges that. Quote evidence verbatim with its path and line "
    "number, the exact lines that settle each fact, so the reviewer can rely on it without rereading. When "
    "the code does not settle something, say so in unresolved instead of guessing. Finish by calling "
    "submit_report."
)
SCOUT_LOCATE_SYSTEM = (
    "You find code for a pull request reviewer. The reviewer has the diff and sends you one question about "
    "code it has not read. Find the code at the PR head that settles it with the read-only tools, then submit "
    f"where it is: up to {MAX_LOCATIONS} lines, one inside each function or block that settles the question, "
    "such as each caller or each writer it asks about. Dottore quotes the whole function around each line "
    "verbatim for the reviewer, who reads the code and judges the change, so do not explain the code or judge "
    "the change. The question may come with leads: the lines it cites and searches for the names it mentions, "
    "already run for you, so start from them and do not repeat them. The reviewer may later send a follow-up; "
    f"answer it the same way, reusing what you have already read. For each question you have {SCOUT_TURNS} "
    "turns of tool calls before you must submit, and every turn resends everything read so far, so plan first "
    "and fetch in as few turns as possible: make every search you need in one turn (each shows a few lines "
    "around its first hits), then read only what you need to be sure the lines are the right ones. Locations "
    "are lines at the PR head; use file_diff or base_version only to find them. Say in not_found what you "
    "searched for and did not find. Finish by calling submit_locations."
)


def scout_leads(ctx, question):
    """The scout's first step, done in code: read the path:line references and search the backticked names."""
    ranges, seen = [], set()
    for path, start, end in LEAD_REF_RE.findall(question):
        try:
            path = tool_path(path)
        except ValueError:
            continue
        if not (REPO_ROOT / path).is_file():
            # Models often cite a changed file by its name alone.
            matches = [changed for changed in ctx.files if changed.endswith(f"/{path}")]
            if len(matches) != 1:
                continue
            path = matches[0]
        start, end = int(start), int(end or start)
        if (path, start) in seen:
            continue
        seen.add((path, start))
        ranges.append(
            {"path": path, "start": max(1, start - LEAD_LINES_BEFORE), "end": max(start, end) + LEAD_LINES_AFTER}
        )
        if len(ranges) == MAX_LEAD_REFS:
            break
    parts = [f"## Cited lines\n{run_tool(ctx, 'read_files', json.dumps({'ranges': ranges}))}"] if ranges else []
    names = []
    # Splitting on backticks pairs them; the odd parts are the code spans.
    for span in question.split("`")[1::2]:
        name = LEAD_NAME_RE.match(span.strip())
        if "/" in span or "\n" in span or LEAD_PATH_RE.fullmatch(span.strip()) or not name:
            continue
        name = name.group(0)
        if len(name) >= 3 and name not in NOT_NAMES and name not in names:
            names.append(name)
    for name in names[:MAX_LEAD_NAMES]:
        parts.append(f"## search {name}\n{run_tool(ctx, 'search', json.dumps({'literal': name}), True)}")
    return truncate("\n\n".join(parts), MAX_LEAD_CHARS)


def closed_transcript(transcript, submit):
    """A finished scout conversation with every call of its last turn answered, ready for a follow-up."""
    last = transcript[-1] if transcript else {}
    replies = [
        {
            "role": "tool",
            "tool_call_id": call["id"],
            "content": "Report delivered."
            if call["function"]["name"] == submit
            else "Not run: the report was already submitted.",
        }
        for call in last.get("tool_calls") or []
    ]
    return [*transcript, *replies]


def scout_report(ctx, submitted, scout_id):
    """Format a scout's submission for the finder, flagging quotes that are not at their cited lines."""
    lines = [f"Scout {scout_id}", f"Answer: {submitted.get('answer') or 'none'}"]
    for item in as_list(submitted.get("evidence")):
        if not isinstance(item, dict):
            continue
        flag = "" if evidence_grounded(ctx, [item], whole=True) else " (not found at this line; unconfirmed)"
        snippet = "\n".join(f"    {line}" for line in str(item.get("snippet") or "").splitlines())
        lines.append(f"- {item.get('path')}:{item.get('line')}{flag}\n{snippet}")
    if str(submitted.get("unresolved") or "").strip():
        lines.append(f"Unresolved: {submitted['unresolved']}")
    return truncate(redact_for_model("\n".join(lines)), MAX_SCOUT_REPORT_CHARS)


def located_report(submitted, scout_id):
    """Quote each place a locating scout found from the PR head: the named block around the line in full when it
    is short, else the lines around it. Overlapping places merge; the scout's words supply only the headings."""
    found, skipped = {}, []
    for item in as_list(submitted.get("locations"))[:MAX_LOCATIONS]:
        if not isinstance(item, dict):
            continue
        try:
            path = tool_path(item.get("path"))
            lines = head_file_text(path).splitlines()
            number = int(item.get("line"))
            if not 1 <= number <= len(lines):
                raise ValueError(f"line {number} is not in the file")
        except Exception as exc:
            skipped.append(f"{item.get('path')}:{item.get('line')} ({error_text(exc)})")
            continue
        low, high = max(1, number - LOCATED_WINDOW), min(len(lines), number + LOCATED_WINDOW)
        block = enclosing_block(lines, number)
        if block:
            end = statement_end(lines, block[1], LOCATED_BLOCK_LINES + 1)
            if number <= end < block[1] + LOCATED_BLOCK_LINES:
                low, high = block[1], end
        what = " ".join(str(item.get("what") or "").split())[:200]
        found.setdefault(path, (lines, []))[1].append((low, high, what))
    parts = [f"Scout {scout_id}: the code it found, quoted verbatim by Dottore from the PR head"]
    for path, (lines, ranges) in found.items():
        merged = []
        for low, high, what in sorted(ranges):
            if merged and low <= merged[-1][1] + 1:
                merged[-1] = (merged[-1][0], max(high, merged[-1][1]), f"{merged[-1][2]}; {what}")
            else:
                merged.append((low, high, what))
        for low, high, what in merged:
            body = "\n".join(f"{number}: {lines[number - 1]}" for number in range(low, high + 1))
            parts.append(f"## {path}:{low}-{high} ({what})\n```text\n{body}\n```")
    if not found:
        parts.append("No code found.")
    if str(submitted.get("not_found") or "").strip():
        parts.append(f"Searched and not found: {submitted['not_found']}")
    if skipped:
        parts.append(f"Skipped invalid locations: {', '.join(skipped)}")
    return truncate(redact_for_model("\n\n".join(parts)), MAX_LOCATED_CHARS)


def run_scout(ctx, arguments, deadline):
    """Answer one finder question with the scout model, retrying a failed run while time remains.

    Returns the report and whether the scout succeeded."""
    try:
        args = json.loads(arguments or "{}")
        question = str(args.get("question") or "").strip()
        follow_up = str(args.get("follow_up") or "").strip()
    except (ValueError, AttributeError):
        question = follow_up = ""
    if not question:
        return "refused: scout needs one non-empty question string.", False
    if ctx.scout_streak >= SCOUT_OUTAGE_FAILURES:
        return "scout failed (the scout model is down).", False
    with ctx.lock:
        earlier = ctx.scout_sessions.get(follow_up)
        if earlier:
            scout_id = follow_up
            ctx.stats["roles"]["scout"]["follow_ups"] += 1
        else:
            # An unknown id is answered by a fresh scout, whose report names its own id.
            ctx.scout_count += 1
            scout_id = f"s{ctx.scout_count}"
    if earlier:
        leads = ""
        messages = [*earlier, {"role": "user", "content": f"# Follow-up question\n{question}"}]
    else:
        leads = scout_leads(ctx, question)
        messages = [
            {"role": "system", "content": SCOUT_LOCATE_SYSTEM if SCOUT_LOCATES else SCOUT_SYSTEM},
            {
                "role": "user",
                "content": f"# Changed files\n{chr(10).join(sorted(ctx.files))}\n\n# Question\n{question}"
                + (f"\n\n# Leads\n{leads}" if leads else ""),
            },
        ]
    error = ""
    for attempt in range(SCOUT_ATTEMPTS):
        if attempt:
            if time.monotonic() > deadline:
                break
            with ctx.lock:
                ctx.stats["roles"]["scout"]["retries"] += 1
        try:
            with ctx.scouts:
                started = time.monotonic()
                transcript = []
                submitted = run_agent(
                    ctx,
                    "scout",
                    messages,
                    SUBMIT_LOCATIONS if SCOUT_LOCATES else SUBMIT_REPORT,
                    SCOUT_TOOL_BUDGET,
                    SCOUT_TOOL_CHARS,
                    min(deadline, started + SCOUT_DEADLINE_SECONDS),
                    turns=SCOUT_TURNS,
                    transcript=transcript,
                )
        except CostLimitReached:
            raise
        except Exception as exc:
            error = error_text(exc)
            print(f"Dottore scout failed: attempt={attempt + 1}; {error}", flush=True)
            continue
        report = located_report(submitted, scout_id) if SCOUT_LOCATES else scout_report(ctx, submitted, scout_id)
        print(
            f"Dottore scout: id={scout_id}; follow_up={'yes' if earlier else 'no'}; attempt={attempt + 1}; "
            f"question_chars={len(question)}; leads_chars={len(leads)}; report_chars={len(report)}; "
            f"evidence={len(as_list(submitted.get('locations' if SCOUT_LOCATES else 'evidence')))}; unconfirmed={report.count('; unconfirmed)')}; "
            f"elapsed_s={time.monotonic() - started:.1f}; "
            f"question={json.dumps(' '.join(redact_for_model(question).split())[:200])}",
            flush=True,
        )
        with ctx.lock:
            ctx.scout_streak = 0
            ctx.scout_sessions[scout_id] = closed_transcript(
                transcript, (SUBMIT_LOCATIONS if SCOUT_LOCATES else SUBMIT_REPORT)["function"]["name"]
            )
        return report, True
    with ctx.lock:
        ctx.stats["roles"]["scout"]["failures"] += 1
        ctx.scout_streak += 1
    return f"scout failed ({error or 'out of time'}); ask it again or narrow the question.", False


FINDER_FOCUS = {
    "finder": (
        "Act as the only finder for this packet, doing both the broad and the skeptical segment's work. "
        "Broadly, search for correctness, contracts, failure paths, tests, security/privacy, CI/deployment "
        "risks, architecture, and user-visible regressions, and record up to 2 concrete nitpicks when changed "
        "lines carry optional but actionable polish. Skeptically, look for invariant mismatches introduced by "
        "the diff: data collected in a pre-scan but persisted after later filters, parent metadata derived "
        "from rows that are not imported as children, fallback behavior that diverges from validation, "
        "rollback paths, partial writes, contract drift, and tests that prove only the happy path."
    ),
    "broad": (
        "Act as the broad segment. Search widely for correctness, contracts, failure paths, tests, "
        "security/privacy, CI/deployment risks, architecture, and user-visible regressions, and record "
        "up to 2 concrete nitpicks when changed lines carry optional but actionable polish."
    ),
    "skeptic": (
        "Act as the skeptical segment, independently of the broad segment. Focus on invariant mismatches "
        "introduced by the diff: data collected in a pre-scan but persisted after later filters, parent "
        "metadata derived from rows that are not imported as children, fallback behavior that diverges "
        "from validation, rollback paths, partial writes, contract drift, and tests that prove only the "
        "happy path. Leave nitpicks to the broad segment."
    ),
}


def finder_packet(review_target, focus_note, prior_contracts, review_packet):
    # Shared by both segments and placed before their instructions, so providers can cache it.
    return (
        f"{review_target} {focus_note}"
        f"\n\n# Prior Dottore Repair Contracts\n{prior_contracts}"
        f"\n\n# Review Packet\n{review_packet}"
    )


FINDING_RULES = (
    "Dottore verifies every candidate against the code before anything is published, so report each "
    "concrete suspicion once and do not pad. If prior Dottore contracts are included, first judge whether "
    "the current diff satisfies or leaves those contracts incomplete before issuing adjacent related "
    "findings. Point each finding at the added/changed RIGHT line or deleted LEFT line that causes it; only "
    "when the defect itself sits on an unchanged line of a changed file, cite that line, and Dottore reports "
    "it outside the diff. Report one finding per line, combining related concerns. Dottore never runs "
    "commands, tests or builds and CI does, so do not report unexecuted checks as a limitation. Record what "
    "you checked in what_i_checked, and name any limitation there instead of inventing certainty."
)


# ponytail: lab hypothesis that finders read the changed lines but skip edge inputs and failure paths;
# keep it only if a multi-run recall test shows it surfaces those bugs.
EDGE_INPUT_PASS = (
    "Before you ask, walk every changed line that converts or defaults a value, migrates or carries "
    "over stored settings, trims or caps to a budget, or awaits a call through these inputs: zero, empty "
    "or missing; a string where a number is expected; a legacy, inactive or disabled item; an input at or "
    "past the limit; and an await that rejects. Decide what the code then does. When the answer depends on "
    "a helper or definition outside the packet, that open question is a concrete suspicion: settle it."
)


TRACER_CHECKS_PASS = (
    "Settle every tracer check about your focus files: report it as a finding when the code shows a problem, "
    "and otherwise say in what_i_checked why it holds."
)


SCOUT_REPORT_NOTE = "a cheaper model that reads the repository for you and returns quoted evidence."
SCOUT_LOCATE_NOTE = (
    "a cheaper model that finds the code that settles your question; Dottore quotes back each place it found "
    "verbatim, the whole function where it is short, so you read the code itself and judge it."
)


def finder_instructions(role):
    if not FINDER_SCOUTS:
        return (
            f"{FINDER_FOCUS[role]} Treat the review packet as the specimen. Use the read-only tools only to "
            "settle a concrete suspicion that depends on code outside the packet, fetching just what it needs; "
            "do not browse, and when the packet is enough, submit without any tool calls. You have at most "
            f"{FINDER_TOOL_BUDGET} tool calls and {FINDER_TOOL_CHARS} characters of tool output, and repeating a "
            f"call returns nothing new. {EDGE_INPUT_PASS} {TRACER_CHECKS_PASS} Guidance is listed by heading in "
            f"the selected guidance index; read only the sections that bear on a suspicion. {FINDING_RULES} "
            "Finish by calling submit_findings."
        )
    return (
        f"{FINDER_FOCUS[role]} Treat the review packet as the specimen. When a concrete suspicion depends on "
        f"code outside the packet, ask the scout, {SCOUT_LOCATE_NOTE if SCOUT_LOCATES else SCOUT_REPORT_NOTE} "
        f"You have {FINDER_TURNS} turns of tool calls and then must submit: ask every question "
        "you need in the first turn, together so they run in parallel, and use the second only for follow-ups "
        "on answers that leave a suspicion open and for questions whose scout failed. Send a follow-up to the "
        "scout that gave the answer by passing its id as follow_up; it keeps what it read. Make each question "
        "self-contained (the file, symbol or line, and exactly what to find out) and put everything you need "
        "about the same code into one question rather than several small ones. Ask only to settle suspicions, "
        "not for tours of the code, and when the packet is enough, submit without any tool calls. "
        f"Keep direct reads for checking an exact line or guidance section yourself; you have {FINDER_READ_BUDGET}. "
        f"Repeating a call returns nothing new. {EDGE_INPUT_PASS} {TRACER_CHECKS_PASS} Guidance is listed "
        "by heading in the selected guidance index; read only the sections that bear on a suspicion. "
        f"{FINDING_RULES} Finish by calling submit_findings."
    )


def staggered(delay, function, *args):
    time.sleep(delay)
    return function(*args)


def run_finders(ctx, packets, pool):
    """Stage 1: run the broad and skeptical segments over every packet concurrently.

    The time box starts with the finders, and a finder that fails leaves a review limitation instead of
    failing the review, unless every finder fails."""
    deadline = min(ctx.deadline, time.monotonic() + FINDER_DEADLINE_SECONDS)
    jobs = [
        (
            role,
            pool.submit(
                staggered,
                FINDER_STAGGER_SECONDS * FINDER_ROLES.index(role),
                run_agent,
                ctx,
                role,
                [
                    {"role": "system", "content": ctx.skill},
                    {"role": "user", "content": packet},
                    {"role": "user", "content": finder_instructions(role)},
                ],
                SUBMIT_FINDINGS,
                FINDER_TOOL_BUDGET,
                FINDER_TOOL_CHARS,
                deadline,
                FINDER_READ_BUDGET if FINDER_SCOUTS else None,
                FINDER_TURNS if FINDER_SCOUTS else None,
            ),
        )
        for packet in packets
        for role in FINDER_ROLES
    ]
    reports, errors = [], []
    for role, future in jobs:
        try:
            reports.append((role, future.result()))
        except Exception as exc:
            print(f"Dottore finder failed: role={role}; {error_text(exc)}", flush=True)
            errors.append(exc)
            check = {
                "name": f"{SEGMENT_LABELS[role]} Coverage",
                "status": "warn",
                "type": "Review Limitation",
                "detail": f"The {role} finder failed ({error_text(exc)}), so its candidates are missing from this review.",
            }
            reports.append((role, {"pre_merge_checks": [check]}))
    if len(errors) == len(jobs):
        raise errors[0]
    return reports


# ponytail: line-based declaration patterns, not a parser. An unnamed callback or an unusual signature
# yields no seed, and the tracer still has the diff and its tools; move to tree-sitter if seeds miss.
NAMED_BLOCK_RES = (
    re.compile(r"\b(?:function\*?|class|def)\s+([A-Za-z_$][\w$]*)"),
    re.compile(
        r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|"
        r"(?:React\.)?use(?:Callback|Memo)\(|(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=>|\([^()]*$)"
    ),
    # Object-literal and class methods; their callers reach them through an object, so search the repo.
    re.compile(r"^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::[^=]+?)?=>)"),
    re.compile(
        r"^\s*(?:(?:export|default|public|private|protected|static|async|readonly|override|get|set)\s+)*"
        r"\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\((?!.*\bfunction\b)[^=]*\)\s*(?::[^{=]+)?\{\s*$"
    ),
)
DECLARED_RE = re.compile(
    r"\b(?:const|let|var|function\*?|class|def)\s+([A-Za-z_$][\w$]*)"
    r"|^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)"
)
TEST_PATH_RE = re.compile(r"(^|/)(tests?|e2e|__tests__|regressions?)/|\.(test|spec|regression|e2e)\.")
NOT_NAMES = {"if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "with", "new", "constructor"}


def enclosing_block(lines, number, limit=None):
    """The named function, method or class whose declaration encloses a line, by indentation: (name, line, kind, text).

    With limit, only a declaration indented less than limit counts, which finds the block around a declaration.
    """
    for index in range(number - 1, -1, -1):
        text = lines[index]
        stripped = text.strip()
        depth = len(text) - len(text.lstrip())
        if not stripped or (limit is not None and depth >= limit):
            continue
        for kind, pattern in enumerate(NAMED_BLOCK_RES):
            match = pattern.search(text)
            if match and match.group(1) not in NOT_NAMES:
                return match.group(1), index + 1, kind, text
        # A closing bracket ends a multi-line signature, so the declaration can still be above at this depth.
        if not stripped.startswith((")", "]", "}")):
            limit = depth
    return None


def private_name(path, kind, declaration):
    """True when only its own file can use a name: an unexported JS/TS function or const. Methods and
    Python names are reached from other files, so those are searched across the repository."""
    return kind < 2 and "export" not in declaration and not path.endswith(".py")


def name_uses(path, name, local, touched):
    """Whole-word uses of a name outside the diff: in its own file when local, otherwise across the repository."""
    if local:
        pattern = re.compile(rf"(?<![\w$]){re.escape(name)}(?![\w$])")
        hits = [
            f"{path}:{number}: {line.strip()[:220]}"
            for number, line in enumerate(head_file_text(path).splitlines(), 1)
            if pattern.search(line) and len(line) <= MAX_SEARCH_LINE_CHARS
        ]
    else:
        found = search_repo(name, code=True)
        hits = [] if found == "no matches" or found.startswith("refused:") else found.splitlines()
    outside = []
    for hit in hits:
        hit_path, line_no, _ = hit.split(":", 2)
        if line_no.isdigit() and int(line_no) in touched.get(hit_path, {}).get("RIGHT", ()):
            continue
        outside.append(hit)
    return outside[:MAX_SEED_HITS_PER_NAME]


def trace_seeds(touched):
    """Where each changed function and each name declared on a changed line is used outside the diff."""
    blocks = {}
    declared = {}
    for path, sides in sorted(touched.items()):
        if not path.endswith(CODE_SUFFIXES) or not sides["RIGHT"]:
            continue
        try:
            lines = head_file_text(path).splitlines()
        except Exception:
            continue
        for number in sorted(sides["RIGHT"]):
            if number > len(lines):
                continue
            text = lines[number - 1]
            # Only module-level names: a local's uses sit in its enclosing block, and a file-wide search
            # for a short local name such as `start` mostly finds unrelated variables.
            if not text[:1].isspace() and not text.startswith(("//", "*", "/*", "#")):
                for match in DECLARED_RE.finditer(text):
                    declared.setdefault((path, match.group(1) or match.group(2)), (number, private_name(path, 0, text)))
            block = enclosing_block(lines, number)
            if block:
                name, line, kind, decl = block
                blocks.setdefault((path, name), (line, private_name(path, kind, decl)))
    seeds = [(key, value, "changed lines inside it") for key, value in blocks.items()]
    seeds += [(key, value, "declared on a changed line") for key, value in declared.items() if key not in blocks]
    # Production code first, so the seed limit trims tests.
    seeds.sort(key=lambda seed: bool(TEST_PATH_RE.search(seed[0][0])))
    sections = []
    sites = []
    for (path, name), (line, local), why in seeds[:MAX_TRACE_SEEDS]:
        uses = [hit for hit in name_uses(path, name, local, touched) if not hit.startswith(f"{path}:{line}:")]
        sites += [(hit_path, int(line_no)) for hit_path, line_no, _ in (hit.split(":", 2) for hit in uses) if line_no.isdigit()]
        scope = "uses in this file" if local else "uses in the repository"
        sections.append(
            f"### {name} ({why}; declared at {path}:{line}; {scope})\n"
            + ("\n".join(uses) or "Every use is inside the diff.")
        )
    return truncate("\n\n".join(sections), MAX_SEED_CHARS), len(seeds), sites


CALL_NAME_RE = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(")


def changed_code(touched):
    """The changed code and what surrounds it, quoted from the PR head: each changed line with CHANGED_CODE_WINDOW
    lines either side, the named block around it in full when that block is short, and the same-file functions
    the changed lines call. Production files come first, so the limit trims tests."""
    sections = []
    for path, sides in sorted(touched.items(), key=lambda item: (bool(TEST_PATH_RE.search(item[0])), item[0])):
        if not path.endswith(CODE_SUFFIXES) or not sides["RIGHT"]:
            continue
        try:
            lines = head_file_text(path).splitlines()
        except Exception:
            continue
        changed = sorted(number for number in sides["RIGHT"] if number <= len(lines))
        ranges = []
        for number in changed:
            ranges.append((max(1, number - CHANGED_CODE_WINDOW), min(len(lines), number + CHANGED_CODE_WINDOW)))
            block = enclosing_block(lines, number)
            if block:
                end = statement_end(lines, block[1], MAX_CHANGED_BLOCK_LINES + 1)
                if number <= end < block[1] + MAX_CHANGED_BLOCK_LINES:
                    ranges.append((block[1], end))
        declared = {}
        for number, text in enumerate(lines, 1):
            for pattern in NAMED_BLOCK_RES:
                match = pattern.search(text)
                if match and match.group(1) not in NOT_NAMES:
                    declared.setdefault(match.group(1), number)
                    break
        called = {match.group(1) for number in changed for match in CALL_NAME_RE.finditer(lines[number - 1])}
        for name in sorted(called & declared.keys()):
            start = declared[name]
            if not any(low <= start <= high for low, high in ranges):
                ranges.append((start, statement_end(lines, start, MAX_CALLEE_LINES)))
        merged = []
        for low, high in sorted(ranges):
            if merged and low <= merged[-1][1] + 1:
                merged[-1] = (merged[-1][0], max(high, merged[-1][1]))
            else:
                merged.append((low, high))
        for low, high in merged:
            body = "\n".join(f"{number}: {lines[number - 1]}" for number in range(low, high + 1))
            sections.append(f"## {path}:{low}-{high}\n```text\n{redact_for_model(body)}\n```")
    return truncate("\n\n".join(sections), MAX_CHANGED_CODE_CHARS)


# ponytail: simple `const|let|var name =` declarations only, scoped to the nearest earlier one at the same or
# lower indentation that sits at module level or in a named function enclosing the reader. Destructuring and
# shadowing in an unnamed sibling block are missed or misread; a language server would resolve them properly.
VALUE_DECL_RE = re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?![=>])")
READ_NAME_RE = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]{2,})")


def statement_end(lines, start, limit=MAX_DEFINITION_LINES):
    """The last line of the statement starting at a 1-based line, by bracket balance, within limit lines."""
    last = min(len(lines), start + limit - 1)
    depth = 0
    for number in range(start, last + 1):
        text = lines[number - 1]
        depth += sum(text.count(char) for char in "([{") - sum(text.count(char) for char in ")]}")
        if depth <= 0:
            return number
    return last


def enclosing_chain(lines, number):
    """Declaration lines of every named block enclosing a line, innermost first."""
    chain = []
    block = enclosing_block(lines, number)
    while block:
        chain.append(block[1])
        depth = len(block[3]) - len(block[3].lstrip())
        block = enclosing_block(lines, block[1] - 1, limit=depth) if depth and block[1] > 1 else None
    return chain


def value_definitions(touched, sites):
    """Quote where each local value read at the change is defined, then where that definition's inputs are.

    The change is read on its changed lines and at the call sites of changed functions, where a condition
    often continues on the next lines. A bug there can sit in how a value it combines with was built, such
    as a set filtered for a whole audience, which the diff names but does not show.
    """
    readers = {}
    for path, sides in touched.items():
        readers.setdefault(path, []).extend(sorted(sides["RIGHT"]))
    for path, line in sites:
        readers.setdefault(path, []).extend(range(line, line + SITE_LINES_AFTER + 1))
    found = []
    for path, numbers in sorted(readers.items()):
        if not path.endswith(CODE_SUFFIXES) or TEST_PATH_RE.search(path):
            continue
        try:
            lines = head_file_text(path).splitlines()
        except Exception:
            continue
        declared = {}
        for number, text in enumerate(lines, 1):
            match = VALUE_DECL_RE.match(text)
            if match:
                declared.setdefault(match.group(1), []).append((number, len(text) - len(text.lstrip())))
        owners = {}

        def owner(line):
            if line not in owners:
                block = enclosing_block(lines, line - 1, limit=len(lines[line - 1]) - len(lines[line - 1].lstrip())) if line > 1 else None
                owners[line] = block[1] if block else None
            return owners[line]

        changed = touched.get(path, {}).get("RIGHT", set())
        # The packet's diff already shows these lines, so a definition here is followed but not quoted again.
        shown = {line + offset for line in changed for offset in range(-DIFF_CONTEXT_LINES, DIFF_CONTEXT_LINES + 1)}
        visited = set()
        frontier = [(number, 1) for number in dict.fromkeys(numbers) if number <= len(lines)]
        while frontier:
            number, hop = frontier.pop(0)
            text = lines[number - 1]
            indent = len(text) - len(text.lstrip())
            # A definition counts only at module level or inside a function that encloses the reader;
            # otherwise the name is a parameter, and an earlier function's variable of that name is unrelated.
            scopes = {None, *enclosing_chain(lines, number)}
            for name in dict.fromkeys(READ_NAME_RE.findall(text.split("//")[0])):
                earlier = [
                    line
                    for line, depth in declared.get(name, ())
                    if line < number and depth <= indent and owner(line) in scopes
                ]
                if not earlier or (start := max(earlier)) in visited:
                    continue
                visited.add(start)
                end = statement_end(lines, start)
                if start not in shown:
                    found.append((path, start, end, name, number))
                if hop < DEFINITION_HOPS:
                    frontier += [(line, hop + 1) for line in range(start, end + 1)]
    sections = [
        f"## {path}:{start}-{end} (`{name}`, read at line {read_at})\n```text\n"
        + redact_for_model(numbered_lines(head_file_text(path), start, end))
        + "\n```"
        for path, start, end, name, read_at in found[:MAX_DEFINITIONS]
    ]
    print(
        f"Dottore definitions: found={len(found)}; quoted="
        + (", ".join(f"{path}:{start}-{end}({name})" for path, start, end, name, _ in found[:MAX_DEFINITIONS]) or "none"),
        flush=True,
    )
    return truncate("\n\n".join(sections), MAX_DEFINITION_CHARS)


SUBMIT_TRACE = function_tool(
    "submit_trace",
    "Submit the code ranges the reviewers need beyond the diff and the checks they must settle. This ends "
    "the trace.",
    {
        "locations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": PATH_PARAM,
                    **LINE_RANGE,
                    "symbol": {"type": "string", "description": "The changed function or value this range connects to."},
                    "connection": {
                        "type": "string",
                        "description": "One factual sentence on how this code uses, feeds or constrains the change.",
                    },
                },
                "required": ["path", "start", "end", "symbol", "connection"],
            },
        },
        "checks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": PATH_PARAM,
                    "line": {"type": "integer", "description": "The line at the PR head the question is about."},
                    "question": {
                        "type": "string",
                        "description": "One question naming the exact case that could break.",
                    },
                },
                "required": ["path", "line", "question"],
            },
        },
    },
    ["locations"],
)
TRACE_SYSTEM = (
    "You trace the blast radius of a pull request for the reviewers who read it after you. They see the diff; "
    "you find the code outside the diff that decides whether the change is correct. Do not decide whether the "
    "change is correct; the reviewers do that.\n\n"
    f"Changed Code quotes the change in place: each changed line with the {CHANGED_CODE_WINDOW} lines around it, "
    "each short function containing a change in full, and the same-file functions the changed lines call. Read "
    "it first and do not fetch it again. The seeds list where each changed function, and each name declared on "
    "a changed line, is used outside the diff. For each changed behavior:\n"
    "1. Read the call sites and consumers that depend on what changed.\n"
    "2. At each one, follow the values the changed result is combined with (the other operands of a condition, "
    "the filters or sets applied beside it, the arguments passed with it) back to where they are produced: "
    "search for the definition, then read_file its lines.\n"
    "3. Find where the inputs the changed code now relies on come from, and any parallel path that handles "
    "the same data but did not change.\n\n"
    f"Batch independent reads in one turn; you have at most {TRACE_TOOL_BUDGET} tool calls. Finish by calling "
    f"submit_trace with at most {MAX_TRACE_LOCATIONS} ranges at the PR head, at most "
    f"{MAX_TRACE_LOCATION_LINES} lines each, most important first. Prefer code the diff does not show, and give "
    "each range one factual sentence on how it connects to the change.\n\n"
    "Also submit checks, the questions the reviewers must settle. Find each place where the changed code meets "
    "code it did not change: a condition, filter, set or default combined with the changed result; a caller "
    "that still assumes the old behavior; a parallel path that handles the same data but did not change. Start "
    "with the unchanged lines and called functions Changed Code shows beside each change. For "
    "each, ask one question that cites the line and names the exact case where the two could disagree: an "
    "input, item, user, reader or state. For example: \"`parseLimit` now returns 0 for an empty string; does "
    "the caller at this line, which treats 0 as unlimited, then send everything?\" Ask, do not answer. At "
    f"most {MAX_TRACE_CHECKS} checks, most consequential first."
)
BLAST_RADIUS_NOTE = (
    "Code outside the diff that the change uses or affects, chosen by a tracer model and quoted verbatim from "
    "the PR head at the cited lines. Each heading names the changed symbol it connects to and how. The tracer "
    "did not judge the change; treat this as evidence, not as findings."
)
TRACE_CHECKS_NOTE = (
    "Questions the tracer model raised where the change meets code it did not change. They are questions, not "
    "findings, and the tracer is a cheaper model that may be wrong; settle each one from the code."
)
DEFINITIONS_NOTE = (
    "Where local values read by the changed lines, or at call sites of changed functions, are defined, and "
    "where those definitions' inputs are defined, quoted by code from the PR head. Each heading names the "
    "value and the line that reads it. This is evidence, not findings."
)


def quote_trace(locations):
    """Quote each traced range from the PR head; the tracer's own words supply only the heading."""
    sections = []
    quoted = []
    for location in locations[:MAX_TRACE_LOCATIONS]:
        if not isinstance(location, dict):
            continue
        try:
            path = tool_path(location.get("path"))
            start = max(1, int(location.get("start") or 1))
            end = min(max(start, int(location.get("end") or start)), start + MAX_TRACE_LOCATION_LINES - 1)
            lines = numbered_lines(head_file_text(path), start, end)
        except Exception as exc:
            print(f"Dottore trace: skipped {location.get('path')}: {error_text(exc)}", flush=True)
            continue
        if f"{path}:{start}-{end}" in quoted or lines.startswith("No lines in that range"):
            continue
        quoted.append(f"{path}:{start}-{end}")
        symbol = " ".join(str(location.get("symbol") or "").split())[:120]
        connection = " ".join(str(location.get("connection") or "").split())[:300]
        sections.append(f"## {path}:{start}-{end} ({symbol}): {connection}\n```text\n{redact_for_model(lines)}\n```")
    return truncate("\n\n".join(sections), MAX_BLAST_RADIUS_CHARS), quoted


def trace_checks(checks):
    """The tracer's valid checks as (path, line, question); invalid ones are dropped."""
    kept = []
    for check in checks:
        if not isinstance(check, dict):
            continue
        try:
            path = tool_path(check.get("path"))
        except ValueError:
            continue
        line = check.get("line")
        question = " ".join(redact_for_model(str(check.get("question") or "")).split())[:MAX_TRACE_CHECK_CHARS]
        if isinstance(line, bool) or not isinstance(line, int) or line <= 0 or not question:
            continue
        if not head_line_exists(path, line):
            continue
        kept.append((path, line, question))
        if len(kept) == MAX_TRACE_CHECKS:
            break
    return kept


def trace_blast_radius(ctx):
    """Stage 0: code quotes the definitions the change reads, then a cheaper model maps the code outside the
    diff that the change touches, which code quotes too. Returns the packet sections to append."""
    files = sorted(ctx.files)
    if not any(path.endswith(CODE_SUFFIXES) for path in files):
        print("Dottore trace: skipped; no changed code", flush=True)
        return ""
    try:
        touched = touched_lines(ctx.base)
        seeds, seed_count, sites = trace_seeds(touched)
        try:
            definitions = value_definitions(touched, sites)
        except Exception as exc:
            print(f"Dottore definitions failed: {error_text(exc)}", flush=True)
            definitions = ""
        try:
            code = changed_code(touched)
        except Exception as exc:
            print(f"Dottore changed code failed: {error_text(exc)}", flush=True)
            code = ""
        patch = truncate(
            redact_for_model(run_git_raw(diff_command(ctx.base, "--find-renames", "--unified=3", paths=files))),
            MAX_SECTION_CHARS,
        )
        submitted = run_agent(
            ctx,
            "trace",
            [
                {"role": "system", "content": TRACE_SYSTEM},
                {
                    "role": "user",
                    "content": f"# Changed files\n{chr(10).join(files)}\n\n# Seeds\n{seeds or 'No named changes found.'}"
                    f"\n\n# Diff\n```diff\n{patch}\n```\n\n# Changed Code\n{code or 'No changed code could be quoted.'}",
                },
            ],
            SUBMIT_TRACE,
            TRACE_TOOL_BUDGET,
            TRACE_TOOL_CHARS,
        )
    except Exception as exc:
        # ponytail: the lab A/B stops here, since a review without the trace tests nothing and still costs
        # the finders; a shipped tracer would log this and review without the section instead.
        print(f"Dottore trace failed: {error_text(exc)}", flush=True)
        raise RuntimeError(f"The blast-radius tracer failed, so the review stopped: {error_text(exc)}") from exc
    locations = as_list(submitted.get("locations"))
    section, quoted = quote_trace(locations)
    checks = trace_checks(as_list(submitted.get("checks")))
    print(
        f"Dottore trace: seeds={seed_count}; seed_chars={len(seeds)}; changed_code_chars={len(code)}; "
        f"locations={len(locations)}; "
        f"section_chars={len(section)}; checks={len(checks)}; quoted={', '.join(quoted) or 'none'}",
        flush=True,
    )
    for path, line, question in checks:
        print(f"Dottore trace check: {path}:{line}; {question}", flush=True)
    sections = []
    if definitions:
        sections.append(f"# Value Definitions\n{DEFINITIONS_NOTE}\n\n{definitions}")
    if section:
        sections.append(f"# Blast Radius\n{BLAST_RADIUS_NOTE}\n\n{section}")
    if checks:
        listed = "\n".join(f"- `{path}:{line}`: {question}" for path, line, question in checks)
        sections.append(f"# Tracer Checks\n{TRACE_CHECKS_NOTE}\n\n{listed}")
    return "\n\n".join(sections)


def as_list(value):
    return value if isinstance(value, list) else []


def same_spot(left, right):
    def spot(item):
        line = item.get("line")
        return (
            str(item.get("path", "")).strip(),
            str(item.get("side") or "RIGHT").strip().upper(),
            line if isinstance(line, int) and not isinstance(line, bool) else None,
        )

    (left_path, left_side, left_line), (right_path, right_side, right_line) = spot(left), spot(right)
    if (left_path, left_side) != (right_path, right_side):
        return False
    if left_line is None or right_line is None:
        return left.get("line") == right.get("line")
    return abs(left_line - right_line) <= NEARBY_LINES


def merge_segments(reports):
    """Stage 2: combine the segment reports without a model call."""
    merged = {key: [] for key in ("change_summary", "findings", "nitpicks", "open_questions")}
    checks = {}
    notes = []
    status_rank = {"fail": 0, "warn": 1, "unknown": 2, "pass": 3}
    severity_rank = {"blocking": 0, "high": 1, "medium": 2, "low": 3}
    for role, report in reports:
        if role == FINDER_ROLES[0]:
            merged["change_summary"].extend(str(item) for item in as_list(report.get("change_summary")))
        for key in ("findings", "nitpicks"):
            for item in as_list(report.get(key)):
                if not isinstance(item, dict):
                    continue
                # Segments word the same defect differently and cite neighbouring lines, so findings
                # within a few lines of each other keep one candidate: the most severe. "segment"
                # names every segment that reported it, for telemetry.
                entry = {**item, "segment": role}
                index = next(
                    (index for index, kept in enumerate(merged[key]) if same_spot(kept, entry)), None
                )
                if index is None:
                    merged[key].append(entry)
                    continue
                kept = merged[key][index]
                segments = "+".join(sorted({*kept["segment"].split("+"), role}))
                rank = severity_rank.get(str(item.get("severity", "")).lower(), 4)
                if rank < severity_rank.get(str(kept.get("severity", "")).lower(), 4):
                    kept = entry
                merged[key][index] = {**kept, "segment": segments}
        for check in as_list(report.get("pre_merge_checks")):
            if not isinstance(check, dict):
                continue
            name = str(check.get("name", "")).strip().lower()
            rank = status_rank.get(str(check.get("status", "")).lower(), 2)
            if name not in checks or rank < status_rank.get(str(checks[name].get("status", "")).lower(), 2):
                checks[name] = check
        for question in as_list(report.get("open_questions")):
            if question not in merged["open_questions"]:
                merged["open_questions"].append(question)
        label = SEGMENT_LABELS[role]
        notes.append([f"{label}: {note}" for note in as_list(report.get("what_i_checked"))])
    limitations = [check for check in checks.values() if control_type(check) == "Review Limitation"]
    merged["pre_merge_checks"] = [
        check
        for check in checks.values()
        if control_type(check) != "Review Limitation" or check in limitations[:MAX_REVIEW_LIMITATIONS]
    ]
    merged["nitpicks"] = merged["nitpicks"][:2]
    # Interleave the segments' notes so the rendered first few show both segments.
    merged["what_i_checked"] = [note for group in itertools.zip_longest(*notes) for note in group if note]
    return merged


def evidence_snippet(text):
    # Models often copy the numbered or diff-marked lines the tools showed them.
    lines = [re.sub(r"^\s*\d+: ?", "", re.sub(r"^[+-]", "", line)) for line in str(text or "").splitlines()]
    return " ".join(" ".join(lines).split())


def evidence_grounded(ctx, evidence, whole=False):
    """True when at least one quoted snippet appears near its cited line in the head or base file.

    With whole, the window also covers the snippet's own length, so a long quote starting at its line counts."""
    for item in evidence:
        snippet = evidence_snippet(item.get("snippet"))
        extra = len(str(item.get("snippet") or "").splitlines()) if whole else 0
        if len(snippet) < 3:
            continue
        line = item.get("line")
        for read in (head_file_text, lambda path: base_file_text(ctx, path)):
            try:
                lines = read(item.get("path")).splitlines()
            except Exception:
                continue
            if isinstance(line, int) and not isinstance(line, bool) and line > 0:
                lines = lines[max(0, line - 1 - EVIDENCE_WINDOW) : line + EVIDENCE_WINDOW + extra]
            window = "\n".join(lines)
            if any(snippet in " ".join(text.split()) for text in (window, redact_for_model(window))):
                return True
    return False


def verification_prompt(ctx, candidates):
    claims = [
        {
            "candidate": number,
            **{
                key: value
                for key, value in dataclasses.asdict(candidate).items()
                if key in {"severity", "path", "line", "side", "title", "body", "fix_hint"}
            },
            **({"outside_diff": True} if candidate.outside_diff else {}),
        }
        for number, candidate in enumerate(candidates, 1)
    ]
    path = candidates[0].path
    return (
        f"Verify these {len(claims)} candidate finding(s) in {path} before publication, following the "
        f"Verification section. You have at most {verifier_budget(candidates)} tool calls. Finish by "
        "calling submit_verdicts with one verdict per candidate number."
        f"\n\n# Candidates\n{json.dumps(claims, indent=2)}"
        f"\n\n# Path Rules\n{matching_path_rules([path])}"
        f"\n\n# Diff of {path}\n{truncate(diff_for_path(ctx.base, path), MAX_CONTEXT_FILE_CHARS)}"
    )


def verifier_budget(candidates):
    return VERIFIER_TOOL_BUDGET + len(candidates) - 1


def judge(ctx, candidate, verdict):
    """Turn one submitted verdict into (outcome, finding, note, evidence)."""
    if not isinstance(verdict, dict):
        return "unverified", candidate, "", []
    outcome = str(verdict.get("verdict", "")).strip().lower()
    note = " ".join(str(verdict.get("note") or "").split())
    evidence = [item for item in as_list(verdict.get("evidence")) if isinstance(item, dict)]
    if outcome not in {"confirmed", "rejected", "uncertain"}:
        outcome = "uncertain"
    if outcome == "confirmed" and not evidence_grounded(ctx, evidence):
        outcome = "uncertain"
        note = f"The quoted evidence did not match the code. {note}".strip()
    severity = str(verdict.get("severity", "")).strip().lower()
    if outcome == "confirmed" and severity in {"blocking", "high", "medium", "low"}:
        candidate.severity = severity
    return outcome, candidate, note, evidence


def verify_file(ctx, candidates):
    """Stage 3: Dottore checks one file's candidates against the code in a single agent run."""
    if time.monotonic() > ctx.deadline:
        return [("unverified", candidate, "", []) for candidate in candidates]
    submitted = run_agent(
        ctx,
        "verify",
        [
            {"role": "system", "content": ctx.skill},
            {"role": "user", "content": verification_prompt(ctx, candidates)},
        ],
        SUBMIT_VERDICTS,
        verifier_budget(candidates),
        VERIFIER_TOOL_CHARS + VERIFIER_TOOL_CHARS_PER_EXTRA * (len(candidates) - 1),
    )
    by_number = {}
    for verdict in as_list(submitted.get("verdicts")):
        if isinstance(verdict, dict) and isinstance(verdict.get("candidate"), int):
            by_number.setdefault(verdict["candidate"], verdict)
    return [judge(ctx, candidate, by_number.get(number)) for number, candidate in enumerate(candidates, 1)]


def verify_candidates(ctx, candidates, pool):
    """Verify the highest-severity candidates, one agent per file in parallel, and sort them by outcome."""
    chosen = candidates[:MAX_VERIFIED_CANDIDATES]
    groups = {}
    for candidate in chosen:
        groups.setdefault(candidate.path, []).append(candidate)
    futures = {path: pool.submit(verify_file, ctx, group) for path, group in groups.items()}
    counts = dict.fromkeys(("candidates", "confirmed", "rejected", "uncertain", "unverified", "failed"), 0)
    counts["candidates"] = len(candidates)
    counts["unverified"] = len(candidates) - len(chosen)
    results = {}
    for path, future in futures.items():
        try:
            for result in future.result():
                results[id(result[1])] = result
        except Exception as exc:
            print(f"Dottore verifier failed for {path}: {error_text(exc)}", flush=True)
            counts["failed"] += len(groups[path])
    confirmed, hypotheses = [], []
    for candidate in chosen:
        if id(candidate) not in results:
            continue
        outcome, finding, note, evidence = results[id(candidate)]
        counts[outcome] += 1
        print(
            f"Dottore candidate: {outcome}; found_by={finding.segment}; {finding.severity}; "
            f"{finding.path}:{finding.line}; {finding.title[:120]}",
            flush=True,
        )
        if outcome == "confirmed":
            confirmed.append({**dataclasses.asdict(finding), "verification": {"note": note, "evidence": evidence[:3]}})
        elif outcome == "uncertain":
            hypotheses.append(f"{finding.title} (`{finding.path}:{finding.line}`): {note}")
    return confirmed, hypotheses, counts


def agentic_review(ctx, packets, mode, pool):
    """Find in parallel, merge, then let Dottore verify each candidate before it can be posted."""
    merged = merge_segments(run_finders(ctx, packets, pool))
    # A slow last finder turn must not leave the checker without time, since unverified findings are withheld.
    ctx.deadline = max(
        ctx.deadline,
        min(time.monotonic() + VERIFY_RESERVE_SECONDS, ctx.stats["started_at"] + REVIEW_HARD_LIMIT_SECONDS),
    )
    candidates, severity_nitpicks, withheld = validate_review_items(
        {"findings": merged["findings"], "mode": mode}, ctx.base
    )
    merged["nitpicks"] = (merged["nitpicks"] + [dataclasses.asdict(item) for item in severity_nitpicks])[:2]
    confirmed, hypotheses, counts = verify_candidates(ctx, candidates, pool)
    ctx.stats["verification"] = counts
    questions = hypotheses + merged["open_questions"]
    merged["findings"] = confirmed
    merged["open_questions"] = questions[:MAX_OPEN_QUESTIONS]
    merged["withheld_findings"] = withheld
    merged["verification"] = counts
    unresolved = len(hypotheses) - MAX_OPEN_QUESTIONS
    if unresolved > 0:
        merged["pre_merge_checks"].append(
            {
                "name": "Unresolved Candidates",
                "status": "warn",
                "type": "Review Limitation",
                "detail": f"{unresolved} more candidate(s) could be neither confirmed nor refuted from the code, so they were withheld.",
            }
        )
    unexamined = counts["unverified"] + counts["failed"]
    if unexamined:
        merged["pre_merge_checks"].append(
            {
                "name": "Verification Coverage",
                "status": "warn",
                "type": "Review Limitation",
                "detail": f"{unexamined} candidate(s) went unexamined ({counts['unverified']} past the {MAX_VERIFIED_CANDIDATES}-candidate cap, the time limit or without a verdict, {counts['failed']} after a verifier error), so they were withheld.",
            }
        )
    return merged


def touched_lines(base):
    by_path: dict[str, dict[str, set[int]]] = {}
    old_path = new_path = None
    old_line = new_line = None
    diff = run_git_raw(["diff", "--find-renames", "--unified=0", f"{base}...HEAD"])
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            old_path = new_path = None
            old_line = new_line = None
            continue
        if old_line is None and line.startswith("--- "):
            old_path = line[4:]
            if old_path.startswith("a/"):
                old_path = old_path[2:]
            elif old_path == "/dev/null":
                old_path = None
            if old_path:
                by_path.setdefault(old_path, {"RIGHT": set(), "LEFT": set()})
            continue
        if new_line is None and line.startswith("+++ b/"):
            new_path = line.removeprefix("+++ b/")
            by_path.setdefault(new_path, {"RIGHT": set(), "LEFT": set()})
            continue
        if new_line is None and line.startswith("+++ /dev/null"):
            new_path = None
            continue
        match = re.match(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
        if match:
            old_line = int(match.group(1))
            new_line = int(match.group(3))
            continue
        if old_line is None or new_line is None:
            continue
        if line.startswith("\\"):
            continue
        if line.startswith("+"):
            if new_path:
                by_path[new_path]["RIGHT"].add(new_line)
            new_line += 1
        elif line.startswith("-"):
            path = new_path or old_path
            if path:
                by_path[path]["LEFT"].add(old_line)
            old_line += 1
        else:
            old_line += 1
            new_line += 1
    files = set(changed_files(base))
    return {path: sides for path, sides in by_path.items() if path in files}


def normalize_repair_contract(value):
    if not isinstance(value, dict):
        return None
    allowed_keys = (
        "invariant",
        "related_failure_paths",
        "adjacent_traps",
        "acceptable_fix_shapes",
        "expected_proof",
    )
    contract = {}
    for key in allowed_keys:
        raw = value.get(key)
        if isinstance(raw, list):
            items = [str(item).strip() for item in raw if str(item).strip()]
            if items:
                contract[key] = items[:5]
        elif isinstance(raw, str) and raw.strip():
            contract[key] = raw.strip()
    return contract or None


def normalize_review_item(item, *, default_severity):
    side = str(item.get("side", "RIGHT")).strip().upper()
    if side not in {"LEFT", "RIGHT"}:
        raise ValueError("side must be LEFT or RIGHT")
    return Finding(
        severity=str(item.get("severity", default_severity)).lower(),
        path=str(item.get("path", "")).strip(),
        line=item.get("line"),
        title=str(item.get("title", "")).strip(),
        body=str(item.get("body", "")).strip(),
        fix_hint=str(item.get("fix_hint", "")).strip(),
        repair_contract=normalize_repair_contract(item.get("repair_contract")),
        side=side,
        segment=str(item.get("segment", "")).strip(),
    )


def validate_review_items(review_obj, base):
    allowed = touched_lines(base)
    findings = []
    nitpicks = []
    invalid = []
    severities = {"blocking", "high", "medium", "low"}
    for item in review_obj.get("findings", []):
        try:
            finding = normalize_review_item(item, default_severity="medium")
        except Exception as exc:
            invalid.append(f"Malformed finding skipped: {exc}")
            continue
        target = nitpicks if finding.severity == "nitpick" else findings
        if finding.severity not in severities:
            finding.severity = "nitpick" if target is nitpicks else "medium"
        if not finding.path or finding.path not in allowed:
            invalid.append(
                f"{finding.severity} '{finding.title or '<untitled>'}' at "
                f"{finding.path or '<missing path>'}: not in changed files"
            )
            continue
        if isinstance(finding.line, bool) or not isinstance(finding.line, int) or finding.line <= 0:
            invalid.append(
                f"{finding.severity} '{finding.title or '<untitled>'}' at "
                f"{finding.path}: missing integer line"
            )
            continue
        if finding.side == "LEFT" and review_obj.get("mode") != "full":
            # GitHub anchors LEFT lines to the PR base, not the incremental review base.
            invalid.append(
                f"{finding.severity} '{finding.title or '<untitled>'}' at "
                f"{finding.path}:{finding.line}: deleted-line findings need a full review (`/dottore full`)"
            )
            continue
        if finding.line not in allowed[finding.path].get(finding.side, set()):
            if finding.side == "LEFT" or not head_line_exists(finding.path, finding.line):
                reason = (
                    "line is not a deleted LEFT diff line"
                    if finding.side == "LEFT"
                    else "line does not exist at the PR head"
                )
                invalid.append(
                    f"{finding.severity} '{finding.title or '<untitled>'}' at "
                    f"{finding.path}:{finding.line}: {reason}"
                )
                continue
            # Like CodeRabbit's outside-diff comments: kept, verified, and reported in the walkthrough.
            finding.outside_diff = True
        if not finding.title or not finding.body:
            invalid.append(f"{finding.path}:{finding.line}: missing title/body")
            continue
        target.append(finding)

    for item in review_obj.get("nitpicks", [])[:2]:
        try:
            nitpick = normalize_review_item(item, default_severity="nitpick")
            nitpick.severity = "nitpick"
        except Exception as exc:
            invalid.append(f"Malformed nitpick skipped: {exc}")
            continue
        if not nitpick.path or nitpick.path not in allowed:
            invalid.append(
                f"nitpick '{nitpick.title or '<untitled>'}' at "
                f"{nitpick.path or '<missing path>'}: not in changed files"
            )
            continue
        if nitpick.side != "RIGHT":
            invalid.append(f"nitpick '{nitpick.title or '<untitled>'}' must use RIGHT side")
            continue
        if isinstance(nitpick.line, bool) or not isinstance(nitpick.line, int) or nitpick.line <= 0:
            invalid.append(
                f"nitpick '{nitpick.title or '<untitled>'}' at "
                f"{nitpick.path}: missing integer line"
            )
            continue
        if nitpick.line not in allowed[nitpick.path].get("RIGHT", set()):
            invalid.append(
                f"nitpick '{nitpick.title or '<untitled>'}' at "
                f"{nitpick.path}:{nitpick.line}: line is not an added/changed diff line"
            )
            continue
        if not nitpick.title or not nitpick.body:
            invalid.append(f"{nitpick.path}:{nitpick.line}: missing nitpick title/body")
            continue
        nitpicks.append(nitpick)

    severity_rank = {"blocking": 0, "high": 1, "medium": 2, "low": 3}
    findings.sort(key=lambda finding: severity_rank.get(finding.severity, 2))
    return findings, nitpicks[:2], invalid


def render_finding_body(finding):
    meta = severity_meta(finding.severity)
    parts = [
        finding_marker(finding),
        f"### {meta['icon']} {meta['label']}: {finding.title}",
        "",
        f"**Location:** `{finding.path}:{finding.line}` ({finding.side})",
        "",
        blockquote(finding.body),
    ]
    if finding.fix_hint:
        parts.extend([""] + alert_block("TIP", [f"**Suggested fix:** {finding.fix_hint}"]))
    return inline_truncate("\n".join(parts).strip())


def finding_id(finding):
    raw = f"{finding.side}:{finding.path}:{finding.line}:{finding.title}".encode("utf-8", "replace")
    return hashlib.sha256(raw).hexdigest()[:16]


def finding_marker(finding):
    return f"<!-- dottore:finding={finding_id(finding)} -->"


def short_ref(value):
    if not value:
        return "unknown"
    value = str(value)
    if re.fullmatch(r"[0-9a-f]{40}", value):
        return value[:8]
    if value.startswith("origin/"):
        return value
    return value[:24]


def commit_subject(head_sha):
    if not head_sha:
        return ""
    result = run(["git", "log", "-1", "--format=%s", head_sha], timeout=30)
    if result.returncode != 0:
        return ""
    return " ".join(result.stdout.split())


def commit_line(head_sha, message=None, label="Commit"):
    subject = " ".join(str(message or "").split()) or commit_subject(head_sha)
    ref = short_ref(head_sha)
    if subject:
        return f"{label}: {ref} - {subject}"
    return f"{label}: {ref}"


def md_cell(value):
    return str(value or "").replace("|", "\\|").replace("\n", "<br>").strip()


def blockquote(text):
    lines = str(text or "").strip().splitlines() or [""]
    return "\n".join(f"> {line}" if line else ">" for line in lines)


def alert_block(kind, lines):
    body = [f"> [!{kind}]"]
    for line in lines:
        body.extend(blockquote(line).splitlines())
    return body


def compact_list(value):
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def severity_meta(severity):
    return {
        "blocking": {"icon": "🚫", "label": "BLOCKING", "rank": 0},
        "high": {"icon": "🔥", "label": "HIGH", "rank": 1},
        "medium": {"icon": "⚠️", "label": "MEDIUM", "rank": 2},
        "low": {"icon": "ℹ️", "label": "LOW", "rank": 3},
        "nitpick": {"icon": "🧹", "label": "NITPICK", "rank": 4},
    }.get(str(severity or "").lower(), {"icon": "❔", "label": "UNKNOWN", "rank": 9})


def status_meta(status):
    normalized = str(status or "").lower()
    if normalized in {"fail", "failure", "failed", "cancelled"}:
        return {"icon": "❌", "label": "FAIL"}
    if normalized in {"warn", "warning", "pending", "unknown"}:
        return {"icon": "⚠️", "label": normalized.upper() or "WARN"}
    if normalized in {"pass", "success", "passed", "skipped"}:
        return {"icon": "✅", "label": "PASS"}
    return {"icon": "❔", "label": normalized.upper() or "UNKNOWN"}


def status_badge(meta):
    return f"<strong>{meta['icon']}&nbsp;{meta['label']}</strong>"


def control_type(item):
    explicit = str(item.get("type") or item.get("kind") or "").strip()
    allowed = {
        "Proof Gap",
        "Review Limitation",
        "Non-blocking Coverage",
    }
    if explicit in allowed:
        return explicit
    combined = " ".join(
        str(item.get(key, "")) for key in ("name", "status", "detail")
    ).lower()
    if "proof" in combined or "test" in combined or "coverage" in combined:
        if "missing" in combined or "gap" in combined or "lacks" in combined:
            return "Proof Gap"
        return "Non-blocking Coverage"
    if "truncated" in combined or "context" in combined or "packet" in combined:
        return "Review Limitation"
    return "Review Limitation"


def warn_is_proof_gap(item):
    return status_meta(item.get("status"))["label"] in {"WARN", "WARNING", "PENDING", "UNKNOWN"} and control_type(item) == "Proof Gap"


def warn_is_blocking_proof_gap(item):
    if not warn_is_proof_gap(item):
        return False
    combined = " ".join(
        str(item.get(key, "")) for key in ("name", "detail", "blocking", "severity")
    ).lower()
    if "non-blocking" in combined or "not blocking" in combined:
        return False
    return "blocking" in combined or "merge-blocking" in combined


def finding_summary(findings):
    if not findings:
        return "No actionable defects isolated."
    counts = {}
    for finding in findings:
        severity = str(finding.severity or "unknown").lower()
        counts[severity] = counts.get(severity, 0) + 1
    pieces = []
    for severity in ("blocking", "high", "medium", "low", "nitpick", "unknown"):
        count = counts.get(severity, 0)
        if not count:
            continue
        meta = severity_meta(severity)
        pieces.append(f"{meta['icon']} {count} {severity}")
    return f"{len(findings)} finding(s): " + ", ".join(pieces)


def has_failed_review_check(pre_merge):
    return any(
        str(item.get("name", "")).strip().lower() == "review failed"
        and status_meta(item.get("status"))["label"] == "FAIL"
        for item in pre_merge
    )


def has_incomplete_review_check(pre_merge):
    names = {"review failed", "review skipped"}
    return any(str(item.get("name", "")).strip().lower() in names for item in pre_merge)


def merge_signal(review_obj, findings, nitpicks, pre_merge):
    state = str(review_obj.get("review_state") or "").lower()
    if state == "no_new_diff_reviewed":
        return {
            "label": "NO NEW DIFF REVIEWED",
            "title": "No New Diff Reviewed",
            "admonition": "NOTE",
            "detail": "Dottore already reviewed this head; this run did not inspect new changes.",
        }
    review_incomplete = has_incomplete_review_check(pre_merge)
    if review_incomplete:
        return {
            "label": "REVIEW INCOMPLETE",
            "title": "Specimen Unexamined",
            "admonition": "CAUTION",
            "detail": "Dottore Review did not complete, so no model findings are available.",
        }
    has_blocking = any(
        severity_meta(finding.severity)["rank"] <= severity_meta("high")["rank"]
        for finding in findings
    )
    has_failed_check = any(
        status_meta(item.get("status"))["label"] == "FAIL" for item in pre_merge
    )
    if has_blocking or has_failed_check:
        return {
            "label": "SPECIMEN UNSTABLE",
            "title": "Specimen Unstable",
            "admonition": "CAUTION",
            "detail": "Repair blocking/high findings or failed controls before merge.",
        }
    if findings or any(warn_is_blocking_proof_gap(item) for item in pre_merge):
        return {
            "label": "REPAIR REQUIRED",
            "title": "Repair Required",
            "admonition": "WARNING",
            "detail": "Actionable findings or blocking proof gaps remain for this head.",
        }
    has_notes = nitpicks or any(
        status_meta(item.get("status"))["label"] in {"WARN", "WARNING", "PENDING", "UNKNOWN"}
        for item in pre_merge
    )
    if has_notes:
        return {
            "label": "VIABLE, WITH NOTES",
            "title": "Viable, With Notes",
            "admonition": "WARNING",
            "detail": "No actionable defects were isolated, but non-blocking notes remain.",
        }
    return {
        "label": "VIABLE",
        "title": "Viable",
        "admonition": "TIP",
        "detail": "No actionable findings were isolated for this head.",
    }


def render_merge_signal(review_obj, findings, nitpicks, pre_merge, head_sha):
    signal = merge_signal(review_obj, findings, nitpicks, pre_merge)
    controls = control_summary(pre_merge)
    mode = review_obj.get("mode") or "unknown"
    body = [
        f"## Dottore Verdict: {signal['title']}",
        "",
        f"> [!{signal['admonition']}]",
        f"> **{signal['label']}**",
        f"> {signal['detail']}",
        "",
        "| Findings | Nitpicks | Controls | Reviewed Head | Mode |",
        "| ---: | ---: | --- | --- | --- |",
        f"| {len(findings)} | {len(nitpicks)} | {md_cell(controls)} | `{short_ref(head_sha)}` | `{md_cell(mode)}` |",
    ]
    return "\n".join(body)


def control_summary(pre_merge):
    if not pre_merge:
        return "none"
    counts = {}
    for item in pre_merge:
        label = status_meta(item.get("status"))["label"].lower()
        counts[label] = counts.get(label, 0) + 1
    ordered = []
    for label in ("fail", "warn", "warning", "pending", "unknown", "pass"):
        count = counts.get(label)
        if count:
            ordered.append(f"{count} {label}")
    return ", ".join(ordered) or f"{len(pre_merge)} control(s)"


def review_callout(findings, pre_merge):
    has_blocking = any(
        severity_meta(finding.severity)["rank"] <= severity_meta("high")["rank"]
        for finding in findings
    )
    review_failed = has_failed_review_check(pre_merge)
    has_failed_check = any(
        status_meta(item.get("status"))["label"] == "FAIL" for item in pre_merge
    )
    has_warn_check = any(
        status_meta(item.get("status"))["label"] in {"WARN", "WARNING", "PENDING", "UNKNOWN"}
        for item in pre_merge
    )
    summary = finding_summary(findings)
    if review_failed and not findings:
        return "\n".join(
            [
                "> [!CAUTION]",
                "> **Specimen unexamined.** Dottore Review did not complete, so no model findings are available.",
                "> Repair the failed review control or rerun Dottore before treating this PR as reviewed.",
            ]
        )
    if has_blocking or has_failed_check:
        return "\n".join(
            [
                "> [!CAUTION]",
                f"> **Specimen unstable.** {summary}",
                "> Repair blocking/high findings and failed controls before merge.",
            ]
        )
    if findings or has_warn_check:
        return "\n".join(
            [
                "> [!WARNING]",
                f"> **Anomalies remain.** {summary}",
                "> Examine the findings and warning rows before merge.",
            ]
        )
    return "\n".join(
        [
            "> [!TIP]",
            "> **No actionable defects isolated.** The examined mechanism yielded no merge-blocking specimen.",
        ]
    )


def render_review_metadata(review_obj, head_sha):
    mode = review_obj.get("mode") or "unknown"
    base = review_obj.get("review_base") or review_obj.get("base_ref") or "unknown"
    commit_message = review_obj.get("head_commit_message") or review_obj.get(
        "commit_message"
    )
    return "\n".join(
        [
            "> [!NOTE]",
            f"> Mode: `{mode}`  ",
            f"> {commit_line(head_sha, commit_message, label='Head')}  ",
            f"> {commit_line(base, label='Base')}",
        ]
    )


CONTRACT_LABELS = (
    ("invariant", "Invariant"),
    ("related_failure_paths", "Related failure paths"),
    ("adjacent_traps", "Adjacent traps"),
    ("acceptable_fix_shapes", "Acceptable fix shapes"),
    ("expected_proof", "Expected proof"),
)
CONTRACT_LABEL_TO_KEY = {label.lower(): key for key, label in CONTRACT_LABELS}


def code_block_text(text):
    return str(text or "").replace("```", "'''").strip()


def agent_prompt_for_finding(finding):
    contract = finding.repair_contract or {}
    lines = [
        f"Task: Fix `{finding.path}:{finding.line}` on the {finding.side} side.",
        f"Finding: {finding.title}",
        f"Severity: {finding.severity}",
    ]
    if finding.severity != "nitpick":
        for key, label in (
            ("invariant", "Goal"),
            ("related_failure_paths", "Cover"),
            ("adjacent_traps", "Avoid"),
            ("acceptable_fix_shapes", "Acceptable fixes"),
            ("expected_proof", "Proof required"),
        ):
            values = compact_list(contract.get(key))
            if values:
                lines.append(f"{label}: " + "; ".join(values))
    lines.append("Run the narrowest relevant check. If stale, leave code unchanged and record why.")
    return "\n".join(lines)


def render_agent_prompt_details(findings, summary):
    if not findings:
        return ""
    prompt = code_block_text(
        "\n\n".join(agent_prompt_for_finding(finding) for finding in findings)
    )
    if not prompt:
        return ""
    return "\n".join(
        [
            "<details>",
            f"<summary>{summary}</summary>",
            "",
            "```text",
            prompt,
            "```",
            "",
            "</details>",
        ]
    )


def compact_contract_for_state(contract):
    if not isinstance(contract, dict):
        return None
    compact = {}
    for key, _ in CONTRACT_LABELS:
        values = compact_state_values(contract.get(key))
        if values:
            compact[key] = values
    return compact or None


def contract_state_entry_from_finding(finding, *, status="open"):
    contract = compact_contract_for_state(finding.repair_contract)
    if not contract or finding.severity == "nitpick":
        return None
    return {
        "id": finding_id(finding),
        "status": status,
        "severity": str(finding.severity or "medium"),
        "path": finding.path,
        "line": finding.line,
        "side": finding.side,
        "title": compact_state_text(finding.title, 180),
        "fix_hint": compact_state_text(finding.fix_hint, 260),
        "repair_contract": contract,
    }


def contract_identity(entry):
    return (
        str(entry.get("id") or "").strip(),
        str(entry.get("path") or "").strip(),
        str(entry.get("side") or "RIGHT").strip().upper(),
        compact_state_text(entry.get("title"), 180).lower(),
    )


def contract_matches_finding(entry, finding):
    entry_id, entry_path, entry_side, entry_title = contract_identity(entry)
    if entry_id and entry_id == finding_id(finding):
        return True
    if entry_path and entry_path == finding.path and entry_side == finding.side:
        finding_title = compact_state_text(finding.title, 180).lower()
        if entry_title and entry_title == finding_title:
            return True
    return False


def resolved_contracts_since_last_review(prior_entries, current_findings, changed):
    resolved = []
    for entry in normalize_contract_state_entries(prior_entries):
        path = entry.get("path") or ""
        if not path or path not in changed:
            continue
        if any(contract_matches_finding(entry, finding) for finding in current_findings):
            continue
        resolved.append(
            {
                "id": entry.get("id"),
                "severity": entry.get("severity"),
                "path": path,
                "line": entry.get("line"),
                "title": entry.get("title") or "Prior Dottore finding",
                "side": entry.get("side") or "RIGHT",
                "status": "likely_resolved",
            }
        )
        if len(resolved) >= MAX_CONTRACT_STATE_ENTRIES:
            break
    return resolved


def normalize_contract_state_entries(entries):
    normalized = []
    if not isinstance(entries, list):
        return normalized
    for raw in entries:
        if not isinstance(raw, dict):
            continue
        contract = compact_contract_for_state(raw.get("repair_contract"))
        if not contract:
            continue
        normalized.append(
            {
                "id": compact_state_text(raw.get("id"), 40),
                "status": compact_state_text(raw.get("status") or "prior", 40),
                "severity": compact_state_text(raw.get("severity") or "medium", 24),
                "path": compact_state_text(raw.get("path"), 260),
                "line": raw.get("line") if isinstance(raw.get("line"), int) else None,
                "side": str(raw.get("side") or "RIGHT").strip().upper(),
                "title": compact_state_text(raw.get("title"), 180),
                "fix_hint": compact_state_text(raw.get("fix_hint"), 260),
                "repair_contract": contract,
            }
        )
        if len(normalized) >= MAX_CONTRACT_STATE_ENTRIES:
            break
    return normalized


def merge_contract_state(current_findings, prior_entries):
    merged = []
    seen = set()
    for finding in current_findings:
        entry = contract_state_entry_from_finding(finding, status="open")
        if not entry:
            continue
        seen.add(entry["id"])
        merged.append(entry)
    for entry in normalize_contract_state_entries(prior_entries):
        entry_id = entry.get("id")
        if entry_id and entry_id in seen:
            continue
        if entry_id:
            seen.add(entry_id)
        merged.append(entry)
        if len(merged) >= MAX_CONTRACT_STATE_ENTRIES:
            break
    return merged


def open_prior_contract_state(current_findings, prior_entries):
    open_entries = []
    for entry in normalize_contract_state_entries(prior_entries):
        if any(contract_matches_finding(entry, finding) for finding in current_findings):
            continue
        open_entries.append(entry)
    return open_entries


def encode_contract_state(entries):
    normalized = normalize_contract_state_entries(entries)
    if not normalized:
        return ""
    payload = {"version": 1, "contracts": normalized}
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).decode("ascii")
    return f"<!-- dottore:contract-state={encoded} -->"


def decode_contract_state_from_body(body):
    matches = CONTRACT_STATE_RE.findall(body or "")
    if not matches:
        return []
    encoded = matches[-1]
    try:
        decoded = base64.urlsafe_b64decode(encoded.encode("ascii"))
        payload = json.loads(decoded.decode("utf-8"))
    except Exception:
        return []
    return normalize_contract_state_entries(payload.get("contracts"))


def format_contract_entries_for_prompt(entries, limit=12_000):
    entries = normalize_contract_state_entries(entries)
    if not entries:
        return "No prior Dottore repair contracts found."
    lines = [
        "Prior Dottore repair contracts from earlier review rounds. Judge whether the current diff satisfies each invariant before reporting adjacent defects.",
    ]
    for index, entry in enumerate(entries, 1):
        location = f"{entry.get('path') or 'unknown'}:{entry.get('line') or '?'}"
        lines.extend(
            [
                "",
                f"## Contract {index}: {entry.get('title') or '<untitled>'}",
                f"- ID: {entry.get('id') or 'unknown'}",
                f"- Status: {entry.get('status') or 'prior'}",
                f"- Severity: {entry.get('severity') or 'medium'}",
                f"- Location: {location}",
                f"- Side: {entry.get('side') or 'RIGHT'}",
            ]
        )
        if entry.get("fix_hint"):
            lines.append(f"- Suggested repair: {entry['fix_hint']}")
        contract = entry.get("repair_contract") or {}
        for key, label in CONTRACT_LABELS:
            values = compact_state_values(contract.get(key))
            if values:
                lines.append(f"- {label}: " + "; ".join(values))
    return truncate("\n".join(lines).strip(), limit)


def render_walkthrough(
    review_obj,
    findings,
    nitpicks,
    invalid_findings,
    head_sha,
    prior_contracts=None,
):
    summary = review_obj.get("change_summary") or []
    questions = review_obj.get("open_questions") or []
    checked = review_obj.get("what_i_checked") or []
    pre_merge = review_obj.get("pre_merge_checks") or []
    resolved = review_obj.get("resolved_since_last_review") or []
    state_marker = (
        f"<!-- dottore:last-reviewed-sha={head_sha} -->"
        if head_sha and not has_incomplete_review_check(pre_merge)
        else "<!-- dottore:last-reviewed-sha=unrecorded -->"
    )
    contract_state_marker = encode_contract_state(
        merge_contract_state(
            findings, open_prior_contract_state(findings, prior_contracts or [])
        )
    )
    body = [
        DOTTORE_MARKER,
        state_marker,
    ]
    if contract_state_marker:
        body.append(contract_state_marker)
    body.extend([
        "## 🎭 Dottore Review",
        "",
        render_merge_signal(review_obj, findings, nitpicks, pre_merge, head_sha),
        "",
        render_review_metadata(review_obj, head_sha),
        "",
        "### 🧭 Specimen Summary",
    ])
    body.extend([f"- {line}" for line in summary[:2]] or ["- No specimen summary produced."])
    body.extend(["", "### 🔎 Isolated Defects"])
    if findings:
        body.extend(
            [
                "| Severity | Location | Finding |",
                "| :---: | --- | --- |",
            ]
        )
        for finding in findings:
            meta = severity_meta(finding.severity)
            body.append(
                "| "
                f"{status_badge(meta)} | "
                f"`{md_cell(finding.path)}:{finding.line}` ({finding.side})"
                f"{' · outside diff' if finding.outside_diff else ''} | "
                f"{md_cell(finding.title)} |"
            )
        outside = [finding for finding in findings if finding.outside_diff]
        if outside:
            # GitHub only takes inline comments on diff lines, so these are shown in full here.
            body.extend(["", "<details>", f"<summary>⚠️ Outside the diff ({len(outside)})</summary>", ""])
            body.extend(item for finding in outside for item in (render_finding_body(finding), ""))
            body.append("</details>")
    else:
        if has_failed_review_check(pre_merge):
            body.extend(
                [
                    "",
                    "> [!CAUTION]",
                    "> No model findings are available because Dottore Review failed before completing inspection.",
                ]
            )
        else:
            body.extend(["", "> [!TIP]", "> No actionable defects isolated."])
    if resolved:
        body.extend(["", "### ✅ Resolved Since Last Review"])
        for item in resolved[:5]:
            location = f"{item.get('path') or 'unknown'}:{item.get('line') or '?'}"
            title = item.get("title") or "Prior Dottore finding"
            body.append(f"- `{md_cell(location)}` - {md_cell(title)}")
    body.extend(["", "### 🧹 Minor Imperfections"])
    if nitpicks:
        body.extend(
            [
                "| Location | Nitpick |",
                "| --- | --- |",
            ]
        )
        for nitpick in nitpicks:
            body.append(
                "| "
                f"`{md_cell(nitpick.path)}:{nitpick.line}` ({nitpick.side}) | "
                f"{md_cell(nitpick.title)} |"
            )
    else:
        body.append("- None recorded.")
    agent_prompt = render_agent_prompt_details(
        findings, "🤖 Copy prompt for isolated Dottore findings"
    )
    if agent_prompt:
        body.extend(["", agent_prompt])
    if pre_merge:
        body.extend(
            [
                "",
                "### ✅ Control Checks",
                "| Status | Type | Check | Detail |",
                "| :---: | --- | --- | --- |",
            ]
        )
        for item in pre_merge[:5]:
            name = item.get("name", "check")
            status = item.get("status", "unknown")
            detail = item.get("detail", "")
            meta = status_meta(status)
            body.append(
                "| "
                f"{status_badge(meta)} | "
                f"{md_cell(control_type(item))} | "
                f"{md_cell(name)} | "
                f"{md_cell(detail)} |"
            )
    if questions:
        body.extend(["", "### ❓ Unresolved Hypotheses"])
        body.extend([f"- {line}" for line in questions[:2]])
    body.extend(["", "### 🧪 Observations"])
    body.extend([f"- {line}" for line in checked[:3]] or ["- Review packet and diff context inspected."])
    verification = review_obj.get("verification") or {}
    if invalid_findings or verification:
        body.extend(["", "### 📝 Lab Notes"])
    if verification:
        unexamined = verification.get("unverified", 0) + verification.get("failed", 0)
        body.append(
            f"- Dottore examined {verification.get('candidates', 0)} segment claim(s) against the code: "
            f"{verification.get('confirmed', 0)} confirmed, {verification.get('rejected', 0)} rejected, "
            f"{verification.get('uncertain', 0)} unresolved"
            + (f", {unexamined} unexamined." if unexamined else ".")
        )
    if invalid_findings:
        body.extend(
            [
                "",
                "> [!WARNING]",
                f"> Withheld {len(invalid_findings)} model finding(s) because their diff locations failed validation.",
            ]
        )
        body.extend([f"- {note}" for note in invalid_findings[:5]])
    return "\n".join(body).strip() + "\n"


def prior_review_contracts_context(pr_num, limit=12_000):
    if not pr_num:
        return "No prior Dottore review context available."
    state_entries = prior_review_contract_state(pr_num)
    if state_entries:
        return format_contract_entries_for_prompt(state_entries, limit)
    comment = latest_walkthrough_comment(pr_num)
    if not comment:
        return "No prior Dottore walkthrough comment or inline contract comments found."
    body = comment.get("body", "")
    if not body:
        return "Prior Dottore walkthrough comment was empty."
    useful_lines = []
    keep = False
    for line in body.splitlines():
        if line.startswith("### 🔎") or line.startswith("### 🧹") or "Repair contract" in line:
            keep = True
        elif line.startswith("### ") and keep:
            keep = False
        if keep or "dottore:finding=" in line or "Invariant" in line or "Expected proof" in line:
            useful_lines.append(line)
    compact = "\n".join(useful_lines).strip()
    if not compact:
        compact = body[:limit]
    return truncate(compact, limit)


def write_skipped_review(title, body, *, status="unknown", metadata=None):
    review_obj = {
        "change_summary": [body],
        "findings": [],
        "nitpicks": [],
        "pre_merge_checks": [{"name": title, "status": status, "detail": body}],
        "open_questions": [],
        "what_i_checked": ["No model pass ran; the specimen remained unexamined."],
    }
    if metadata:
        review_obj.update(metadata)
    pathlib.Path("review.json").write_text(
        json.dumps(review_obj, indent=2, sort_keys=True) + "\n",
        "utf-8",
    )


def error_text(exc):
    message = " ".join(str(exc).split())
    if len(message) > 500:
        message = message[:497] + "..."
    return f"{type(exc).__name__}: {message}"


def model_failure_detail(exc):
    # Provider errors, a bad DOTTORE_MODELS value and an agent that never submits all land here.
    return f"Dottore Review could not complete: {error_text(exc)}"


def current_head_sha():
    result = run(["git", "rev-parse", "HEAD"], timeout=30, check=True)
    return result.stdout.strip()


def ensure_local_head(head_sha, pr_num):
    if not head_sha or current_head_sha() == head_sha:
        return
    if pr_num:
        run(
            [
                "git",
                "fetch",
                "--force",
                "origin",
                f"pull/{pr_num}/head:refs/remotes/dottore-review/pr-{pr_num}",
            ],
            timeout=120,
        )
    checkout = run(["git", "checkout", "--detach", head_sha], timeout=90)
    if checkout.returncode != 0:
        raise RuntimeError(
            "Local checkout does not contain the PR head GitHub reported: "
            f"{head_sha}\n{checkout.stdout}{checkout.stderr}"
        )
    actual = current_head_sha()
    if actual != head_sha:
        raise RuntimeError(f"Local checkout is {actual}, expected PR head {head_sha}")


def issue_comments(pr_num):
    gh = run_gh(
        [
            "api",
            f"repos/{os.environ['GITHUB_REPOSITORY']}/issues/{pr_num}/comments?per_page=100",
            "--paginate",
        ],
        check=True,
    )
    return load_json_list(gh.stdout)


def sorted_walkthrough_comments(pr_num):
    walkthroughs = [
        comment for comment in issue_comments(pr_num) if DOTTORE_MARKER in comment.get("body", "")
    ]
    return sorted(
        walkthroughs,
        key=lambda comment: (
            comment.get("updated_at") or "",
            comment.get("created_at") or "",
            comment.get("id") or 0,
        ),
    )


def latest_walkthrough_comment(pr_num):
    walkthroughs = sorted_walkthrough_comments(pr_num)
    if not walkthroughs:
        return None
    return walkthroughs[-1]


def pull_inline_comments(pr_num):
    gh = run_gh(
        [
            "api",
            f"repos/{os.environ['GITHUB_REPOSITORY']}/pulls/{pr_num}/comments?per_page=100",
            "--paginate",
        ],
        check=True,
    )
    return load_json_list(gh.stdout)


def extract_repair_contract_from_markdown(body):
    contract = {}
    in_contract = False
    current_key = None
    for raw_line in (body or "").splitlines():
        line = raw_line.strip()
        if "<summary>Repair contract</summary>" in line:
            in_contract = True
            continue
        if in_contract and line == "</details>":
            break
        if not in_contract or not line:
            continue
        label_match = re.match(r"- \*\*(.+?):\*\*\s*(.*)$", line)
        if label_match:
            key = CONTRACT_LABEL_TO_KEY.get(label_match.group(1).strip().lower())
            if not key:
                current_key = None
                continue
            current_key = key
            value = label_match.group(2).strip()
            contract[key] = [value] if value else []
            continue
        if current_key and line.startswith("- "):
            contract.setdefault(current_key, []).append(line[2:].strip())
    return compact_contract_for_state(contract)


def inline_comment_contract_entry(comment):
    body = comment.get("body", "")
    contract = extract_repair_contract_from_markdown(body)
    if not contract:
        return None
    marker = inline_comment_marker(comment) or ""
    title = ""
    severity = "medium"
    for line in body.splitlines():
        match = re.match(r"### .*?\b(BLOCKING|HIGH|MEDIUM|LOW):\s*(.+)$", line.strip())
        if match:
            severity = match.group(1).lower()
            title = match.group(2).strip()
            break
    path = str(comment.get("path") or "").strip()
    line_number = comment.get("line") if isinstance(comment.get("line"), int) else None
    location_match = re.search(r"\*\*Location:\*\* `(.+):(\d+)`", body)
    if location_match:
        path = location_match.group(1).strip()
        line_number = int(location_match.group(2))
    fix_hint = ""
    fix_match = re.search(r"\*\*Suggested fix:\*\*\s*(.+)", body)
    if fix_match:
        fix_hint = fix_match.group(1).strip()
    return {
        "id": marker,
        "status": "prior",
        "severity": severity,
        "path": path,
        "line": line_number,
        "side": str(comment.get("side") or "RIGHT").upper(),
        "title": title,
        "fix_hint": fix_hint,
        "repair_contract": contract,
    }


def prior_inline_contract_state(pr_num):
    if not pr_num:
        return []
    try:
        comments = pull_inline_comments(pr_num)
    except Exception:
        return []
    entries = []
    seen = set()
    for comment in sorted(
        comments,
        key=lambda item: (
            item.get("updated_at") or "",
            item.get("created_at") or "",
            item.get("id") or 0,
        ),
        reverse=True,
    ):
        if "dottore:finding=" not in comment.get("body", ""):
            continue
        entry = inline_comment_contract_entry(comment)
        if not entry:
            continue
        key = entry.get("id") or (
            entry.get("path"),
            entry.get("line"),
            entry.get("title"),
        )
        if key in seen:
            continue
        seen.add(key)
        entries.append(entry)
        if len(entries) >= MAX_CONTRACT_STATE_ENTRIES:
            break
    return normalize_contract_state_entries(entries)


def prior_review_contract_state(pr_num):
    if not pr_num:
        return []
    comment = latest_walkthrough_comment(pr_num)
    if comment:
        entries = decode_contract_state_from_body(comment.get("body", ""))
        if entries:
            return entries
    return prior_inline_contract_state(pr_num)


def is_completed_review_body(body):
    if not STATE_MARKER_RE.search(body):
        return False
    lowered = body.lower()
    failed_markers = (
        "review failed",
        "specimen unexamined",
        "could not complete",
        "no model findings are available",
        "review skipped",
    )
    return not any(marker in lowered for marker in failed_markers)


def discover_last_reviewed_sha(pr_num):
    for comment in reversed(sorted_walkthrough_comments(pr_num)):
        body = comment.get("body", "")
        if not is_completed_review_body(body):
            continue
        matches = STATE_MARKER_RE.findall(body)
        if matches:
            return matches[-1]
    return None


def valid_review_base_sha(candidate, head_sha):
    if not candidate or not re.fullmatch(r"[0-9a-f]{40}", candidate):
        return False
    exists = run(["git", "cat-file", "-e", f"{candidate}^{{commit}}"])
    if exists.returncode != 0:
        run(["git", "fetch", "--no-tags", "--depth=200", "origin", candidate], timeout=120)
        exists = run(["git", "cat-file", "-e", f"{candidate}^{{commit}}"])
    if exists.returncode != 0:
        return False
    ancestor = run(["git", "merge-base", "--is-ancestor", candidate, head_sha])
    return ancestor.returncode == 0


def resolve_review_base(pr_num, requested_mode):
    pr = run_gh(
        [
            "pr",
            "view",
            pr_num,
            "--json",
            "baseRefName,headRefOid",
        ],
        check=True,
    )
    data = json.loads(pr.stdout)
    base_ref = os.environ.get("PR_BASE_REF") or data["baseRefName"]
    head_sha = os.environ.get("PR_HEAD_SHA") or data["headRefOid"]
    explicit_base = os.environ.get("DOTTORE_BASE_SHA")
    mode = requested_mode
    if explicit_base:
        return explicit_base, base_ref, head_sha, "custom"
    if mode == "full":
        return f"origin/{base_ref}", base_ref, head_sha, mode
    explicit_previous = os.environ.get("DOTTORE_LAST_REVIEWED_SHA", "").strip()
    if valid_review_base_sha(explicit_previous, head_sha):
        return explicit_previous, base_ref, head_sha, "incremental"
    previous = discover_last_reviewed_sha(pr_num)
    if valid_review_base_sha(previous, head_sha):
        return previous, base_ref, head_sha, "incremental"
    return f"origin/{base_ref}", base_ref, head_sha, "full"


def parse_command_mode():
    body = os.environ.get("DOTTORE_COMMENT_BODY", "")
    if "/dottore" not in body:
        return os.environ.get("DOTTORE_REVIEW_MODE", "auto")
    if re.search(r"/dottore\s+full\b", body):
        return "full"
    if re.search(r"/dottore\s+review\b", body):
        return "auto"
    return "auto"


def produce_review(args):
    pr_num = os.environ.get("PR_NUM", "")
    if not pr_num and not os.environ.get("OPENAI_API_KEY"):
        write_skipped_review(
            "Review Skipped",
            "The reviewer could not run because `OPENAI_API_KEY` is absent from this workflow run. Repository-secret withholding leaves the specimen unexamined.",
        )
        print("Dottore telemetry: skipped=missing_openai_api_key", flush=True)
        return

    requested_mode = args.mode or parse_command_mode()
    base, base_ref, head_sha, effective_mode = resolve_review_base(pr_num, requested_mode)
    ensure_local_head(head_sha, pr_num)
    patch_command_status_running(pr_num, head_sha, effective_mode)
    files = changed_files(base)
    if not files and effective_mode == "incremental":
        write_skipped_review(
            "No New Diff Reviewed",
            "Dottore already reviewed this head; this run did not inspect new changes.",
            status="pass",
            metadata={
                "head_sha": head_sha,
                "head_commit_message": commit_subject(head_sha),
                "review_base": base,
                "base_ref": base_ref,
                "mode": effective_mode,
                "review_state": "no_new_diff_reviewed",
            },
        )
        print("Dottore telemetry: skipped=no_new_diff_reviewed", flush=True)
        return

    if not os.environ.get("OPENAI_API_KEY"):
        write_skipped_review(
            "Review Skipped",
            "The reviewer could not run because `OPENAI_API_KEY` is absent from this workflow run. Repository-secret withholding leaves the specimen unexamined.",
            metadata={
                "head_sha": head_sha,
                "head_commit_message": commit_subject(head_sha),
                "review_base": base,
                "base_ref": base_ref,
                "mode": effective_mode,
            },
        )
        print("Dottore telemetry: skipped=missing_openai_api_key", flush=True)
        return

    chunks = chunk_changed_files(base, files)

    skill = dottore_prompt_path().read_text("utf-8")
    prior_contract_state = prior_review_contract_state(pr_num)
    prior_contract_context = (
        format_contract_entries_for_prompt(prior_contract_state)
        if prior_contract_state
        else prior_review_contracts_context(pr_num)
    )
    review_target = (
        f"Review this PR. The review base is '{base}' from target branch '{base_ref}', "
        f"head is '{head_sha}', and mode is '{effective_mode}'."
    )

    if len(chunks) > 1:
        stats = build_stats("")
        packets = []
        for index, chunk in enumerate(chunks, 1):
            review_packet = build_review_packet(
                base,
                effective_mode,
                focus_files=chunk,
                include_full_patch=False,
            )
            stats["review_packet_chars"] += len(review_packet)
            focus_note = (
                f"This is chunk {index} of {len(chunks)}. Review only these focus files: "
                + ", ".join(chunk)
                + "."
            )
            packets.append(finder_packet(review_target, focus_note, prior_contract_context, review_packet))
    else:
        review_packet = build_review_packet(base, effective_mode)
        stats = build_stats(review_packet)
        packets = [
            finder_packet(review_target, "Review the full current diff.", prior_contract_context, review_packet)
        ]
    try:
        models = role_models()
        print(f"Dottore endpoints: {endpoint_summary(models)}", flush=True)
        ctx = ReviewRun(
            clients=review_clients(models),
            skill=skill,
            models=models,
            stats=stats,
            base=base,
            merge_base=run(["git", "merge-base", base, "HEAD"], check=True).stdout.strip(),
            files=frozenset(files),
            deadline=stats["started_at"] + REVIEW_DEADLINE_SECONDS,
            cache_key=f"dottore-{os.environ.get('GITHUB_REPOSITORY', 'local')}-{pr_num or head_sha[:12]}",
        )
        # ponytail: one trace covers every chunk and is appended to each; trace per chunk if large PRs need it.
        blast_radius = trace_blast_radius(ctx)
        if os.environ.get("DOTTORE_LAB_STAGE", "").strip().lower() == "trace":
            # ponytail: lab stage that measures the Luna tracer alone, for pennies; remove it with the lab.
            write_skipped_review(
                "Lab Trace Only",
                "DOTTORE_LAB_STAGE=trace: the tracer ran and the review stopped before the finders.",
                metadata={"head_sha": head_sha, "review_base": base, "base_ref": base_ref, "mode": effective_mode},
            )
            print_telemetry(stats)
            return
        if blast_radius:
            packets = [f"{packet}\n\n{blast_radius}" for packet in packets]
        with ThreadPoolExecutor(max_workers=review_concurrency()) as pool:
            review_obj = agentic_review(ctx, packets, effective_mode, pool)
    except Exception as exc:
        write_skipped_review(
            "Review Failed",
            model_failure_detail(exc),
            status="fail",
            metadata={
                "head_sha": head_sha,
                "head_commit_message": commit_subject(head_sha),
                "review_base": base,
                "base_ref": base_ref,
                "mode": effective_mode,
            },
        )
        print_telemetry(stats)
        return
    if len(chunks) > 1:
        review_obj["what_i_checked"].append(
            f"Examined the PR in {len(chunks)} file chunk(s) so the large diff did not contaminate context retention."
        )
    for key in ("findings", "nitpicks", "pre_merge_checks"):
        if review_obj.get(key) is None:
            review_obj[key] = []
    review_obj.setdefault("head_sha", head_sha)
    review_obj.setdefault("head_commit_message", commit_subject(head_sha))
    review_obj.setdefault("review_base", base)
    review_obj.setdefault("base_ref", base_ref)
    review_obj.setdefault("mode", effective_mode)
    review_obj.setdefault("_prior_dottore_contract_state", prior_contract_state)
    review_obj.setdefault("what_i_checked", []).append(
        f"Selected review base `{base}` for target branch `{base_ref}` in `{effective_mode}` mode."
    )
    try:
        valid_findings, _, _ = validate_review_items(review_obj, base)
        review_obj["resolved_since_last_review"] = resolved_contracts_since_last_review(
            prior_contract_state,
            valid_findings,
            set(files),
        )
    except Exception:
        review_obj.setdefault("resolved_since_last_review", [])
    pathlib.Path("review.json").write_text(
        json.dumps(review_obj, indent=2, sort_keys=True) + "\n", "utf-8"
    )
    print_telemetry(stats)


def findings_for_inline_comments(findings):
    mode = os.environ.get("DOTTORE_INLINE_FINDINGS", "urgent").strip().lower()
    if mode in {"none", "off", "false", "0"}:
        return []
    if mode in {"all", "true", "1"}:
        return findings
    return [
        finding
        for finding in findings
        if severity_meta(finding.severity)["rank"] <= severity_meta("medium")["rank"]
    ]


def render_review(args):
    review_obj = json.loads(pathlib.Path(args.review_json).read_text("utf-8"))
    base = (
        args.base
        or os.environ.get("DOTTORE_VALIDATION_BASE")
        or os.environ.get("DOTTORE_BASE_SHA")
        or review_obj.get("review_base")
    )
    if not base:
        pr_num = os.environ.get("PR_NUM", "")
        requested_mode = args.mode or parse_command_mode()
        base, _, _, _ = resolve_review_base(pr_num, requested_mode)
    findings, nitpicks, invalid = validate_review_items(review_obj, base)
    # Candidates withheld before verification count with the ones withheld here.
    invalid = [*as_list(review_obj.get("withheld_findings")), *invalid]
    head_sha = review_obj.get("head_sha") or os.environ.get("DOTTORE_HEAD_SHA", "")
    walkthrough = render_walkthrough(
        review_obj,
        findings,
        nitpicks,
        invalid,
        head_sha,
        prior_contracts=review_obj.get("_prior_dottore_contract_state") or [],
    )
    pathlib.Path("review.md").write_text(walkthrough, "utf-8")
    inline_findings = findings_for_inline_comments([f for f in findings if not f.outside_diff])
    inline = [
        {
            "path": f.path,
            "line": f.line,
            "side": f.side,
            "body": render_finding_body(f),
        }
        for f in inline_findings
    ]
    pathlib.Path("inline-comments.json").write_text(
        json.dumps(inline, indent=2, sort_keys=True) + "\n", "utf-8"
    )


def find_walkthrough_comment(pr_num):
    comment = latest_walkthrough_comment(pr_num)
    if comment:
        return comment.get("id")
    return None


def find_command_status_comment(pr_num):
    for comment in issue_comments(pr_num):
        if COMMAND_STATUS_MARKER in comment.get("body", ""):
            return comment.get("id")
    return None


def patch_command_status_running(pr_num, head_sha, mode):
    body = "\n".join(
        [
            COMMAND_STATUS_MARKER,
            "## 🎭 Dottore Review — Experiment in Progress",
            "",
            "> [!NOTE]",
            "> Reviewer workflow is running. The specimen is under observation.",
            "",
            f"- **Mode:** `{mode or 'unknown'}`",
            f"- **{commit_line(head_sha)}**",
        ]
    )
    patch_or_create_command_status(pr_num, body)


def patch_command_status_complete(pr_num, head_sha):
    body = "\n".join(
        [
            COMMAND_STATUS_MARKER,
            "## 🎭 Dottore Review — Concluded",
            "",
            "> [!TIP]",
            "> Review posted. The specimen has left the observation table.",
            "",
            f"- **{commit_line(head_sha)}**",
        ]
    )
    patch_or_create_command_status(pr_num, body)


def patch_or_create_command_status(pr_num, body):
    comment_id = find_command_status_comment(pr_num)
    if comment_id:
        run_gh(
            [
                "api",
                "--method",
                "PATCH",
                f"repos/{os.environ['GITHUB_REPOSITORY']}/issues/comments/{comment_id}",
                "--input",
                "-",
            ],
            input_text=json.dumps({"body": body}),
            check=True,
        )
        return
    run_gh(
        [
            "api",
            "--method",
            "POST",
            f"repos/{os.environ['GITHUB_REPOSITORY']}/issues/{pr_num}/comments",
            "--input",
            "-",
        ],
        input_text=json.dumps({"body": body}),
        check=True,
    )


def load_json_list(stdout):
    try:
        loaded = json.loads(stdout or "[]")
        return loaded if isinstance(loaded, list) else []
    except json.JSONDecodeError:
        items = []
        for line in stdout.splitlines():
            if not line.strip():
                continue
            loaded = json.loads(line)
            if isinstance(loaded, list):
                items.extend(loaded)
        return items


def existing_inline_finding_markers(pr_num):
    markers = set()
    for comment in pull_inline_comments(pr_num):
        markers.update(FINDING_MARKER_RE.findall(comment.get("body", "")))
    return markers


def inline_comment_marker(comment):
    match = FINDING_MARKER_RE.search(comment.get("body", ""))
    if not match:
        return None
    return match.group(1)


def filter_duplicate_inline_comments(pr_num, comments):
    existing = existing_inline_finding_markers(pr_num)
    if not existing:
        return comments
    filtered = []
    for comment in comments:
        marker = inline_comment_marker(comment)
        if marker and marker in existing:
            continue
        filtered.append(comment)
    return filtered


def post_review(args):
    pr_num = os.environ["PR_NUM"]
    body = pathlib.Path(args.review_md).read_text("utf-8")
    head_sha_match = STATE_MARKER_RE.search(body)
    head_sha = head_sha_match.group(1) if head_sha_match else os.environ.get(
        "PR_HEAD_SHA", ""
    )
    comment_id = find_walkthrough_comment(pr_num)
    if comment_id:
        run_gh(
            [
                "api",
                "--method",
                "PATCH",
                f"repos/{os.environ['GITHUB_REPOSITORY']}/issues/comments/{comment_id}",
                "--input",
                "-",
            ],
            input_text=json.dumps({"body": body}),
            check=True,
        )
    else:
        run_gh(["pr", "comment", pr_num, "--body-file", args.review_md], check=True)

    patch_command_status_complete(pr_num, head_sha)

    comments = json.loads(pathlib.Path(args.inline_json).read_text("utf-8"))
    comments = filter_duplicate_inline_comments(pr_num, comments)
    if not comments:
        return
    payload = {
        "event": "COMMENT",
        "commit_id": head_sha,
        "body": "Dottore Review — isolated defects from the specimen.",
        "comments": comments,
    }
    run_gh(
        [
            "api",
            "--method",
            "POST",
            f"repos/{os.environ['GITHUB_REPOSITORY']}/pulls/{pr_num}/reviews",
            "--input",
            "-",
        ],
        input_text=json.dumps(payload),
        check=True,
    )


def load_review_for_status(path):
    try:
        return json.loads(pathlib.Path(path).read_text("utf-8"))
    except Exception:
        return {}


def status_state(args):
    if str(args.job_status or "").lower() != "success":
        print("state=failure")
        print("description=Dottore Review did not complete. Inspect the trusted workflow run for details.")
        return
    if not pathlib.Path(args.review_json).exists():
        print("state=failure")
        print("description=Dottore Review did not produce review.json; inspect the trusted workflow run.")
        return
    review_obj = load_review_for_status(args.review_json)
    required_lists = ("findings", "nitpicks", "pre_merge_checks")
    if not isinstance(review_obj, dict) or any(
        not isinstance(review_obj.get(key), list) for key in required_lists
    ):
        print("state=failure")
        print("description=Dottore Review produced an invalid review.json; inspect the trusted workflow run.")
        return
    pre_merge = review_obj["pre_merge_checks"]
    if any(not isinstance(item, dict) for item in pre_merge):
        print("state=failure")
        print("description=The control record is malformed; Dottore cannot certify this examination.")
        return
    if has_incomplete_review_check(pre_merge or []):
        print("state=failure")
        print("description=Dottore Review posted a failure or skipped report; rerun after repairing the review control.")
        return
    print("state=success")
    print("description=Examination concluded. Dottore's findings await their repair; independent controls remain separate.")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command")
    produce = sub.add_parser("produce")
    produce.add_argument("--mode", choices=["auto", "full", "incremental"])
    render = sub.add_parser("render")
    render.add_argument("--review-json", default="review.json")
    render.add_argument("--base")
    render.add_argument("--mode", choices=["auto", "full", "incremental"])
    post = sub.add_parser("post")
    post.add_argument("--review-md", default="review.md")
    post.add_argument("--inline-json", default="inline-comments.json")
    status = sub.add_parser("status-state")
    status.add_argument("--review-json", default="review.json")
    status.add_argument("--job-status", default="success")
    args = parser.parse_args()

    if args.command in (None, "produce"):
        produce_review(args)
    elif args.command == "render":
        render_review(args)
    elif args.command == "post":
        post_review(args)
    elif args.command == "status-state":
        status_state(args)


if __name__ == "__main__":
    main()
