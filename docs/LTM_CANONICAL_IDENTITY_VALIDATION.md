# LTM Canonical Identity Implementation Ledger

Status: validated on 2026-07-11.

This ledger records the implementation and proof for canonical long-term-memory
subject identity, existing-data repair, deterministic draft reconciliation, and
truthful Review diagnostics. Note filenames remain storage identifiers. The
persisted `subjects` field is the identity contract.

No paid provider is required by this validation. The three-range import replay
uses a loopback OpenAI-compatible server owned by the test process and a
disposable `DATA_DIR`.

## Phase Ledger

| Phase                          | Commit                                          | Durable result                                                                                                                                             |
| ------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8 - Canonical subject identity | `5e1d857d`                                      | Trusted roster catalog, optional legacy metadata, cardinality enforcement, unordered relationship subjects, scoped targeting, and `set_subjects`           |
| 9 - Existing-data repair       | `f71572c1`                                      | Idempotent preview, deterministic canonical selection, explicit conflict choices, backup, reference rewrite, archive, rollback, and one rebuilt generation |
| 10 - Draft reconciliation      | `a23d7714`                                      | Source-order overlay, pure projection, write-lock rebase, additive and superseding section semantics, freshness conflicts, and retry safety                |
| 11 - Truthful Review           | `0607f36f`                                      | Persisted operations, diagnostics, outcomes, balanced accounting, server Review projection, dynamic dispositions, and diagnostic-only drafts               |
| 12 - Final proof               | `test(ltm): validate canonical import workflow` | Provider-free three-range replay, authoritative regression matrix, and this ledger                                                                         |

## Canonical Invariants

The checked-in three-range replay is
`packages/server/src/services/long-term-memory/__tests__/import-pipeline.spec.ts`.
It proves the following against the current HTTP route and file-backed vault:

- `damo`, `damo_korvak`, and `damo_considerate_nature` resolve to one Damo
  character note bound to the chat persona ID.
- `lisa_damo` and `damo_lisa` resolve to one relationship note with two sorted,
  distinct trusted subjects.
- No trait-shaped character note is written.
- Provider completion order is deliberately inverted while finalization remains
  in source order.
- Low-risk character facts merge additively. Medium-risk relationship changes
  remain pending until Review acceptance and rebase without losing the pair.
- The `composite_character_subject` warning survives draft persistence.
- Extraction accounting balances for every source.
- Import application publishes exactly one batch rebuild; manual Review
  acceptance is projected without per-draft rebuilds, then one complete
  generation is published and reported healthy.

Visibility remains independent from identity. Matching subjects do not bypass
chat, group, or character scope checks.

## Repair Proof

`identity-repair.spec.ts` covers the existing-data workflow with disposable
fixtures:

- preview is a dry run and is deterministic;
- ambiguous aliases remain unresolved;
- exact full-name title wins, with oldest-note fallback;
- additive sections, metadata, references, and pending drafts are rewritten;
- duplicates are archived only after confirmation;
- superseding conflicts require an explicit selection;
- a root backup is created before writes and can be restored;
- injected write failure restores the complete root;
- successful repair publishes one generation and passes index integrity;
- a second preview is idempotent and offers no completed repair again.

## Validation Record

| Command                                                                              | Result                                                                                             |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `pnpm regression:prompt`                                                             | Passed, including structured Damo/Lisa normalization and relationship metadata                     |
| Four focused LTM server specs                                                        | 35 passed, 0 failed                                                                                |
| `pnpm --filter @marinara-engine/server test`                                         | 322 passed, 0 failed                                                                               |
| `pnpm exec playwright test -c playwright.config.ts e2e/core-flows.e2e.ts --grep LTM` | 11 passed, 11 expected project-specific skips                                                      |
| `pnpm check`                                                                         | Passed static analysis and production builds; retained the existing 552.41 kB entry-chunk advisory |
| `git diff --check`                                                                   | Passed                                                                                             |

The browser proof is deterministic route interception. It does not call an
external model provider.
