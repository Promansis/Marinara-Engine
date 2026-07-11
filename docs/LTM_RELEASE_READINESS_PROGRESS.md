# Long-Term Memory Release-Readiness Progress

This is the resumable implementation ledger for
`docs/LTM_RELEASE_READINESS_PLAN.md`. Update it during every phase. Keep the
Resume Here section short and current; keep completed phase records durable.

## Resume Here

- Branch: `fix/ltm-staging-port-rebase`
- Audit baseline: `c83d66e6edee6c0a9b3ab3021265461b4ff1a1b1`
- Current phase: Phase 4 - Context-Bound Capture and Refresh
- State: Phase 3 committed locally as `941b20d0`; Phase 4 implementation and
  validation complete locally with its atomic commit pending
- Next entrypoint: commit the completed Phase 4 scope, then begin Phase 5
  recall-settings and eligibility work
- Uncommitted scope: Phase 4 source freshness, import refresh, client status,
  regression tests, and this progress update
- Blockers: no Phase 4 implementation blocker. Phase 2's platform-specific
  interrupted-write proof gap remains recorded below.

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

| Proof | Baseline result |
| --- | --- |
| Tracked server LTM suites | 322 passed, 0 failed; all 19 tracked specs discovered |
| Deterministic prompt regression | Passed |
| Focused LTM Playwright flow | 11 passed, 11 expected project-specific skips |
| `pnpm check` | Passed lint, TypeScript, and production builds; existing Vite large-chunk advisory remained |
| Negative controls | Reproduced reachability, deleted-cache recall, lost update, prompt breakout, auth bypass, stale weights, weak relevance, budget, corruption, mixed-generation, dangling-link, event, and receipt failures |
| Worktree after audit | Clean |

This evidence describes the unremediated baseline. It must not be reused as
proof that a later implementation phase passes.

## Phase Ledger

| Phase | State | Commit | Validation summary |
| --- | --- | --- | --- |
| 0 - Documentation baseline | Complete | Commit subject below | Direct path checks and `git diff --check` passed |
| 1 - Security and managed-agent lifecycle | Complete | Commit subject below | Focused route/lifecycle proof, server suite, static build, and prompt regression passed; one unrelated browser smoke failure recorded |
| 2 - Transactional vault mutations | Complete | Commit subject below | Focused transaction/recovery proof, affected LTM suites, full server suite, prompt regression, and static validation passed |
| 3 - Coherent index recovery | Committed locally (`941b20d0`) | Complete | Focused corruption/recovery proof, 334-test server suite, prompt regression, and static/build validation passed |
| 4 - Context-bound capture and refresh | Implementation complete locally | Commit pending | Focused import/freshness/route proof, 339-test server suite, prompt regression, static/build validation, and targeted desktop/mobile browser flows passed |
| 5 - Recall settings, eligibility, and relevance | Not started | Pending | Not run |
| 6 - Safe prompt artifacts and truthful receipts | Not started | Pending | Not run |
| 7 - Mode-neutral production recall | Not started | Pending | Not run |
| 8 - Truthful client behavior and accessibility | Not started | Pending | Not run |
| 9 - Consistent full-backup restore | Not started | Pending | Not run |
| 10 - Bounded exact retrieval and dead-path cleanup | Not started | Pending | Not run |
| 11 - Final release-readiness proof | Not started | Pending | Not run |

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

| Command | Result |
| --- | --- |
| `git diff --check` | Passed |
| Direct referenced-path checks | Passed |
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

| Command | Result |
| --- | --- |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/routes.spec.ts src/services/long-term-memory/__tests__/managed-agent-lifecycle.spec.ts` | Passed: 19 tests, 0 failed |
| `pnpm --filter @marinara-engine/server test` | Passed: 325 tests, 0 failed |
| `pnpm --filter @marinara-engine/server lint` | Passed TypeScript validation |
| `pnpm check` | Passed Impeccable context check, workspace lint, TypeScript, and production builds |
| `pnpm regression:prompt` | Passed deterministic prompt and mode regression checks |
| Isolated Playwright rerun on ports 5180/7973 | 17 passed, 14 expected skips, 1 unrelated failure: `manual memory recovery survives dismissing the create modal` left `Remove all` visible after dismissal |
| `git diff --check` | Passed |
| `marinara-doc-check` | Not installed; no checked-in equivalent command is available |

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

| Command | Result |
| --- | --- |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/maintenance.spec.ts` | Passed: 35 tests, 0 failed; covers malformed state, pointer, repair, complete-generation fallback, warm-cache recovery, publication failure, and no flat output |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/reconciliation.spec.ts` | Passed: 117 tests, 0 failed |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/routes.spec.ts` | Passed: 17 tests, 0 failed |
| `pnpm --filter @marinara-engine/server test` | Passed: 334 tests, 0 failed |
| `pnpm --filter @marinara-engine/server lint` | Passed TypeScript validation |
| `pnpm regression:prompt` | Passed deterministic prompt, macro, lorebook, summary, and mode regressions |
| `pnpm check` | Passed Impeccable context check, workspace lint, TypeScript, and production builds |
| `git diff --check` | Passed after the final documentation edit |
| `marinara-doc-check` | Not installed; no checked-in equivalent command is available |

Manual proof: not completed. On supported desktop and Android/Termux
filesystems, corrupt `indexes/state.json` and one current-generation family,
restart the server, verify quarantined artifacts and fallback/rebuild behavior,
then confirm canonical notes remain intact.

Residual risk: automated coverage proves deterministic file fixtures and a
fresh-cache reload, but not a real power-loss/filesystem-crash sequence on each
supported runtime. Phase 10 still owns derived-artifact retention and cleanup.

Next entrypoint: commit the completed Phase 4 scope, then begin Phase 5 in the
resolved recall-settings and eligibility paths.

### Phase 4 - Context-Bound Capture and Refresh

Started: 2026-07-11

Completed: 2026-07-11 locally; atomic commit pending

Baseline: Phase 3 commit `941b20d0` (`fix(ltm): recover coherent index generations`)

Commit: pending; record this hash at the Phase 5 checkpoint

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

| Command | Result |
| --- | --- |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/import-pipeline.spec.ts` | Passed: 12 tests, 0 failed; covers durable character fields, deterministic lorebook units, game-journal refresh, and diagnostic-only current-state handling |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/reconciliation.spec.ts` | Passed: 120 tests, 0 failed; covers v2 context invalidation, legacy draft blocking, and source-context binding |
| `pnpm --filter @marinara-engine/server exec tsx --test src/services/long-term-memory/__tests__/maintenance.spec.ts src/services/long-term-memory/__tests__/routes.spec.ts src/services/long-term-memory/__tests__/draft-reconciliation.spec.ts` | Passed: 62 tests, 0 failed |
| `pnpm --filter @marinara-engine/server test` | Passed: 339 tests, 0 failed; all tracked server LTM specs discovered |
| `pnpm --filter @marinara-engine/server lint` | Passed TypeScript validation |
| `pnpm regression:prompt` | Passed deterministic prompt, lorebook, macro, summary, and mode regressions |
| `pnpm check` | Passed Impeccable context check, workspace lint, TypeScript, and production builds |
| Isolated desktop LTM import Playwright flow on ports 5183/7976 | Passed: 2 tests, 0 failed; imported-row and partial-import retry behavior |
| Isolated mobile LTM Playwright flow on ports 5184/7977 | Passed: 1 test, 0 failed; mobile import entry flow |
| `pnpm smoke:ui` | Inconclusive: the initial shared-port run had an occupied port after a partial transcript; isolated focused LTM browser flows above passed |
| `git diff --check` | Passed after the final documentation edit |
| `marinara-doc-check` | Not installed; no checked-in equivalent command is available |

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

| Command | Result |
| --- | --- |
| `exact command` | pass/fail counts and relevant skips |

Manual proof: none, completed details, or explicit remaining work.

Residual risk: none or exact unproven behavior.

Next entrypoint: first file, test, or invariant for the next phase.
```

When resuming in a fresh context, read Resume Here, the current phase in the
plan, the latest phase record, and `git status --short --branch` before editing.
