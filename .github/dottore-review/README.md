# Configuring Dottore

Dottore reviews pull requests in three roles:

- **`finder`** reads each part of the diff and proposes problems. The lab can split that work between two finders, **`broad`** and **`skeptic`**, instead.
- **`verify`** checks every proposed problem against the code before anything is posted.
- **`scout`** reads code for the finders when they ask, on a cheaper model (`gpt-6-luna` through `responses` by default).

The models and providers that run these roles are set with repository settings, under **Settings → Secrets and variables → Actions**, so changing them needs no code change. A new value applies from the next review. In Marinara-Agents, set them in the Agents repository: its wrapper workflow passes its own secrets and variables to the shared review.

## Variables

| Variable | What it sets | Default |
| --- | --- | --- |
| `DOTTORE_MODEL` | Model for every role | `gpt-5.5` |
| `DOTTORE_PROVIDER` | API format for every role: `openai` (Chat Completions), `responses` (OpenAI Responses) or `anthropic` | `openai` |
| `DOTTORE_REASONING_EFFORT` | Reasoning effort for every role, such as `medium`, `high` or `xhigh` | The provider's default |
| `DOTTORE_MODELS` | Per-role overrides as JSON (see below) | None |
| `DOTTORE_BASE_REFS` | Comma-separated base branches that get reviewed | `refactor,main,staging` |
| `DOTTORE_CONCURRENCY` | Model calls run at once | `4` |

`DOTTORE_MODELS` maps a role to any of `provider`, `model` and `effort`. A role or field it leaves out uses the defaults above. For example, GPT finders with a Claude checker:

```json
{
  "finder": { "model": "gpt-6.1-sol", "effort": "high" },
  "verify": { "provider": "anthropic", "model": "claude-opus-5-5", "effort": "high" }
}
```

## Secrets

| Secret | Used for |
| --- | --- |
| `OPENAI_API_KEY` | Required. The key for `openai` roles, and for `anthropic` roles when `ANTHROPIC_API_KEY` is not set |
| `LLM_BASE_URL` | The endpoint for `openai` roles, such as `https://linkapi.ai/v1`. Empty means OpenAI |
| `ANTHROPIC_API_KEY` | Optional key for `anthropic` roles |
| `ANTHROPIC_BASE_URL` | The endpoint for `anthropic` roles, without `/v1`, such as `https://linkapi.ai`. Empty means Anthropic |

A gateway such as LinkAPI serves both formats with one key, so only the two base URLs need setting.

## Choosing a provider

- **`openai`** sends OpenAI's Chat Completions format. Use it for GPT models and for any model a gateway serves in that format with tool calling.
- **`anthropic`** sends Claude's Messages format. Use it for Claude models, even through a gateway that also offers Chat Completions: Claude's tool calls only work reliably in its own format, and prompt caching and effort work only there.

Effort values pass through unchanged, so use names the model accepts. Claude takes `low`, `medium`, `high`, `xhigh` and `max`, though not every model supports all of them.

The prompt was tuned on GPT models. Before relying on a different model, run a few reviews on pull requests whose problems you already know and compare what Dottore finds.

Each review logs a `Dottore call:` line per model call and a `Dottore telemetry:` line with totals by role. Use them to compare cost, caching and time between setups. Each call line also shows what the review has spent so far at LinkAPI's prices, and a review makes no further model calls once it has spent $0.25.
