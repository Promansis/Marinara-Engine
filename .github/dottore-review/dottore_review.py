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
REVIEW_ROLES = ("broad", "skeptic", "verify")
FINDER_ROLES = ("broad", "skeptic")
SEGMENT_LABELS = {
    "broad": "Broad segment",
    "skeptic": "Skeptical segment",
}
FINDER_TOOL_BUDGET = 5
# The skeptic starts this long after the broad segment, so its first call can reuse the packet prefix
# the broad call has just cached instead of both paying for it in full.
FINDER_STAGGER_SECONDS = 8
VERIFIER_TOOL_BUDGET = 5
# Each agent also has a tool-output budget, since every later turn resends its tool results.
# Verifiers get their own, so finders can never starve verification.
FINDER_TOOL_CHARS = 24_000
VERIFIER_TOOL_CHARS = 20_000
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
PROVIDERS = ("openai", "anthropic")
# Claude requires an output cap; it covers thinking and the reply, and every current model allows it.
CLAUDE_MAX_TOKENS = 32_000
CACHE_BREAKPOINT = {"type": "ephemeral"}
DEFAULT_CONCURRENCY = 4
MAX_CONCURRENCY = 16
# The review step times out at 30 minutes; after this, agents submit and no new verifier starts.
REVIEW_DEADLINE_SECONDS = 20 * 60
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


def search_repo(pattern):
    if not pattern or len(pattern) > 120:
        return "refused: search pattern must be 1-120 characters"
    if not shutil.which("rg"):
        return search_repo_with_python(pattern)
    rg = run(
        [
            "rg",
            "--fixed-strings",
            "--line-number",
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


def search_repo_with_python(pattern):
    hits = []
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
    for path in REPO_ROOT.rglob("*"):
        if len(hits) >= MAX_SEARCH_HITS:
            break
        if any(part in ignored_parts for part in path.parts):
            continue
        if not path.is_file():
            continue
        try:
            if path.stat().st_size > MAX_SEARCH_FILE_BYTES:
                continue
            rel = path.relative_to(REPO_ROOT)
            if excluded_path(rel.as_posix()):
                continue
            text = path.read_text("utf-8", "replace")
        except Exception:
            continue
        if "\0" in text[:8_000]:
            continue
        for line_no, line in enumerate(text.splitlines(), 1):
            if pattern in line and len(line) <= MAX_SEARCH_LINE_CHARS:
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
            'DOTTORE_MODELS must map "broad", "skeptic" or "verify" to {"provider", "model", "effort"} objects.'
        )
    models = {
        role: {
            "provider": str(overrides.get(role, {}).get("provider") or default_provider).strip().lower(),
            "model": str(overrides.get(role, {}).get("model") or default_model).strip(),
            "effort": str(overrides.get(role, {}).get("effort") or default_effort).strip(),
        }
        for role in REVIEW_ROLES
    }
    unknown = sorted({settings["provider"] for settings in models.values()} - set(PROVIDERS))
    if unknown:
        raise ValueError(f"Unknown Dottore provider {', '.join(unknown)}; use {' or '.join(PROVIDERS)}.")
    return models


def review_clients(models):
    """One client per provider the roles use."""
    providers = {settings["provider"] for settings in models.values()}
    clients = {}
    if "openai" in providers:
        from openai import OpenAI

        clients["openai"] = OpenAI(
            api_key=os.environ["OPENAI_API_KEY"],
            base_url=os.environ.get("LLM_BASE_URL") or None,
            max_retries=MODEL_MAX_RETRIES,
        )
    if "anthropic" in providers:
        from anthropic import Anthropic

        # Gateways such as LinkAPI take one key for both formats, so the shared key is the fallback.
        clients["anthropic"] = Anthropic(
            api_key=os.environ.get("ANTHROPIC_API_KEY") or os.environ["OPENAI_API_KEY"],
            base_url=os.environ.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com",
            max_retries=MODEL_MAX_RETRIES,
        )
    return clients


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


def base_file_text(ctx, path):
    shown = run(["git", "show", f"{ctx.merge_base}:{tool_path(path)}"], timeout=60)
    if shown.returncode != 0:
        raise ValueError(f"{path} does not exist at the review base")
    return readable_text(tool_path(path), shown.stdout)


def numbered_lines(text, start=None, end=None):
    lines = text.splitlines()
    first = max(1, int(start or 1))
    last = min(len(lines), int(end or first + MAX_TOOL_LINES - 1), first + MAX_TOOL_LINES - 1)
    if first > last:
        return f"No lines in that range; the file has {len(lines)} lines."
    body = "\n".join(f"{number}: {lines[number - 1]}" for number in range(first, last + 1))
    return truncate(body, MAX_TOOL_CHARS)


def searchable_hit(hit):
    try:
        tool_path(hit.split(":", 1)[0])
    except ValueError:
        return False
    return True


def run_tool(ctx, name, arguments):
    """Run one read-only tool call; every result is redacted and every failure becomes a refusal."""
    try:
        args = json.loads(arguments or "{}")
        if not isinstance(args, dict):
            raise ValueError("arguments must be a JSON object")
        if name == "read_file":
            result = numbered_lines(head_file_text(args.get("path")), args.get("start"), args.get("end"))
        elif name == "base_version":
            result = numbered_lines(base_file_text(ctx, args.get("path")), args.get("start"), args.get("end"))
        elif name == "file_diff":
            path = tool_path(args.get("path"))
            if path not in ctx.files:
                raise ValueError(f"{path} is not a changed file; use read_file")
            result = truncate(diff_for_path(ctx.base, path), MAX_FILE_PATCH_CHARS)
        elif name == "search":
            hits = search_repo(str(args.get("literal") or "")).splitlines()
            result = "\n".join(hit for hit in hits if searchable_hit(hit)) or "no matches"
        else:
            raise ValueError(f"unknown tool {name}")
    except Exception as exc:
        return f"refused: {exc}"
    return redact_for_model(result)


class StreamStalled(Exception):
    """The connection went quiet or dropped after the reply stream opened."""


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
        with ctx.clients["openai"].chat.completions.create(**request) as stream:
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
        with ctx.clients["anthropic"].messages.stream(**request) as stream:
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


def chat(ctx, role, messages, tools, tool_choice):
    settings = ctx.models[role]
    first_call = not any(message.get("role") == "assistant" for message in messages)
    read_timeout = FIRST_CALL_TIMEOUT if first_call else MODEL_REQUEST_TIMEOUT
    reply = claude_reply if settings["provider"] == "anthropic" else openai_reply
    # The client retries a request that fails before its stream opens; this retries one that stalls after.
    for attempt in range(MODEL_MAX_RETRIES + 1):
        started = time.monotonic()
        timing = {}
        try:
            message, usage = reply(ctx, settings, messages, tools, tool_choice, read_timeout, started, timing)
            break
        except StreamStalled as exc:
            print(
                f"Dottore call retry: role={role}; attempt={attempt + 1}; after_s={time.monotonic() - started:.1f}; "
                f"{exc}",
                flush=True,
            )
            if attempt == MODEL_MAX_RETRIES:
                raise
    with ctx.lock:
        totals = ctx.stats["roles"][role]
        totals["model"] = settings["model"]
        totals["model_calls"] += 1
        add_usage(totals, usage)
    # request_chars lets the provider's token counts be compared with what was actually sent.
    print(
        f"Dottore call: role={role}; messages={len(messages)}; "
        f"request_chars={len(json.dumps([messages, tools], ensure_ascii=False))}; "
        f"prompt_tokens={usage_value(usage, 'prompt_tokens')}; "
        f"cached_tokens={usage_value(usage, 'prompt_tokens_details', 'cached_tokens')}; "
        f"completion_tokens={usage_value(usage, 'completion_tokens')}; "
        f"reasoning_tokens={usage_value(usage, 'completion_tokens_details', 'reasoning_tokens')}; "
        f"first_chunk_s={timing.get('first_chunk', 0):.1f}; elapsed_s={time.monotonic() - started:.1f}",
        flush=True,
    )
    return message


def assistant_turn(message, **fields):
    """The assistant message to keep in history, with Claude's original blocks when it sent them."""
    blocks = getattr(message, "claude_blocks", None)
    return {"role": "assistant", **fields, **({"claude_blocks": blocks} if blocks else {})}


def tool_call_key(call):
    try:
        args = json.dumps(json.loads(call.function.arguments or "{}"), sort_keys=True)
    except ValueError:
        args = call.function.arguments
    return call.function.name, args


def run_agent(ctx, role, messages, submit_tool, budget, output_budget):
    """Let one agent read with the tools until it calls its submit tool; return the submitted arguments.

    The budget counts read-tool calls and output_budget their characters; a repeated call is answered
    from the earlier result for free. Once either budget is spent, or the review deadline has passed,
    the model is made to call the submit tool, and a few malformed submissions are tolerated.
    """
    submit = submit_tool["function"]["name"]
    tools = [*READ_TOOLS, submit_tool]
    messages = list(messages)
    used = 0
    spent = 0
    answered = {}
    for turn in range(budget + MAX_SUBMIT_ATTEMPTS):
        forced = (
            used >= budget or spent >= output_budget or turn >= budget or time.monotonic() > ctx.deadline
        )
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
        for call in calls:
            if call.function.name == submit:
                try:
                    submitted = json.loads(call.function.arguments or "{}")
                except ValueError:
                    submitted = None
                if isinstance(submitted, dict):
                    return submitted
                reply = f"refused: {submit} needs one JSON object as its arguments; call it again."
            elif tool_call_key(call) in answered:
                reply = f"Already returned above as tool call {answered[tool_call_key(call)]}; reuse that result."
            elif forced or used >= budget or spent >= output_budget:
                reply = f"refused: the tool budget is spent; call {submit} now."
            else:
                used += 1
                answered[tool_call_key(call)] = used
                with ctx.lock:
                    ctx.stats["roles"][role]["tool_calls"] += 1
                reply = truncate(run_tool(ctx, call.function.name, call.function.arguments), output_budget - spent)
                spent += len(reply)
            messages.append({"role": "tool", "tool_call_id": call.id, "content": reply})
    raise RuntimeError(f"The {role} agent never called {submit}.")


FINDER_FOCUS = {
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
        "happy path. When the diff changes a default, threshold, weight, scale, scope filter or "
        "classifying predicate, follow it to where it combines with other values and test the boundaries: "
        "whether the best result each preset or mode can produce still clears a new threshold, whether "
        "counts, denominators and lookups use the same scope as the items they rank or filter, and whether "
        "a predicate handles mixed or compound inputs as well as the pure case. Leave nitpicks to the broad "
        "segment."
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
    "concrete suspicion once, at its exact changed line, and do not pad. If prior Dottore contracts are "
    "included, first judge whether the current diff satisfies or leaves those contracts incomplete before "
    "issuing adjacent related findings. Findings must point to added/changed RIGHT lines or deleted LEFT "
    "lines; report one finding per line, combining related concerns. Dottore never runs commands, tests "
    "or builds and CI does, so do not report unexecuted checks as a limitation. Record what you checked "
    "in what_i_checked, and name any limitation there instead of inventing certainty."
)


def finder_instructions(role):
    return (
        f"{FINDER_FOCUS[role]} Treat the review packet as the specimen. Use the read-only tools only to "
        "settle a concrete suspicion that depends on code outside the packet, fetching just what it needs; "
        "do not browse, and when the packet is enough, submit without any tool calls. You have at most "
        f"{FINDER_TOOL_BUDGET} tool calls and {FINDER_TOOL_CHARS} characters of tool output, and repeating a "
        f"call returns nothing new. Guidance is listed by heading in the selected guidance index; read_file "
        f"only the sections that bear on a suspicion. {FINDING_RULES} Finish by calling submit_findings."
    )


def staggered(delay, function, *args):
    time.sleep(delay)
    return function(*args)


def run_finders(ctx, packets, pool):
    """Stage 1: run the broad and skeptical segments over every packet concurrently."""
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
            ),
        )
        for packet in packets
        for role in FINDER_ROLES
    ]
    try:
        return [(role, future.result()) for role, future in jobs]
    except Exception:
        for _, future in jobs:
            future.cancel()
        raise


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
        if role == "broad":
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


def evidence_grounded(ctx, evidence):
    """True when at least one quoted snippet appears near its cited line in the head or base file."""
    for item in evidence:
        snippet = evidence_snippet(item.get("snippet"))
        if len(snippet) < 3:
            continue
        line = item.get("line")
        for read in (head_file_text, lambda path: base_file_text(ctx, path)):
            try:
                lines = read(item.get("path")).splitlines()
            except Exception:
                continue
            if isinstance(line, int) and not isinstance(line, bool) and line > 0:
                lines = lines[max(0, line - 1 - EVIDENCE_WINDOW) : line + EVIDENCE_WINDOW]
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
            invalid.append(
                f"{finding.severity} '{finding.title or '<untitled>'}' at "
                f"{finding.path}:{finding.line}: line is not a changed {finding.side} diff line"
            )
            continue
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
                f"`{md_cell(finding.path)}:{finding.line}` ({finding.side}) | "
                f"{md_cell(finding.title)} |"
            )
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
    inline_findings = findings_for_inline_comments(findings)
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
