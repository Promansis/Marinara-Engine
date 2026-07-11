# Long-Term Memory Release-Readiness Plan

Status: approved for phased implementation.

Baseline: `c83d66e6edee6c0a9b3ab3021265461b4ff1a1b1` on
`fix/ltm-staging-port-rebase`.

Progress is recorded in `docs/LTM_RELEASE_READINESS_PROGRESS.md`. That file is
the resume authority for the current phase, validation already completed, and
the next implementation entrypoint.

## Objective

Make long-term-memory capture, persistence, retrieval, prompt injection,
recovery, maintenance, configuration, and observability release-ready without
losing valid existing user data or changing release metadata.

The audit established that the current test suite is broadly green but does
not prove the production generation path. The remediation therefore treats
production reachability, transactional persistence, coherent recovery, prompt
safety, and truthful accounting as end-to-end contracts rather than isolated
service behavior.

## Delivery Rules

- Work on the current branch. Do not rebase, switch branches, push, open a pull
  request, or change version metadata as part of this plan.
- Complete phases in order. A later phase may clarify an earlier design, but it
  must not silently weaken an earlier invariant.
- Make one atomic commit per phase using the listed subject. Each commit
  includes its implementation, tracked regression tests, documentation, and
  progress-log update.
- Do not commit a failing or incomplete phase. Record blockers and partial
  investigation in the progress log without claiming the phase complete.
- Keep server regression tests as tracked `*.spec.ts` files. Do not commit
  temporary `*.test.ts` probes.
- Preserve valid v1 data and existing user content. New formats require
  explicit parsing, compatibility, migration, quarantine, or rebuild behavior.
- Use disposable `DATA_DIR` fixtures for destructive, corrupt-state, import,
  backup, and recovery tests.
- Run the narrowest sensitive proof while iterating. Run the final matrix in
  Phase 11 before declaring the remediation complete.

## Target Architecture

Generation owns recall planning and prompt placement. The managed LTM agent
remains the lifecycle and settings identity shown in the UI; it is not a second
connectionless execution path.

Recall is mode-neutral. Conversation, Roleplay, Visual Novel, and Game can all
recall with or without a preset. Presets may control placement through the LTM
marker, but they do not control whether recall runs.

Retrieved memory stays structured through context fitting. Untrusted memory is
escaped, macro-opaque, fully budgeted in its final serialized form, and either
retained or removed as a complete block. A durable per-chat receipt and usage
record are written only after the final provider payload has been accepted for
dispatch.

The vault uses canonical note-ID locking and recoverable mutation
transactions. Index state publishes coherent generations, validates every
family before activation, quarantines corrupt state, and never mixes files
from different generations.

Global recall settings live in `config/settings.json`. Chat metadata stores
only sparse overrides. Retrieval uses absolute relevance for eligibility and
RRF only for ordering. Archived notes are never eligible, direct note-ID and
tag matches are candidates in their own right, and mandatory policies have a
runtime owner.

## Compatibility Decisions

- Existing valid notes, links, drafts, source records, settings, and backups
  remain readable.
- A v2 extraction fingerprint covers source text/evidence, provenance, scope,
  enabled modes, and extraction mode. Pre-v2 pending drafts remain readable
  but cannot be applied until the source is re-extracted with bound context.
- Full-backup import restores LTM only through an explicit opt-in workflow.
  Derived indexes are never trusted from an imported backup.
- Retrieval scaling uses bounded exact candidate search in this remediation.
  No ANN dependency or index format is introduced.
- Debug logs remain diagnostic. They are not the source of truth for injection
  receipts or cooldown accounting.

## Phase 0: Documentation Baseline

Commit: `docs(ltm): plan release-readiness remediation`

Create this implementation plan and the companion progress log. Capture the
baseline audit evidence, architectural decisions, phase boundaries, commit
subjects, validation matrix, and resume protocol before runtime changes begin.

Acceptance:

- Every confirmed audit finding has an owning phase.
- The progress log identifies the exact baseline, current phase, next
  entrypoint, and commands already run.
- Markdown paths and commands match the current checkout.
- `git diff --check` passes and only the two planning documents are committed.

## Phase 1: Security and Managed-Agent Lifecycle

Commit: `fix(ltm): secure routes and managed agent lifecycle`

Apply the privileged-access guard consistently to transfer preview, integrity,
and import preview. Add negative LAN-auth route coverage matching already
guarded LTM routes.

Make the managed LTM agent a singleton lifecycle identity. Prevent generic
delete and duplicate actions, keep schema-valid settings from disabling its
management surface, and remove connectionless-executor claims that contradict
the intended generation-owned architecture.

Acceptance:

- All private LTM read, preview, integrity, import, export, and mutation routes
  enforce the same privileged boundary.
- The managed agent cannot be deleted or duplicated through client or server
  APIs, and an existing valid managed row remains usable.
- Focused route, agent-schema, and lifecycle specs pass, including unauthorized
  negative controls.

## Phase 2: Transactional Vault Mutations

Commit: `fix(ltm): make vault mutations transactional`

Canonicalize all same-note locks on note ID. Introduce a recoverable mutation
transaction for create, update, project, archive, and permanent delete so note,
link, dirty-state, and event changes publish in commit order.

Mark retrieval state stale before any irreversible deletion, clean dangling
links as part of the transaction, and write events only after successful
commit. Add recovery for an interrupted transaction and invalidate cached
retrieval state by durable revision rather than process lifetime.

Acceptance:

- Concurrent projection and update cannot overwrite a newer note version.
- Partial unlink failure cannot leave deleted content retrievable.
- Permanent deletion removes or repairs inbound and outbound links, and
  integrity reports the result accurately.
- Failed mutations emit no success event; interrupted transactions recover to
  either the before-state or committed after-state.

## Phase 3: Coherent Index Recovery

Commit: `fix(ltm): recover coherent index generations`

Parse state defensively, quarantine malformed state and index artifacts, and
select only a completely validated generation. Treat every index family and
its manifest as one publication unit. If no coherent generation exists,
rebuild from canonical notes instead of mixing generation files.

Repair must work when `state.json` itself is malformed. Remove unread legacy
flat-index writes once compatibility is proven unnecessary, and make cache
keys include the active durable generation or revision.

Acceptance:

- Rebuild and Repair recover malformed state without discarding valid notes.
- Missing or corrupt source, typed, vector, or keyword families cannot produce
  a mixed generation.
- Publication failure leaves the prior coherent generation active.
- Restart and in-process cache tests observe the same recovered generation.

## Phase 4: Context-Bound Capture and Refresh

Commit: `fix(ltm): make extraction refreshable and context-bound`

Replace the extracted boolean shortcut with source freshness based on a v2
fingerprint. Bind drafts to provenance, chat/group/character scope, enabled
modes, and extraction mode. Require re-extraction before applying a legacy
context-unbound pending draft.

Keep useful pending mutations when a retry returns diagnostics only. Do not
mark a source current after zero-mutation failure. Make card, lorebook,
summary, journal, and game-journal refresh paths hash the same authoritative
source used for extraction.

Capture missing durable character fields. Extract large lorebooks as stable
entry units under a 6,000-token per-call budget so edits refresh deterministically
without truncating the whole source.

Acceptance:

- Editing an imported source makes it refreshable in both API status and UI.
- Scope, group, mode, provenance, or extraction-mode changes invalidate a
  pending draft.
- A diagnostic-only retry cannot supersede useful pending work or mark the
  source successfully extracted.
- Large lorebook and live game-journal fixtures refresh deterministically.

## Phase 5: Recall Settings, Eligibility, and Relevance

Commit: `fix(ltm): correct recall eligibility and relevance`

Establish one settings authority: resolved global defaults plus sparse chat
overrides. Selecting a recall style must apply that style's complete numeric
profile unless the user explicitly edits an individual override.

Always exclude archived notes, pass group scope, and wire mandatory-injection
policies to the runtime planner. Add direct candidate lanes for exact note ID
and tag matches. Use absolute vector/keyword relevance for eligibility and RRF
only to order already eligible candidates.

Acceptance:

- Exact, Balanced, Broad, and Story resolve to their documented weights after
  global/chat merging.
- Archived and out-of-scope notes cannot be recalled; group-scoped notes can
  be recalled only by the matching group.
- An arbitrarily weak best vector match fails a high relevance threshold.
- Exact ID/tag-only queries return eligible direct matches.
- Mandatory policies are exercised by runtime tests rather than dead config.

## Phase 6: Safe Prompt Artifacts and Truthful Receipts

Commit: `fix(ltm): make prompt injection and receipts truthful`

Represent recalled chunks as a structured prompt artifact until final context
fitting. XML-escape untrusted fields and prevent memory leaves from macro
expansion. Budget preamble, wrappers, separators, and content using the final
serialization. Fit or remove the whole LTM artifact atomically.

Move usage and receipt creation after final payload construction and the first
successful provider dispatch. Key cooldown usage by chat and chunk. Make
telemetry failure non-fatal and quarantine malformed usage data. Drive Last
Injection from durable receipts rather than optional debug events.

Acceptance:

- Closing tags, role-like text, and `{{user}}` remain inert memory content in
  marker and fallback placement.
- The serialized artifact never exceeds its assigned budget and is never
  partially truncated by context fitting.
- Failed fitting or dispatch records no injection or cooldown usage.
- Successful dispatch records the exact chunks present in that chat's final
  payload, regardless of debug mode.
- Corrupt usage or receipt files do not suppress an otherwise valid injection.

## Phase 7: Mode-Neutral Production Recall

Commit: `fix(ltm): enable mode-neutral generation recall`

Create one generation recall orchestrator outside preset and mode guards. Pass
chat, group, character, names, embedding source, settings, and abort signal
from the production request. Let a preset marker select placement only; use the
safe fallback when no marker or preset exists.

Remove the duplicate unguarded settings read and reconcile or delete unused
helper injection paths. Keep fail-open behavior for optional recall failures
without hiding aborts or provider errors.

Acceptance:

- Route-level tests prove recall reaches final provider payloads in
  Conversation, Roleplay, Visual Novel, and Game, with and without presets.
- Group scope and request cancellation propagate through the production path.
- The managed LTM agent is not separately executed by the agent pipeline.
- Helper-level and production-path tests exercise the same orchestrator.

## Phase 8: Truthful Client Behavior and Accessibility

Commit: `fix(ltm): align recall controls with runtime behavior`

Make enabled state, style controls, selected-chat Test Recall, import freshness,
and Last Injection reflect the server contracts. Include keyword weight in test
recall. Flush or explicitly save debounced chat overrides before navigation and
unmount.

Protect managed-agent actions in every client surface and complete keyboard,
label, focus, loading, empty, and error states for touched LTM controls. Preserve
existing tokens, responsive behavior, and React Query ownership.

Acceptance:

- Test Recall uses the selected chat, its group/mode/scope, and all resolved
  weights.
- Rapid edits survive unmount/navigation and reload with the same values.
- Enabled and Last Injection states match runtime truth.
- Desktop and mobile browser tests cover refresh, managed-agent actions,
  loading/error states, keyboard operation, and accessible names.

## Phase 9: Consistent Full-Backup Restore

Commit: `fix(backup): restore long-term memory safely`

Add explicit opt-in LTM restore to full-backup import. Take a consistent vault
snapshot, validate and stage canonical LTM data, discard all derived indexes,
publish the restored root atomically, rebuild, and verify integrity. Roll back
the complete LTM root if staging, publication, rebuild, or verification fails.

Acceptance:

- Default full-backup import leaves current LTM untouched.
- Opt-in restore round-trips notes, links, settings, source records, applicable
  drafts, usage/receipts where valid, and required metadata.
- Imported derived indexes are ignored and rebuilt locally.
- Injected failure at every publication boundary restores the prior root.
- Backup taken during concurrent mutation represents one coherent snapshot.

## Phase 10: Bounded Exact Retrieval and Dead-Path Cleanup

Commit: `perf(ltm): bound retrieval and remove legacy paths`

Build bounded exact candidate sets from maintained metadata, scope/status,
keyword, direct-match, and vector catalogs before scoring. Reuse embeddings by
stable source/chunk hash during rebuild. Add retention for usage, receipts,
events, incomplete generations, and obsolete quarantined artifacts.

Remove dead generation-injection helpers, the unused feature-panel registry,
the disabled connectionless support surface, unread legacy index output, and
policy/config branches made obsolete by the authoritative paths. Do not add an
ANN dependency.

Acceptance:

- Retrieval results remain deterministic and equivalent on a fixed relevance
  corpus while candidate work is bounded by configured limits.
- Unchanged chunks reuse embeddings during rebuild.
- Retention cannot remove data needed by the active generation, pending
  recovery, or configured audit window.
- Static call-site checks and tests prove removed surfaces have no consumers.

## Phase 11: Final Release-Readiness Proof

Commit: `test(ltm): validate release-readiness remediation`

Add an authoritative end-to-end regression matrix that follows production
capture, draft application, rebuild, recall, final prompt fitting, provider
dispatch, receipt creation, deletion, restart, and restore. Include positive
and negative controls for every mode, preset state, scope, corruption class,
auth boundary, and dispatch outcome addressed by this plan.

Update the progress log with exact results and remaining manual proof. Reconcile
all LTM docs with final behavior. Do not change versions or claim release
readiness if any required automated row fails.

Required final commands:

```bash
pnpm test
pnpm --filter @marinara-engine/server test
pnpm regression:prompt
pnpm exec playwright test -c playwright.config.ts e2e/core-flows.e2e.ts --grep "LTM|memory recall"
pnpm smoke:ui
pnpm check
git diff --check
```

Acceptance:

- Every tracked server LTM spec is discovered and passes.
- Production route tests prove final-payload presence and post-dispatch
  accounting rather than helper-only behavior.
- Prompt and browser regressions pass with expected skips explained.
- Static analysis and production builds pass; pre-existing advisories are
  distinguished from regressions.
- The progress log contains the final commit ledger, exact proof counts,
  residual risks, and manual verification still required.

## Finding Ownership Matrix

| Audit finding | Owning phase |
| --- | --- |
| Unguarded private-data routes | Phase 1 |
| Deletable/duplicable or disabled managed agent | Phase 1 |
| Partial deletion leaves injectable cache | Phase 2 |
| Same-note lost updates and false events | Phase 2 |
| Dangling links and misleading integrity | Phase 2 |
| Corrupt state and mixed index generations | Phase 3 |
| Indefinite cache and unread legacy indexes | Phases 3 and 10 |
| Imported sources cannot refresh | Phase 4 |
| Diagnostic retry supersedes useful work | Phase 4 |
| Draft freshness omits scope and mode | Phase 4 |
| Incomplete character/lorebook/journal capture | Phase 4 |
| Stale recall-style weights | Phase 5 |
| Archived notes, missing group, dead policies | Phase 5 |
| Query-relative threshold and metadata-only miss | Phase 5 |
| Prompt breakout and macro expansion | Phase 6 |
| Budget undercount and post-fit disappearance | Phase 6 |
| Premature/global usage and false Last Injection | Phase 6 |
| Conversation and presetless recall unwired | Phase 7 |
| Duplicate settings read and unused injection helpers | Phases 7 and 10 |
| Selected-chat test recall and debounce gaps | Phase 8 |
| Client error/accessibility proof gaps | Phase 8 |
| Inconsistent backup and unproven restore | Phase 9 |
| Full scans, full re-embedding, and debris growth | Phase 10 |
| Helper-only/conditional automated proof | Phase 11 |

## Phase Checkpoint Protocol

At the end of each phase:

1. Update the Resume Here block and phase ledger in the progress document.
2. Record changed behavior, migrations/compatibility, exact validation commands,
   pass/fail counts, skipped proof, and residual risk.
3. Review `git diff --check`, `git status --short`, and the staged diff.
4. Commit only the phase's code, tests, docs, and progress update with the listed
   subject.
5. Record the resulting commit hash in the progress document at the start of
   the next phase. A commit cannot contain its own hash.
