# Long-Term Memory Release-Readiness Progress

This is the resumable implementation ledger for
`docs/LTM_RELEASE_READINESS_PLAN.md`. Update it during every phase. Keep the
Resume Here section short and current; keep completed phase records durable.

## Resume Here

- Branch: `fix/ltm-staging-port-rebase`
- Audit baseline: `c83d66e6edee6c0a9b3ab3021265461b4ff1a1b1`
- Current phase: Phase 11 - Final Release-Readiness Proof
- State: Phase 11 implementation and all required automated proof are complete
  locally; the phase commit is pending.
- Next entrypoint: review and commit Phase 11 as
  `test(ltm): validate release-readiness remediation`.
- Uncommitted scope: Phase 11 production lifecycle regression matrix,
  mode/preset dispatch receipt assertions, and final readiness ledger.
- Blockers: no automated blocker. Final readiness remains conditional on the
  manual production-scale, desktop, Android/Termux, interrupted-write, and
  process-interruption proof gaps recorded below.

## Non-Negotiable Decisions

- Work and commit on the current branch, one green atomic commit per phase.
- Generation owns recall; the managed LTM agent is lifecycle/settings identity.
- Recall is available in every supported mode with or without a preset.
- Memory stays structured, escaped, macro-opaque, and atomic through final fit.
- Usage and durable per-chat receipts are written only after provider dispatch
  accepts the final payload.
- Vault mutations use canonical note-ID locks and recoverable transactions.
- Index recovery activates one fully coherent generation or rebuilds from
  canonical notes.
- v2 extraction freshness includes content, provenance, scope, modes, and
  extraction mode. Context-unbound legacy drafts require re-extraction.
- Full-backup LTM restore is explicit opt-in and rebuilds derived indexes.
- Scaling uses bounded exact retrieval, not a new ANN dependency.
- Preserve valid v1 data; do not change release/version metadata.

## Baseline Evidence

Audit performed read-only at `c83d66e6`:

| Proof                           | Baseline result                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tracked server LTM suites       | 322 passed, 0 failed; all 19 tracked specs discovered                                                                                                                                                     |
| Deterministic prompt regression | Passed                                                                                                                                                                                                    |
| Focused LTM Playwright flow     | 11 passed, 11 expected project-specific skips                                                                                                                                                             |
| `pnpm check`                    | Passed lint, TypeScript, and production builds; existing Vite large-chunk advisory remained                                                                                                               |
| Negative controls               | Reproduced reachability, deleted-cache recall, lost update, prompt breakout, auth bypass, stale weights, weak relevance, budget, corruption, mixed-generation, dangling-link, event, and receipt failures |
| Worktree after audit            | Clean                                                                                                                                                                                                     |

This evidence describes the unremediated baseline. It must not be reused as
proof that a later implementation phase passes.

## Phase Ledger

| Phase                                              | State                               | Commit               | Validation summary                                                                                                                                                |
| -------------------------------------------------- | ----------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 - Documentation baseline                         | Complete                            | Commit subject below | Direct path checks and `git diff --check` passed                                                                                                                  |
| 1 - Security and managed-agent lifecycle           | Complete                            | Commit subject below | Focused route/lifecycle proof, server suite, static build, and prompt regression passed; one unrelated browser smoke failure recorded                             |
| 2 - Transactional vault mutations                  | Complete                            | Commit subject below | Focused transaction/recovery proof, affected LTM suites, full server suite, prompt regression, and static validation passed                                       |
| 3 - Coherent index recovery                        | Committed locally (`941b20d0`)      | Complete             | Focused corruption/recovery proof, 334-test server suite, prompt regression, and static/build validation passed                                                   |
| 4 - Context-bound capture and refresh              | Committed locally (`d7592ca0`)      | Complete             | Focused import/freshness/route proof, 339-test server suite, prompt regression, static/build validation, and targeted desktop/mobile browser flows passed         |
| 5 - Recall settings, eligibility, and relevance    | Committed locally (`881027c8`)      | Complete             | Focused 135-test LTM proof, 343-test server suite, prompt regression, static/build validation, and an isolated desktop LTM settings flow passed                   |
| 6 - Safe prompt artifacts and truthful receipts    | Committed locally (`d06bca17`)      | Complete             | Focused artifact/receipt proof, 350-test server suite, prompt regression, static/build validation, and durable Last Injection route proof passed                  |
| 7 - Mode-neutral production recall                 | Committed locally (`1efa7658`)      | Complete             | Focused orchestrator and live provider-payload proof across every mode/preset state, 353-test server suite, prompt regression, and static/build validation passed |
| 8 - Truthful client behavior and accessibility     | Committed locally (`5ced1bc7`)      | Complete             | Focused 146-test LTM proof, prompt regression, static/build validation, and 36-test desktop/mobile browser smoke passed                                           |
| 9 - Consistent full-backup restore                 | Complete                            | Commit subject below | Focused snapshot/restore and ZIP route proof, tracked LTM specs, prompt regression, static/build validation, and browser smoke passed                             |
| 10 - Bounded exact retrieval and dead-path cleanup | Committed locally (`3df16606`)      | Complete             | 362 tracked LTM tests, prompt regression, client/server builds, browser smoke, and `pnpm check` passed                                                            |
| 11 - Final release-readiness proof                 | Implemented locally; commit pending | Pending              | 365 tracked LTM tests, root/server test commands, prompt regression, targeted browser proof, full browser smoke, and `pnpm check` passed                          |

## Phase Records

### Phase 0 - Documentation Baseline

Started: 2026-07-11

Completed: 2026-07-11

Baseline HEAD: `c83d66e6edee6c0a9b3ab3021265461b4ff1a1b1`

Scope:

- Added the phased release-readiness implementation plan.
- Added this resumable progress ledger.
- Recorded architecture choices, compatibility rules, finding ownership,
  commit boundaries, and final validation requirements.

Changed behavior: none; documentation only.

Validation:

| Command                                                    | Result |
| ---------------------------------------------------------- | ------ |
| `git diff --check`                                         | Passed |
| Direct referenced-path checks                              | Passed |
| Phase, commit-subject, and resume-section checks with `rg` | Passed |

The workflow-recommended `marinara-doc-check` executable is not installed in
this environment, so it could not be run. No checked-in equivalent script was
found in the current package manifests.

Commit subject: `docs(ltm): plan release-readiness remediation`

Commit hash: record at the start of Phase 1; a commit cannot contain its own
hash.

Residual risk: all audited runtime defects remain until their owning phases are
implemented and proven.

Next entrypoint: begin Phase 1 with unauthorized route-level tests for the three
unguarded private-data endpoints, then align managed-agent lifecycle guards.

### Phase 1 - Security and Managed-Agent Lifecycle

Started: 2026-07-11

Completed: 2026-07-11

Baseline HEAD: `bf3f62bb5982bdb8aa5cc9f48d9148a3ccec02dc`

Commit: record at the start of Phase 2; this atomic commit cannot contain its
own hash.

Scope:

- Applied the privileged boundary to transfer preview, integrity, and import
  preview, with authenticated-LAN negative controls that reach the route gate.
- Made the LTM managed row a singleton lifecycle identity: generic create,
  copy-type variants, and delete requests are rejected; direct storage creation
  reuses the existing row; schema-valid updates retain its enabled management
  surface.
- Removed the obsolete LTM connectionless executor and excluded managed rows
  from normal and retry agent resolution. Updated the Agents panel so managed
  rows remain visible but cannot be copied, deleted, bulk-selected, or dragged
  into folders.
- Aligned the managed-agent maintainer guidance with generation-owned recall.

Compatibility and migration:

- Existing valid managed rows retain their current IDs and remain editable by
  type or ID. New managed rows use a stable lifecycle ID; no schema migration
  or user-data rewrite is required.
- A legacy `deletedFromLibrary` marker no longer hides a managed row in the
  Agents panel and is cleared on managed settings writes.

Validation:

| Command                                                                                                                                                                                | Result                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/routes.spec.ts src/services/long-term-memory/__tests__/managed-agent-lifecycle.spec.ts` | Passed: 19 tests, 0 failed                                                                                                                                 |
| `pnpm --filter @marinara-engine/server test`                                                                                                                                           | Passed: 325 tests, 0 failed                                                                                                                                |
| `pnpm --filter @marinara-engine/server lint`                                                                                                                                           | Passed TypeScript validation                                                                                                                               |
| `pnpm check`                                                                                                                                                                           | Passed Impeccable context check, workspace lint, TypeScript, and production builds                                                                         |
| `pnpm regression:prompt`                                                                                                                                                               | Passed deterministic prompt and mode regression checks                                                                                                     |
| Isolated Playwright rerun on ports 5180/7973                                                                                                                                           | 17 passed, 14 expected skips, 1 unrelated failure: `manual memory recovery survives dismissing the create modal` left `Remove all` visible after dismissal |
| `git diff --check`                                                                                                                                                                     | Passed                                                                                                                                                     |
| `marinara-doc-check`                                                                                                                                                                   | Not installed; no checked-in equivalent command is available                                                                                               |

Manual proof: not completed. Verify the Long-Term Memory card in the Agents
panel on desktop and mobile: it remains reachable, has no copy/delete controls,
and its dedicated editor remains usable.

Residual risk: Phase 7 still owns production generation recall. This phase
intentionally removes the contradictory managed-agent execution path, so it
does not itself prove generation payload injection. The isolated browser failure
does not execute the changed route, resolver, or Agents-panel action paths and
was not changed in this phase.

Next entrypoint: inspect `packages/server/src/lib/concurrency.ts` and
`packages/server/src/services/long-term-memory/storage.ts` for canonical
note-ID locking and recoverable mutation transaction boundaries.

### Phase 2 - Transactional Vault Mutations

Started: 2026-07-11

Completed: 2026-07-11

Baseline HEAD: `69c695ca65af4b3776064d91c966edf8023439ef`

Commit: record at the start of Phase 3; this atomic commit cannot contain its
own hash.

Scope:

- Added a durable LTM mutation journal with pre-commit rollback and
  post-commit roll-forward recovery. Events carry stable IDs, publish only
  after the vault commit, and are replayed idempotently after an interruption.
- Canonicalized vault mutation locking on note IDs, added a per-vault mutation
  lock, and moved create, update, projection, archive-through-update, and
  permanent deletion onto the transaction path.
- Made permanent deletion repair inbound links in the same transaction, mark
  retrieval state dirty before an unlink, and defer its delete and link-repair
  events until the data commit succeeds.
- Keyed retrieval bundles by persisted index revision. When indexes are dirty,
  retrieval checks canonical vault-note existence so a warm bundle cannot
  return a deleted note.
- Added focused recovery, event, link-integrity, warm-cache, and concurrent
  projection/update regression coverage.

Compatibility and migration:

- Existing valid v1 notes, event logs, settings, and indexes remain readable;
  an absent transaction directory is created on initialization without a data
  rewrite.
- Interrupted Phase 2 journals are self-contained snapshots under
  `long-term-memory/transactions`. Pre-commit journals restore their
  before-state; committed journals restore their after-state and only append
  missing event IDs.

Validation:

| Command                                                                                                                                                                    | Result                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/mutation-transactions.spec.ts`                                              | Passed: 4 tests, 0 failed                                                                                                       |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/routes.spec.ts src/services/long-term-memory/__tests__/maintenance.spec.ts` | Passed: 47 tests, 0 failed                                                                                                      |
| `pnpm --filter @marinara-engine/server test`                                                                                                                               | Passed: 329 tests, 0 failed                                                                                                     |
| `pnpm --filter @marinara-engine/server lint`                                                                                                                               | Passed TypeScript validation                                                                                                    |
| `pnpm regression:prompt`                                                                                                                                                   | Passed deterministic prompt, macro, lorebook, summary, and mode regressions                                                     |
| `pnpm check`                                                                                                                                                               | Passed Impeccable context check, workspace lint, TypeScript, and production builds; existing Vite large-chunk advisory remained |
| `git diff --check`                                                                                                                                                         | Passed                                                                                                                          |
| `marinara-doc-check`                                                                                                                                                       | Not installed; no checked-in equivalent command is available                                                                    |

Manual proof: not completed. Simulate an interrupted write on the supported
desktop and Android/Termux filesystems, restart the server, and verify that a
pending journal either rolls back or completes without duplicate event rows.

Residual risk: the transaction tests prove deterministic journal recovery but
not an actual power-loss/filesystem-crash sequence on every supported runtime.
Phase 3 still owns malformed index-state quarantine and coherent-generation
selection.

Next entrypoint: begin Phase 3 in `packages/server/src/services/long-term-memory/index-state.ts`,
`index-generation.ts`, and the maintenance/retrieval cache tests; preserve the
Phase 2 durable revision contract while making state and generation loading
defensive.

### Phase 3 - Coherent Index Recovery

Started: 2026-07-11

Completed: 2026-07-11 locally; committed as `941b20d0`

Baseline HEAD: `9f9d74ce816196a3521fc50d1d07454d5d49fa77`

Commit: `941b20d0` (`fix(ltm): recover coherent index generations`)

Scope:

- Added defensive index-state recovery: malformed `state.json` is quarantined,
  replaced with a dirty state carrying a fresh durable revision, and can then
  rebuild or repair from canonical notes.
- Added index-artifact quarantine for malformed pointers and invalid generation
  directories. Generation loading validates typed and source families together,
  so a missing or corrupt metadata, vector, keyword, or source artifact cannot
  be combined with another generation.
- Made publication validate the complete staged generation before atomically
  replacing the current pointer. Partial rebuilds reuse only a fully validated
  generation and rebuild missing families from canonical notes.
- Keyed retrieval caching by both durable state revision and the validated
  active generation. A warm process revalidates the active generation before
  returning a cache entry, allowing it to fall back coherently after on-disk
  corruption.
- Removed unread flat-index and root-manifest writes. Updated affected legacy
  tests to inspect generation artifacts through the index APIs instead.

Compatibility and migration:

- Existing canonical notes remain the rebuild source and are not discarded when
  state or derived index artifacts are quarantined.
- Existing flat index files are left untouched but are no longer written or
  used as a read path. Generation directories and pointer history remain the
  compatibility source for derived index recovery.
- A valid fallback generation stays selected through pointer history; no
  unreferenced or partial generation is activated.

Validation:

| Command                                                                                                                | Result                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/maintenance.spec.ts`    | Passed: 35 tests, 0 failed; covers malformed state, pointer, repair, complete-generation fallback, warm-cache recovery, publication failure, and no flat output |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/reconciliation.spec.ts` | Passed: 117 tests, 0 failed                                                                                                                                     |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/routes.spec.ts`         | Passed: 17 tests, 0 failed                                                                                                                                      |
| `pnpm --filter @marinara-engine/server test`                                                                           | Passed: 334 tests, 0 failed                                                                                                                                     |
| `pnpm --filter @marinara-engine/server lint`                                                                           | Passed TypeScript validation                                                                                                                                    |
| `pnpm regression:prompt`                                                                                               | Passed deterministic prompt, macro, lorebook, summary, and mode regressions                                                                                     |
| `pnpm check`                                                                                                           | Passed Impeccable context check, workspace lint, TypeScript, and production builds                                                                              |
| `git diff --check`                                                                                                     | Passed after the final documentation edit                                                                                                                       |
| `marinara-doc-check`                                                                                                   | Not installed; no checked-in equivalent command is available                                                                                                    |

Manual proof: not completed. On supported desktop and Android/Termux
filesystems, corrupt `indexes/state.json` and one current-generation family,
restart the server, verify quarantined artifacts and fallback/rebuild behavior,
then confirm canonical notes remain intact.

Residual risk: automated coverage proves deterministic file fixtures and a
fresh-cache reload, but not a real power-loss/filesystem-crash sequence on each
supported runtime. Phase 10 still owns derived-artifact retention and cleanup.

Next entrypoint: begin Phase 5 in the resolved recall-settings and eligibility
paths.

### Phase 4 - Context-Bound Capture and Refresh

Started: 2026-07-11

Completed: 2026-07-11 locally; committed as `d7592ca0`

Baseline: Phase 3 commit `941b20d0` (`fix(ltm): recover coherent index generations`)

Commit: `d7592ca0` (`fix(ltm): make extraction refreshable and context-bound`)

Scope:

- Replaced the `extracted` freshness shortcut with a v2 extraction fingerprint
  containing source material, provenance, scope, enabled modes, and extraction
  mode. Source-note writes clear a now-stale fingerprint automatically.
- Bound source extraction to the persisted chat/group/character scope and mode
  before draft creation, and reject finalization if that context changes while
  extraction is in flight. Legacy context-unbound drafts now require
  re-extraction before any apply path can write mutations.
- Kept useful pending drafts when a later diagnostic-only extraction returns no
  mutations. Sources become current only after an authoritative extraction
  result; a diagnostics-only result remains refreshable.
- Made import previews compare the live capture fingerprint rather than a
  boolean. Character capture now includes durable card fields; lorebooks are
  stable per-entry source units below the 6,000-token call budget; game-journal
  capture refreshes its source text, scope, and raw journal hash from live data.
- Updated client cache keys for import mode, source-note status pills, and the
  legacy review label so the UI follows the server freshness contract.

Compatibility and migration:

- Existing v1 notes keep loading. The old optional `extracted` field remains
  readable for compatibility but is no longer a freshness authority.
- A source note without a v2 fingerprint is pending refresh. A legacy pending
  draft without one is blocked with `ltm_draft_source_context_unbound` until a
  new extraction creates a context-bound draft.
- Imported source identities remain stable across title edits. Existing
  lorebook imports are refreshed as stable entry parts on their next import.

Validation:

| Command                                                                                                                                                                                                                                         | Result                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/import-pipeline.spec.ts`                                                                                                                         | Passed: 12 tests, 0 failed; covers durable character fields, deterministic lorebook units, game-journal refresh, and diagnostic-only current-state handling |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/reconciliation.spec.ts`                                                                                                                          | Passed: 120 tests, 0 failed; covers v2 context invalidation, legacy draft blocking, and source-context binding                                              |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/maintenance.spec.ts src/services/long-term-memory/__tests__/routes.spec.ts src/services/long-term-memory/__tests__/draft-reconciliation.spec.ts` | Passed: 62 tests, 0 failed                                                                                                                                  |
| `pnpm --filter @marinara-engine/server test`                                                                                                                                                                                                    | Passed: 339 tests, 0 failed; all tracked server LTM specs discovered                                                                                        |
| `pnpm --filter @marinara-engine/server lint`                                                                                                                                                                                                    | Passed TypeScript validation                                                                                                                                |
| `pnpm regression:prompt`                                                                                                                                                                                                                        | Passed deterministic prompt, lorebook, macro, summary, and mode regressions                                                                                 |
| `pnpm check`                                                                                                                                                                                                                                    | Passed Impeccable context check, workspace lint, TypeScript, and production builds                                                                          |
| Isolated desktop LTM import Playwright flow on ports 5183/7976                                                                                                                                                                                  | Passed: 2 tests, 0 failed; imported-row and partial-import retry behavior                                                                                   |
| Isolated mobile LTM Playwright flow on ports 5184/7977                                                                                                                                                                                          | Passed: 1 test, 0 failed; mobile import entry flow                                                                                                          |
| `pnpm smoke:ui`                                                                                                                                                                                                                                 | Inconclusive: the initial shared-port run had an occupied port after a partial transcript; isolated focused LTM browser flows above passed                  |
| `git diff --check`                                                                                                                                                                                                                              | Passed after the final documentation edit                                                                                                                   |
| `marinara-doc-check`                                                                                                                                                                                                                            | Not installed; no checked-in equivalent command is available                                                                                                |

Manual proof: not completed. Import a changed character, a large lorebook
entry, a chat summary, and a game journal against a real configured provider;
verify each becomes pending after an upstream edit, re-extract it, and confirm
the Import and Review surfaces stay truthful on desktop and mobile.

Residual risk: automated coverage uses deterministic fixtures and mocked
browser transport. It does not prove a live remote provider, a migrated
user-sized vault, or every supported filesystem. The interrupted-write
platform proof gap from Phase 2 remains open; Phase 5 owns recall eligibility
and relevance behavior.

Next entrypoint: begin Phase 5 in the resolved recall-settings, scope
eligibility, threshold, direct-match, and mandatory-policy runtime paths.

### Phase 5 - Recall Settings, Eligibility, and Relevance

Started: 2026-07-11

Completed: 2026-07-11 locally; committed as `881027c8`

Baseline HEAD: `d7592ca0` (`fix(ltm): make extraction refreshable and context-bound`)

Commit: `881027c8` (`fix(ltm): correct recall eligibility and relevance`)

Scope:

- Added one generation settings resolver: `config/settings.json` supplies
  resolved defaults, while valid chat metadata supplies only sparse overrides.
  A chat-level recall-style choice applies that style's complete weight profile;
  a numeric lane override is the only exception.
- Made the shared recall-style control clear stale lane overrides whenever a
  style is selected. The generation route now passes the raw global settings
  and chat metadata separately and includes the current chat's group ID.
- Made archived notes ineligible before ranking and made group-scoped notes
  require the matching group even when a chat or character scope otherwise
  overlaps.
- Loaded `policies.json` in retrieval. `always_for_active_characters` now
  contributes its configured mandatory sections at runtime, while `never` and
  configured relevance sections constrain eligibility.
- Promoted exact note-ID and tag matches to direct candidate lanes. Vector and
  query-normalized keyword relevance now gate candidate eligibility before RRF
  ordering, so a weak best vector match cannot pass a high threshold merely by
  being ranked first.
- Added focused coverage for global/chat merging, every recall style,
  archived and group scope exclusion, direct ID/tag lookup, policy-mandated
  character sections, and the weak-best-vector negative control.

Compatibility and migration:

- Existing global settings and valid sparse chat overrides retain their values.
  Invalid persisted chat numbers now fall back to resolved global defaults;
  `null` lane weights continue to clear the chat override.
- Archived notes remain stored, listable, and indexed for vault maintenance,
  but cannot enter recall. Existing group-scoped notes become stricter only at
  retrieval time: they require a matching request group.
- Existing policy files retain their schema compatibility. A missing policy
  file uses the established defaults, and types without a policy retain normal
  relevance behavior.

Validation:

| Command                                                                                                                                                                        | Result                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/reconciliation.spec.ts src/services/long-term-memory/__tests__/ranking.spec.ts` | Passed: 135 tests, 0 failed; covers settings merge, policy runtime, direct lanes, scope/archive eligibility, and absolute threshold controls |
| `pnpm --filter @marinara-engine/server lint`                                                                                                                                   | Passed TypeScript validation                                                                                                                 |
| `pnpm --filter @marinara-engine/server test`                                                                                                                                   | Passed: 343 tests, 0 failed; all tracked server LTM specs discovered                                                                         |
| `pnpm regression:prompt`                                                                                                                                                       | Passed deterministic prompt, macro, lorebook, summary, and mode regressions                                                                  |
| `pnpm exec playwright test -c playwright.config.ts e2e/core-flows.e2e.ts --grep 'memory recall modal accepts clicks from chat settings'`                                       | Passed: 1 desktop test, 0 failed; 1 mobile project skip is intentional in the test                                                           |
| `pnpm check`                                                                                                                                                                   | Passed Impeccable context check, workspace lint, TypeScript, and production builds                                                           |
| `git diff --check`                                                                                                                                                             | Passed after the final documentation update                                                                                                  |
| `marinara-doc-check`                                                                                                                                                           | Not installed; no checked-in equivalent command is available                                                                                 |

Manual proof: not completed. In a real configured chat, select each recall
style after setting custom lane weights, reload the chat, and verify the saved
style profile. Verify that archived notes and a same-character note from a
different group do not appear in recall results, while an explicit note ID,
tag, and active-character mandatory section do.

Residual risk: automated coverage proves the resolver and retrieval service,
plus the surrounding desktop chat-settings flow. Phase 7 still owns end-to-end
provider-payload proof across every mode and preset state; Phase 8 owns full
client persistence, accessibility, and mobile control proof.

Next entrypoint: begin Phase 6 in the structured prompt-artifact, final-fit,
and post-dispatch receipt paths.

### Phase 6 - Safe Prompt Artifacts and Truthful Receipts

Started: 2026-07-12

Completed: 2026-07-12 locally; committed as `d06bca17`

Baseline HEAD: `881027c8` (`fix(ltm): correct recall eligibility and relevance`)

Commit: `d06bca17` (`fix(ltm): make prompt injection and receipts truthful`)

Scope:

- Replaced the preformatted LTM block with a structured prompt artifact that
  remains distinct through marker/fallback placement, group handling, strict
  roles, single-user mode, regex processing, target scoping, and final context
  fitting.
- Serialize selected chunks only after placement is known. Final-budget
  accounting includes the preamble, section wrapper, labels, separators,
  escaped content, and ChatML overhead. The fitter removes the dedicated LTM
  message as a whole rather than truncating memory text.
- XML-escaped untrusted memory leaves and preamble text, kept the LTM artifact
  macro-opaque, and retained literal `{{user}}` through both marker and
  fallback placement.
- Moved injection accounting from retrieval time to the first successful
  provider dispatch containing the complete post-fit artifact. Provider-owned
  final fitting reports its message list back to the route; telemetry failures
  are caught and cannot fail generation.
- Added a durable per-chat dispatch receipt under the LTM events root. Usage
  now keys cooldown data by chat and chunk, while Last Injection reads receipts
  instead of optional debug events.
- Quarantine malformed usage and receipt data before continuing with valid
  recall. Existing v1 global usage entries remain readable as legacy history
  but do not impose a cross-chat cooldown.

Compatibility and migration:

- Existing notes, retrieval settings, debug logs, and global settings remain
  unchanged. The new receipts directory is created during store initialization
  and lazily by atomic receipt writes.
- A valid v1 `usage.json` is parsed into `legacyChunks` when next read or
  rewritten. Because its records have no chat owner, it is never applied as a
  global cooldown to unrelated chats.
- Chats with no durable dispatch receipt continue to receive the established
  empty Last Injection response. Receipt note titles are resolved from current
  notes when still available and otherwise fall back to the persisted note ID.

Validation:

| Command                                                                                                                                                                                            | Result                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env LOG_LEVEL=silent pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/prompt-artifact.spec.ts src/services/long-term-memory/__tests__/usage.spec.ts` | Passed: 11 tests, 0 failed; covers escaping, macro opacity, final serialization budget, atomic fitting, post-dispatch gating, chat-scoped usage, v1 compatibility, receipts, and corruption quarantine |
| `env LOG_LEVEL=silent pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/reconciliation.spec.ts src/services/long-term-memory/__tests__/routes.spec.ts` | Passed: 142 tests, 0 failed; includes marker/fallback placement and durable Last Injection route proof without debug events                                                                            |
| `pnpm --filter @marinara-engine/server lint`                                                                                                                                                       | Passed TypeScript validation                                                                                                                                                                           |
| `pnpm --filter @marinara-engine/server test`                                                                                                                                                       | Passed: 350 tests, 0 failed; all tracked server LTM specs discovered                                                                                                                                   |
| `pnpm regression:prompt`                                                                                                                                                                           | Passed deterministic prompt, macro, lorebook, summary, and mode regressions                                                                                                                            |
| `pnpm check`                                                                                                                                                                                       | Passed Impeccable context check, workspace lint, TypeScript, and production builds                                                                                                                     |
| `git diff --check`                                                                                                                                                                                 | Passed after the final documentation update                                                                                                                                                            |
| `marinara-doc-check`                                                                                                                                                                               | Not installed; `command -v marinara-doc-check` returned no executable and no checked-in equivalent command is available                                                                                |

Manual proof: not completed. With a configured streaming provider and a
tool-capable provider, send a recalled-memory chat turn, confirm Last Injection
updates only after the provider accepts a payload, then force a dispatch error
and confirm no receipt or cooldown update is written. Repeat with a preset LTM
marker and without one.

Residual risk: automated fixtures cover the route's post-fit callback and
provider-independent dispatch gate, but not a live remote response from every
provider adapter. Phase 7 still owns mode-neutral reachability across
Conversation, Roleplay, Visual Novel, and Game, including presetless recall.

Next entrypoint: begin Phase 7 by moving recall orchestration outside preset
and mode guards while preserving the Phase 6 artifact and receipt contracts.

### Phase 7 - Mode-Neutral Production Recall

Started: 2026-07-12

Completed: 2026-07-12

Baseline HEAD: `d06bca17` (`fix(ltm): make prompt injection and receipts truthful`)

Commit: `1efa7658` (`fix(ltm): enable mode-neutral generation recall`)

Scope:

- Added one request-scoped generation recall orchestrator outside preset and
  mode guards. It receives the production chat, group, prompt character IDs,
  active names, request messages, resolved settings, embedding source, and
  abort signal.
- Removed the preset-only retrieval branch, its duplicate global-settings
  read, and the managed-agent activation gate. LTM recall now follows resolved
  recall settings rather than the generic agent pipeline toggle.
- Presets continue to place the structured Phase 6 artifact at an explicit LTM
  marker or the assembler fallback. Conversation and every presetless path use
  the same dedicated, wrapped safe fallback before the provider payload is fit.
- Replaced the unused helper-only injection path with artifact-aware fallback
  injection so final serialization, whole-artifact fitting, macro opacity, and
  dispatch receipts remain one contract.
- Optional retrieval failures remain fail-open, while request cancellation is
  rethrown as an abort and provider failures remain outside the recall handler.

Compatibility and mode behavior:

- Conversation, Roleplay, Visual Novel, and Game now retrieve with and without
  a prompt preset. Visual Novel continues to resolve the Roleplay LTM lane.
- Group and character scope, active-character names, embedding-source choice,
  query signals, and cancellation propagate into the retrieval request.
- The managed `long-term-memory` agent remains excluded from generic agent
  resolution; it is still the lifecycle/settings identity, not a pipeline run.

Validation:

| Command                                                                                                                                        | Result                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env LOG_LEVEL=silent pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/reconciliation.spec.ts`    | Passed: 126 tests, 0 failed; covers the shared orchestrator, scope, embedding source, cancellation, marker placement, and safe fallback                                                    |
| `env LOG_LEVEL=silent pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/production-recall.spec.ts` | Passed: 1 test, 0 failed; a recording provider saw scoped recalled memory in Conversation, Roleplay, Visual Novel, and Game, both presetless and marker-preset paths, with agents disabled |
| `pnpm --filter @marinara-engine/server lint`                                                                                                   | Passed TypeScript validation                                                                                                                                                               |
| `pnpm --filter @marinara-engine/server test`                                                                                                   | Passed: 353 tests, 0 failed; all discovered server LTM specs passed                                                                                                                        |
| `pnpm regression:prompt`                                                                                                                       | Passed deterministic prompt, macro, lorebook, summary, and mode regressions                                                                                                                |
| `pnpm check`                                                                                                                                   | Passed Impeccable context check, workspace lint, TypeScript, and production builds                                                                                                         |
| `git diff --check`                                                                                                                             | Passed after the final documentation update                                                                                                                                                |
| `marinara-doc-check`                                                                                                                           | Not installed; `command -v marinara-doc-check` returned no executable and no checked-in equivalent command is available                                                                    |

Manual proof: not completed. With a configured remote provider, generate one
recalled turn in each mode with and without a preset, then confirm the provider
payload includes the recalled artifact only for the matching scope. Abort a
request during embedding/retrieval and confirm no provider request or receipt
is written.

Residual risk: the route fixture uses a local OpenAI-compatible recording
provider and proves final request payloads, but it does not exercise every
remote provider adapter's message transformation. Phase 8 supplies the client
state, persistence, accessibility, and browser proof recorded below.

Next entrypoint: continue with the completed Phase 8 record below, then begin
Phase 9 full-backup restore work.

### Phase 8 - Truthful Client Behavior and Accessibility

Started: 2026-07-12

Completed: 2026-07-12

Baseline HEAD: `1efa7658` (`fix(ltm): enable mode-neutral generation recall`)

Commit: `5ced1bc7` (`fix(ltm): align recall controls with runtime behavior`)

Scope:

- Moved the production recall-settings resolver into a shared pure contract so
  generation, chat controls, and vault Test Recall use the same enablement,
  style, sparse override, weight, and fallback rules.
- Made the Chat Settings LTM card runtime-owned: it follows resolved LTM
  settings rather than `activeAgentIds`, controls only
  `enableLongTermMemory`, keeps Last Injection visible even when recall is
  off, and refreshes that receipt when generation completes.
- Excluded the managed LTM agent from generic Chat Settings and setup-wizard
  add/remove paths while retaining the dedicated LTM controls and vault.
- Made Test Recall use the selected concrete branch, its group/character
  scope, LTM mode, recent context, all resolved ranking weights including
  `keywordWeight`, and truthful disabled/no-branch states.
- Distinguished new, stale, and current import sources in the shared preview
  contract and vault UI; stale sources remain actionable as refreshes.
- Flushed debounced chat/global recall edits on close, scope changes, saves,
  and unmount; rapid Chat Settings edits now persist before reload.
- Added accessible modal close names, recall labels/statuses, pressed states,
  loading/error/empty states, a refresh control, and keyboard Test Recall
  behavior. Cleared extraction candidates now remove only actionable recovery
  controls while keeping historical accounting visible.

Compatibility and mode behavior:

- Existing `activeAgentIds` values are left intact for compatibility, but they
  no longer determine whether LTM recalls at runtime. Conversation, Roleplay,
  Visual Novel compatibility, and Game resolve from the same settings contract.
- Pending legacy import-preview rows default to `new`; already imported rows
  default to `current`. The server emits explicit freshness for every newly
  generated preview.
- Test Recall requires a concrete branch. Group-level navigation remains
  available for vault browsing, and selecting a branch carries its `groupId`
  into the search scope.

Validation:

| Command                                                                                                                                                                                                                                                               | Result                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `env LOG_LEVEL=silent pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/contracts.spec.ts src/services/long-term-memory/__tests__/import-pipeline.spec.ts src/services/long-term-memory/__tests__/reconciliation.spec.ts` | Passed: 146 tests, 0 failed; covers shared resolver behavior, import freshness, and production recall contracts            |
| `pnpm regression:prompt`                                                                                                                                                                                                                                              | Passed deterministic prompt, macro, lorebook, summary, and mode regressions                                                |
| `pnpm check`                                                                                                                                                                                                                                                          | Passed Impeccable context check, workspace lint, TypeScript, and production builds                                         |
| `pnpm smoke:ui`                                                                                                                                                                                                                                                       | Passed: 36 desktop/mobile browser tests, including loading/error, recovery, selection, refresh, and mobile overflow flows  |
| `PLAYWRIGHT_SKIP_WEBSERVER=true PLAYWRIGHT_BASE_URL=http://127.0.0.1:5179 pnpm exec playwright test -c playwright.config.ts --project=desktop-chromium -g 'LTM recall uses the selected chat runtime settings' --timeout=60000 --reporter=line`                       | Passed: 1 test; verifies group-scoped Test Recall payloads, all resolved weights, keyboard operation, and import freshness |
| `PLAYWRIGHT_SKIP_WEBSERVER=true PLAYWRIGHT_BASE_URL=http://127.0.0.1:5179 pnpm exec playwright test -c playwright.config.ts --project=desktop-chromium -g 'LTM chat overrides flush' --timeout=60000 --reporter=line`                                                 | Passed: 1 test; verifies close/reload persistence of rapid overrides                                                       |
| `PLAYWRIGHT_SKIP_WEBSERVER=true PLAYWRIGHT_BASE_URL=http://127.0.0.1:5179 pnpm exec playwright test -c playwright.config.ts --project=mobile-chromium -g 'LTM recall uses the selected chat runtime settings' --timeout=60000 --reporter=line`                        | Passed: 1 test; verifies the selected-chat, keyboard, freshness, and refresh flow on mobile                                |
| `git diff --check`                                                                                                                                                                                                                                                    | Passed after the final documentation update                                                                                |
| `marinara-doc-check`                                                                                                                                                                                                                                                  | Not installed; `command -v marinara-doc-check` returned no executable and no checked-in equivalent command is available    |

Manual proof: not completed. With a configured remote provider, verify that a
real recalled turn and Last Injection receipt agree after toggling LTM in each
supported mode. Verify the touched controls with the target screen reader and
on a packaged mobile/device build.

Residual risk: browser proof uses local route fixtures for recall and receipt
states, not every remote provider adapter or assistive-technology stack. The
Phase 2 interrupted-write platform proof gap remains; Phase 9 now owns and
records full-backup restore proof below.

Next entrypoint: continue with the completed Phase 9 record below.

### Phase 9 - Consistent Full-Backup Restore

Started: 2026-07-12

Completed: 2026-07-12

Baseline HEAD: `5ced1bc7` (`fix(ltm): align recall controls with runtime behavior`)

Commit: `fix(backup): restore long-term memory safely`

Scope:

- Extracted the LTM vault lock into a shared re-entrant server primitive and
  applied it to canonical note, draft, settings, extraction-config,
  usage/receipt, identity-repair, maintenance, initialization, and
  backup-snapshot paths. Restore keeps that lock through its local rebuild;
  ordinary rebuilds retain their existing concurrent-mutation retry behavior.
- Made full-backup folder and ZIP creation capture `long-term-memory` under
  that lock, so in-process canonical mutations cannot interleave with a vault
  snapshot.
- Added an explicit `restoreLongTermMemory=true` full-backup import path and a
  Settings import checkbox. Normal profile/full-backup imports continue to
  leave the live LTM root untouched.
- Staged ZIP LTM entries under safe validated paths, rejected missing or
  derived-only vault payloads, validated canonical notes, links, drafts,
  settings, extraction config, events, valid usage, receipts, and metadata,
  then removed imported derived indexes before publication.
- Published a staged root through sibling directory renames, retained the
  complete prior root through rebuild and integrity verification, and restored
  that prior root if staging, publication, rebuild, verification, or an
  injected boundary failed.
- Preserved valid usage and dispatch receipts while locally rebuilding index
  generations, and documented the opt-in flow and recovery behavior.

Compatibility and mode behavior:

- Existing full-backup archives remain importable for profile data. LTM restore
  is unavailable unless the archive has canonical LTM data and the user opts
  in explicitly.
- Imported index files are never activated. The restored canonical root gets a
  fresh local index generation, so Conversation, Roleplay, Visual Novel, and
  Game retain the same mode-neutral recall contract.
- Backups without a restorable LTM payload leave the live vault untouched and
  return a clear import error only when the opt-in control was selected.

Validation:

| Command                                                                                                                                     | Result                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env LOG_LEVEL=silent pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/backup-restore.spec.ts` | Passed: 4 tests; canonical round-trip, derived-index discard/rebuild, rollback at every publication boundary, concurrent snapshot coherence, default preservation, and opt-in ZIP route restore |
| `env LOG_LEVEL=silent pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/*.spec.ts`              | Passed: 357 tests, 0 failed; all 24 tracked LTM specs discovered                                                                                                                                |
| `pnpm --filter @marinara-engine/server build`                                                                                               | Passed TypeScript and server production build                                                                                                                                                   |
| `pnpm --filter @marinara-engine/client build`                                                                                               | Passed TypeScript and client production build                                                                                                                                                   |
| `pnpm regression:prompt`                                                                                                                    | Passed deterministic prompt, macro, lorebook, summary, and LTM prompt regressions                                                                                                               |
| `pnpm check`                                                                                                                                | Passed Impeccable context check, workspace lint, TypeScript, and production builds                                                                                                              |
| `PLAYWRIGHT_CLIENT_PORT=5189 PLAYWRIGHT_SERVER_PORT=7981 pnpm smoke:ui`                                                                     | Passed: 21 desktop/mobile browser tests, 15 expected project-specific skips, 0 failed                                                                                                           |
| `git diff --check`                                                                                                                          | Passed after the final documentation update                                                                                                                                                     |
| `marinara-doc-check`                                                                                                                        | Not installed; `command -v marinara-doc-check` returned no executable and no checked-in equivalent command is available                                                                         |

Manual proof: not completed. Import a real full-backup ZIP through Settings with
and without the opt-in control on each packaged desktop/mobile target. Verify a
large production vault rebuild and a deliberately interrupted process-level
restore on the target filesystem before release.

Residual risk: automated rollback proof injects recoverable failures at each
application boundary, but it cannot simulate a host/process crash between
directory renames on every desktop/mobile filesystem. The Phase 2
interrupted-write platform proof gap remains.

Next entrypoint: begin Phase 10 with bounded exact retrieval and dead-path
cleanup.

### Phase 10 - Bounded Exact Retrieval and Dead-Path Cleanup

Started: 2026-07-12

Completed: 2026-07-12

Baseline HEAD: `b1ec45d6` (`fix(backup): restore long-term memory safely`)

Commit: `3df16606` (`perf(ltm): bound retrieval and remove legacy paths`)

Scope:

- Added deterministic, configured candidate caps before ranking. Scope/status,
  direct note/tag, BM25, keyword, vector, mandatory-policy, and graph work now
  enter bounded catalogs, while fixed corpora below the cap keep the same
  results. New metadata indexes catalog modes and globally scoped chunks; new
  embedding indexes catalog entries by chunk ID.
- Rebuilds reuse vectors from the prior validated generation when a chunk's
  stable source hash and embedding model label match. A provider dimension
  change triggers a coherent family re-embed instead of mixing vector shapes.
- Added `config/retention.json` defaults and periodic vault-initialization
  retention for aged usage entries, dispatch receipts, canonical events,
  incomplete generations, and quarantine artifacts. Retention never targets
  active/fallback generations or any artifact while mutation recovery is
  pending, and every retention period is constrained by the configured audit
  window.
- Removed the unused feature-panel registry, unreachable managed-agent
  add-preview branches, obsolete connectionless wording, and the redundant
  generation retrieval helper. The existing generated index-only test remains
  the static proof that legacy flat index output has no writer.

Compatibility and mode behavior:

- Existing v1 metadata and embedding generations remain readable. They fall
  back to their prior catalogs until the next rebuild publishes the new derived
  fields; canonical notes and index-generation compatibility are unchanged.
- Conversation, Roleplay, Visual Novel, and Game keep the existing
  generation-owned recall orchestrator and prompt-placement behavior. The
  candidate caps apply below that shared owner without adding an ANN dependency.
- Default retention keeps all operational artifacts for at least the 30-day
  audit window. Invalid receipts and malformed event rows are retained for
  existing quarantine/integrity paths rather than being silently deleted.

Validation:

| Command                                                                                                                                  | Result                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env LOG_LEVEL=silent pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/maintenance.spec.ts` | Passed: 40 tests; includes bounded catalogs, embedding reuse, direct and vault-initialization retention, audit-window retention, active-generation protection, and pending-recovery protection |
| `env LOG_LEVEL=silent pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/*.spec.ts`           | Passed: 362 tests, 0 failed; all 24 tracked LTM specs discovered                                                                                                                               |
| `pnpm --filter @marinara-engine/server build`                                                                                            | Passed TypeScript and server production build                                                                                                                                                  |
| `pnpm --filter @marinara-engine/client build`                                                                                            | Passed TypeScript and client production build                                                                                                                                                  |
| `pnpm regression:prompt`                                                                                                                 | Passed deterministic prompt, macro, lorebook, summary, and LTM prompt regressions                                                                                                              |
| `PLAYWRIGHT_CLIENT_PORT=5190 PLAYWRIGHT_SERVER_PORT=7982 pnpm smoke:ui`                                                                  | Passed on isolated ports; Playwright scheduled 36 desktop/mobile smoke tests                                                                                                                   |
| `pnpm check`                                                                                                                             | Passed Impeccable context check, workspace lint, TypeScript, and production builds                                                                                                             |
| static call-site search for removed helpers/registry/connectionless preview surface                                                      | Passed: no executable consumer remains                                                                                                                                                         |
| `git diff --check`                                                                                                                       | Passed after the final ledger update                                                                                                                                                           |
| `marinara-doc-check`                                                                                                                     | Not installed; `command -v marinara-doc-check` returned no executable and no checked-in equivalent command is available                                                                        |

Manual proof: run recall against a production-sized vault with the target
embedding provider before release to choose candidate caps that preserve the
expected recall quality. Confirm automatic retention over a real audit window
on supported desktop and Android/Termux filesystems.

Residual risk: exact scoring is intentionally limited to deterministic candidate
catalogs rather than a full-corpus ANN search. Defaults preserve ordinary
corpora and direct/mandatory lanes, but a very large global vault may need
operator tuning and manual quality validation. The Phase 2 interrupted-write
and Phase 9 process-interruption platform proof gaps remain.

Next entrypoint: begin the Phase 11 end-to-end release-readiness matrix.

### Phase 11 - Final Release-Readiness Proof

Started: 2026-07-12

Completed: 2026-07-12 locally; commit pending

Baseline HEAD: `3df16606` (`perf(ltm): bound retrieval and remove legacy paths`)

Commit: pending (`test(ltm): validate release-readiness remediation`)

Scope:

- Added `release-readiness.spec.ts`, an authoritative route-level lifecycle
  matrix that follows source capture, streamed extraction, draft acceptance,
  rebuild, scoped recall, final provider payload fitting, post-dispatch receipt
  and usage creation, restart, permanent deletion, and full-vault restore.
- The same matrix covers rejected provider dispatch with a final-payload
  negative control and an unauthenticated remote mutation before capture.
- Extended the production generation matrix so every Conversation, Roleplay,
  Visual Novel, and Game preset/fallback dispatch proves its own durable receipt
  after the provider receives the final payload.
- Reconciled the current LTM documentation: README retains the lifecycle-only
  managed-agent wording, configuration documents bounded exact retrieval and
  retention, troubleshooting documents explicit full-backup restore, and
  CONTRIBUTING keeps generation as the recall owner. No user-facing wording
  contradicted the final implementation.

Compatibility and mode behavior:

- The lifecycle fixture uses a disposable `DATA_DIR` and a loopback
  OpenAI-compatible provider. It exercises the actual route, persisted vault,
  and restart paths without requiring a paid or network provider.
- Existing source summaries remain excluded from normal recall. The route-level
  scope negative control proves a similarly relevant foreign-group note does
  not reach the provider payload.
- The all-mode matrix keeps both marker-preset and fallback placement active
  for Conversation, Roleplay, Visual Novel, and Game; durable accounting is
  written only after accepted dispatch and is absent after provider rejection.
- Snapshot restore preserves canonical data and receipts while rebuilding
  derived indexes locally. Existing backups and explicit opt-in restore behavior
  are unchanged.

Release-readiness matrix:

| Contract                       | Positive proof                                                                                          | Negative proof                                                                                                | Authoritative coverage                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Capture, draft, and rebuild    | Source route streams a structured extraction, persists a pending draft, accepts it, and rebuilds        | Remote unauthenticated creation is rejected before capture                                                    | `release-readiness.spec.ts`                                                                                   |
| Scope, mode, and preset recall | Route dispatch reaches the final provider payload for all modes with marker and fallback placement      | Foreign group memory is excluded; archived/mode/relevance controls remain in tracked retrieval specs          | `production-recall.spec.ts`, `release-readiness.spec.ts`, `reconciliation.spec.ts`                            |
| Final fit and accounting       | Provider-visible fitted artifact writes durable receipt and chat-scoped usage                           | Rejected provider dispatch writes neither receipt nor usage                                                   | `production-recall.spec.ts`, `release-readiness.spec.ts`, `prompt-artifact.spec.ts`, `usage.spec.ts`          |
| Deletion, restart, and restore | Permanent deletion removes recall after restart; snapshot restore restores canonical recall and receipt | Mutation rollback, stale-cache, corrupt-state, and mixed-generation controls remain green                     | `release-readiness.spec.ts`, `mutation-transactions.spec.ts`, `maintenance.spec.ts`, `backup-restore.spec.ts` |
| Auth, corruption, and recovery | Loopback routes, repair, quarantine, coherent generation, and full-backup restoration pass              | LAN/private route gates, malformed state, corrupt families, malformed usage/receipts, and rollback cases pass | `routes.spec.ts`, `maintenance.spec.ts`, `usage.spec.ts`, `backup-restore.spec.ts`                            |

Validation:

| Command                                      | Result                                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                  | Passed: Windows installer staging-layout guard and the workspace server suite; 365 tests passed, 0 failed                                                      |
| `pnpm --filter @marinara-engine/server test` | Passed: 25 LTM `*.spec.ts` files, 365 tests passed, 0 failed                                                                                                   |
| `pnpm regression:prompt`                     | Passed deterministic prompt, macro, lorebook, summary, and LTM prompt regressions                                                                              |
| Targeted LTM browser matrix                  | Passed: 15 browser tests, 13 expected project-specific skips, 0 failed across 28 selected desktop/mobile rows                                                  |
| `pnpm smoke:ui`                              | Passed: 21 browser tests, 15 expected project-specific skips, 0 failed across 36 desktop/mobile rows                                                           |
| `pnpm check`                                 | Passed Impeccable context check, workspace lint, TypeScript, and production builds; existing Vite entry-chunk advisory remained (554.66 kB after minification) |
| `git diff --check`                           | Passed after the final documentation and tracked-test review                                                                                                   |
| `marinara-doc-check`                         | Not installed; `command -v marinara-doc-check` returned no executable and no checked-in equivalent command is available                                        |

Exact targeted browser command:

```bash
pnpm exec playwright test -c playwright.config.ts e2e/core-flows.e2e.ts --grep "LTM|memory recall"
```

Manual proof: before a release, verify production-scale recall quality and the
configured retention policy against the target embedding provider on desktop,
Android, and Termux filesystems. Import a real full-backup ZIP through Settings
with and without its explicit LTM opt-in on each packaged target. Exercise an
interrupted vault mutation and a process-level restore interruption on those
filesystems; the automated injected-failure coverage cannot prove every
host/process-crash boundary.

Residual risk: automated release-readiness proof is green, but it cannot
establish production-scale recall quality, a real audit-window retention run,
or process-crash atomicity on every supported filesystem. Do not describe the
release as fully ready until that manual proof is completed.

Next entrypoint: commit Phase 11 as
`test(ltm): validate release-readiness remediation`. No version, pull request,
or release work belongs to this phase.

## Progress Update Template

Use this structure for each phase record:

```markdown
### Phase N - Name

Started: YYYY-MM-DD
Completed: YYYY-MM-DD or pending
Baseline HEAD: `<hash>`
Commit: `<hash>` or pending

Scope:

- What changed.

Compatibility and migration:

- Existing/current and legacy behavior covered.

Validation:

| Command         | Result                              |
| --------------- | ----------------------------------- |
| `exact command` | pass/fail counts and relevant skips |

Manual proof: none, completed details, or explicit remaining work.

Residual risk: none or exact unproven behavior.

Next entrypoint: first file, test, or invariant for the next phase.
```

When resuming in a fresh context, read Resume Here, the current phase in the
plan, the latest phase record, and `git status --short --branch` before editing.
