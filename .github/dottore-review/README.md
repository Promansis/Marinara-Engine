# Configuring Dottore

Code first builds a bundle for each packet of the pull request: the PR description, the changed code at the head with
its changes marked and the code around it, the definitions it reads, the same-file functions it calls two hops deep,
where changed names are used elsewhere, the path rules and a guidance index. Then four roles run, and reading is the
small roles' job:

- **`scout`** reads outward from the bundle with the read-only tools and keeps places as it reads: the callers in other
  files, imported definitions and what the changed values flow into. Each packet's changed functions are split into
  shares, one scout per share, and the scouts run at once, so the reading takes one scout's time. Code quotes the places
  into the bundle. A scout names no defect. A failed scout is noted and its share keeps the code-built bundle.
- **`finder`** makes one call with no tools on the bundle and claims defects at changed lines.
- **`verify`** (the checker) judges the finder's claims, one call per file, with the bundle and the code around each
  candidate in view and a few reads for what is still out of reach. Only confirmed findings are published; a confirmed
  claim whose defect differs from its wording carries the finding text the checker wrote.

On a later review, the checker also re-judges Dottore's open threads on the files that review changed, in parallel
with the finder: one call per packet, with each thread's finding and repair contract. A thread it finds repaired, with
evidence quoted from the head, gets a reply in voice and is resolved; one a person has replied to, or one whose finding
that review raised again, stays open. Threads on files the review left alone are not checked.

The finder and checker send the bundle about once each, so a review's cost is the bundle's size times the models'
prices. A role given reads resends its whole conversation on every turn, so reads belong to the cheapest role that can
use them: the scout. Each `Dottore telemetry:` line reports per role the dollars spent and `prompt_x_bundle`, the prompt
tokens sent per bundle token; a one-call role sits near 1, and a number far above it means a role is reading.

Each role has one prompt section in `reviewer-prompt.md`, which names no model, so any role can run any model. The
models, providers and limits are set with repository settings, under **Settings → Secrets and variables → Actions**, so
changing them needs no code change. A new value applies from the next review. In Marinara-Agents, set them in the
Agents repository: its wrapper workflow passes its own secrets and variables to the shared review.

## Variables

| Variable | What it sets | Default |
| --- | --- | --- |
| `DOTTORE_MODEL` | Model for every role | `gpt-5.5` |
| `DOTTORE_PROVIDER` | API format for every role: `openai` or `anthropic` | `openai` |
| `DOTTORE_REASONING_EFFORT` | Reasoning effort for every role that does not set its own, such as `medium`, `high` or `xhigh` | The provider's default |
| `DOTTORE_MODELS` | Per-role settings as JSON (see below) | None |
| `DOTTORE_FINDERS` | Finder copies per packet, `1` or `2`; a second one starts a few seconds later and reuses the cache | `1` |
| `DOTTORE_COST_LIMIT_USD` | Stop a review's model calls once it has spent this many dollars at the price table in `dottore_review.py`; `0` removes the limit | `1.00` |
| `DOTTORE_BASE_REFS` | Comma-separated base branches that get reviewed | `refactor,main,staging` |
| `DOTTORE_CONCURRENCY` | Model calls run at once | `4` |

`DOTTORE_MODELS` maps `scout`, `finder` or `verify` to any of these settings. A role or setting it leaves out
uses the default.

| Setting | Meaning | `scout` | `finder` | `verify` |
| --- | --- | --- | --- | --- |
| `provider`, `model` | API format and model | shared | shared | shared |
| `effort` | Reasoning effort | shared | shared | shared |
| `reads` | Read-tool calls; `0` offers none | `10` per scout | `0` | `5`, plus 1 per extra candidate |
| `chars` | Characters of tool output | `40000` per scout | `0` | `40000`, plus 4000 per extra candidate |
| `minutes` | Time box, from the role's first call | `5` | `10` | the review's last 8 minutes |
| `max_tokens` | Output cap per call, Claude models only | `16000` | `32000` | `32000` |
| `places` | Places each scout keeps; `0` turns the scouts off | `6` | – | – |
| `scouts` | Scouts per packet, each with a share of its changes; a PR split into packets runs more scouts than `DOTTORE_CONCURRENCY` in turn | `4` | – | – |

Setting `reads` on the finder restores a reading finder, and setting `0` on the checker makes it judge from what is in
view alone and answer uncertain otherwise.

A role's `minutes` also bounds each of its model calls: a role offered no tools thinks before its first byte, so its
call may stay silent for the whole box, and a reply still streaming when the box ends is cut there. A role offered no
tools whose reply runs into `max_tokens` is sent once more at the next lower effort (`max` → `xhigh` → `high` →
`medium` → `low`) with a box of its own; at `low`, or with no effort set, the review fails instead. On Claude, thinking counts inside `max_tokens`, so give a Claude role a larger cap and let `effort`
limit the thinking.

Limits kept in code, in `dottore_review.py`: a 30-minute review (`REVIEW_DEADLINE_SECONDS`), the last 8 minutes of it
reserved for the checker, at most 20 candidates checked per review (`MAX_VERIFIED_CANDIDATES`), 3 submit attempts,
a role aborting after 3 failed calls in a row (`MAX_ROLE_FAILURES`), 180 s for a call's first byte and 360 s between
bytes (`FIRST_CALL_TIMEOUT`, `MODEL_REQUEST_TIMEOUT`), 900 s per streaming reply of a role with tools
(`MODEL_STREAM_LIMIT`; a role without tools gets its box instead), and the packet split for large PRs (`MAX_CHUNK_PATCH_CHARS`, `MAX_REVIEW_CHUNKS`).

## Models per role

The shared model is the one the finder and checker use: they judge, so they take the most capable model available, and
they make one call each, so its price is paid about once per bundle. The scout reads without judging, so a small fast
model at a high effort fits it. For example, GPT for the finder and checker and a small Claude model for the scout:

```json
{
  "scout": { "provider": "anthropic", "model": "claude-haiku-5-5", "effort": "high" }
}
```

### Switching a role's model

Every setting is per role, so the finder and the checker can run one model and the scout another, each with its own
provider, effort, caps and endpoint secrets. Starting values, to be measured on a few known pull requests before
relying on them:

| Role | GPT (Astra, Sol) | Claude Opus or Sonnet | Claude Haiku or GPT Luna |
| --- | --- | --- | --- |
| `finder` | `effort` `high` (measured: `xhigh` costs more for the same recall) | `effort` `high`, `max_tokens` `64000` | not recommended: small models browse without forming claims |
| `verify` | `effort` `xhigh` | `effort` `high`, `max_tokens` `64000` | not recommended |
| `scout` | `effort` `medium` | `effort` `medium`, `max_tokens` `16000` | `effort` `high`, `max_tokens` `16000` |

A larger or slower model needs a larger `max_tokens` (Claude counts thinking inside it) and may need more `minutes`;
the retry at a lower effort covers a reply that still runs into the cap. The cost limit stops a review that would
cost more than expected: at the price table, an Opus finder and checker cost about three times Astra's for the same
tokens, so set `DOTTORE_COST_LIMIT_USD` to what a review may spend before switching. The `Dottore roles:` line at the
start of each run log shows the provider, model and effort each role resolved to.

## Secrets

| Secret | Used for |
| --- | --- |
| `OPENAI_API_KEY` | Required. The key for `openai` roles, and for `anthropic` roles when `ANTHROPIC_API_KEY` is not set |
| `LLM_BASE_URL` | The endpoint for `openai` roles, such as `https://linkapi.ai/v1`. Empty means OpenAI |
| `ANTHROPIC_API_KEY` | Optional key for `anthropic` roles |
| `ANTHROPIC_BASE_URL` | The endpoint for `anthropic` roles, without `/v1`, such as `https://linkapi.ai`. Empty means Anthropic |
| `DOTTORE_<ROLE>_BASE_URL`, `DOTTORE_<ROLE>_API_KEY` | Optional endpoint for one role (`SCOUT`, `FINDER` or `VERIFY`); unset, the role uses the shared one for its provider. A value of `.` counts as unset |

A gateway such as LinkAPI serves both formats with one key, so only the two base URLs need setting.

## Choosing a provider

- **`openai`** sends OpenAI's Chat Completions format. Use it for GPT models and for any model a gateway serves in that format with tool calling.
- **`anthropic`** sends Claude's Messages format. Use it for Claude models, even through a gateway that also offers Chat Completions: Claude's tool calls only work reliably in its own format, and prompt caching and effort work only there.

Effort values pass through unchanged, so use names the model accepts. Claude takes `low`, `medium`, `high`, `xhigh` and `max`, though not every model supports all of them.

The prompts name no model. Before relying on a different model in a role, run a few reviews on pull requests whose
problems you already know and compare what Dottore finds.

Each review logs a `Dottore call:` line per model call, a `Dottore scout:` line per scout and per packet with the places they added, and
a `Dottore telemetry:` line with totals by role. Use them to compare cost, caching and time between setups.
