# Long-Term Memory Release-Readiness Progress

This is the resumable implementation ledger for
`docs/LTM_RELEASE_READINESS_PLAN.md`. Update it during every phase. Keep the
Resume Here section short and current; keep completed phase records durable.

## Resume Here

- Branch: `fix/ltm-staging-port-rebase`
- Audit baseline: `c83d66e6edee6c0a9b3ab3021265461b4ff1a1b1`
- Current phase: Phase 1 - Security and Managed-Agent Lifecycle
- State: Phase 0 complete; Phase 1 not started
- Next entrypoint: inspect the privileged guard used by existing LTM routes and
  add failing route-level negative controls for transfer preview, integrity,
  and import preview
- Uncommitted scope: none expected after the Phase 0 commit
- Blockers: none

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
| 1 - Security and managed-agent lifecycle | Not started | Pending | Not run |
| 2 - Transactional vault mutations | Not started | Pending | Not run |
| 3 - Coherent index recovery | Not started | Pending | Not run |
| 4 - Context-bound capture and refresh | Not started | Pending | Not run |
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
