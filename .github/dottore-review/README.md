# Configuring Dottore

Code first builds a bundle for each packet of the pull request: the PR description, the changed code at the head with
its changes marked and the code around it, the definitions it reads, the same-file functions it calls two hops deep,
where changed names are used elsewhere, the path rules and a guidance index. Then three roles run:

- **`finder`** reads the bundle and the rest of the repository with read-only tools and claims defects at changed lines.
- **`asker`** makes one call with no tools and writes check questions: a place, an input and what should happen. It runs
  beside the finder and names no verdict. A failed asker is noted in the review; a failed finder fails the review.
- **`verify`** (the checker) judges the finder's claims and the asker's questions together, one call per file, with
  the bundle in view and read-only tools. Only confirmed findings are published, and a confirmed question carries the
  finding text the checker wrote.

Each role has one prompt section in `reviewer-prompt.md`, which names no model, so any role can run any model. The
models, providers and limits are set with repository settings, under **Settings → Secrets and variables → Actions**, so
changing them needs no code change. A new value applies from the next review. In Marinara-Agents, set them in the
Agents repository: its wrapper workflow passes its own secrets and variables to the shared review.

## Variables

| Variable | What it sets | Default |
| --- | --- | --- |
| `DOTTORE_MODEL` | Model for every role | `gpt-5.5` |
| `DOTTORE_PROVIDER` | API format for every role: `openai` or `anthropic` | `openai` |
| `DOTTORE_REASONING_EFFORT` | Reasoning effort for the finder and checker, such as `medium`, `high` or `xhigh` | The provider's default |
| `DOTTORE_MODELS` | Per-role settings as JSON (see below) | None |
| `DOTTORE_FINDERS` | Finder copies per packet, `1` or `2`; a second one starts a few seconds later and reuses the cache | `1` |
| `DOTTORE_COST_LIMIT_USD` | Stop a review's model calls once it has spent this many dollars at the table in `dottore_review.py` | No limit |
| `DOTTORE_BASE_REFS` | Comma-separated base branches that get reviewed | `refactor,main,staging` |
| `DOTTORE_CONCURRENCY` | Model calls run at once | `4` |

`DOTTORE_MODELS` maps `finder`, `asker` or `verify` to any of these settings. A role or setting it leaves out uses the
default.

| Setting | Meaning | `finder` | `asker` | `verify` |
| --- | --- | --- | --- | --- |
| `provider`, `model` | API format and model | shared | shared | shared |
| `effort` | Reasoning effort | shared | `low` | shared |
| `reads` | Read-tool calls; `0` offers none | `100` | `0` | `20`, plus 1 per extra candidate |
| `chars` | Characters of tool output | `400000` | `0` | `96000`, plus 6000 per extra candidate |
| `minutes` | Time box, from the role's first call | `15` | `10` | the review's last 8 minutes |
| `max_tokens` | Output cap per call, Claude models only | `32000` | `32000` | `32000` |
| `questions` | Questions per packet; `0` turns the asker off | – | `8` | – |

The finder and checker must be able to hold a long tool loop and judge precisely; on the lab benchmark only the largest
GPT model did both. The asker is one call with no tools, so a small fast model fits it; give a small model a higher
effort (`high`) and a large one a low effort with a larger `max_tokens` (`48000`). For example, GPT for the finder and
checker and a small Claude model as the asker:

```json
{
  "asker": { "provider": "anthropic", "model": "claude-haiku-5-5", "effort": "high" }
}
```

## Secrets

| Secret | Used for |
| --- | --- |
| `OPENAI_API_KEY` | Required. The key for `openai` roles, and for `anthropic` roles when `ANTHROPIC_API_KEY` is not set |
| `LLM_BASE_URL` | The endpoint for `openai` roles, such as `https://linkapi.ai/v1`. Empty means OpenAI |
| `ANTHROPIC_API_KEY` | Optional key for `anthropic` roles |
| `ANTHROPIC_BASE_URL` | The endpoint for `anthropic` roles, without `/v1`, such as `https://linkapi.ai`. Empty means Anthropic |
| `DOTTORE_<ROLE>_BASE_URL`, `DOTTORE_<ROLE>_API_KEY` | Optional endpoint for one role (`FINDER`, `ASKER` or `VERIFY`); unset, the role uses the shared one for its provider. A value of `.` counts as unset |

A gateway such as LinkAPI serves both formats with one key, so only the two base URLs need setting.

## Choosing a provider

- **`openai`** sends OpenAI's Chat Completions format. Use it for GPT models and for any model a gateway serves in that format with tool calling.
- **`anthropic`** sends Claude's Messages format. Use it for Claude models, even through a gateway that also offers Chat Completions: Claude's tool calls only work reliably in its own format, and prompt caching and effort work only there.

Effort values pass through unchanged, so use names the model accepts. Claude takes `low`, `medium`, `high`, `xhigh` and `max`, though not every model supports all of them.

The prompts name no model, but the benchmark ran on GPT finders and checkers. Before relying on a different model, run a few reviews on pull requests whose problems you already know and compare what Dottore finds.

Each review logs a `Dottore call:` line per model call and a `Dottore telemetry:` line with totals by role. Use them to compare cost, caching and time between setups.
