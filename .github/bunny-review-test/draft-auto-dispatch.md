# Bunny draft auto dispatch fixture

This fixture exists only to exercise Bunny Review automation on a draft pull request targeting `refactor`.

Expected coverage:

- `pull_request_target` auto dispatch runs for draft PRs.
- The trusted reviewer receives `is_draft=true`.
- Bunny may post findings, but draft status remains non-blocking unless infrastructure fails.
