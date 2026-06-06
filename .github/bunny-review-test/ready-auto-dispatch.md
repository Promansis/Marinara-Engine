# Bunny ready auto dispatch fixture

This fixture exists only to exercise Bunny Review automation on a ready pull request targeting `refactor`.

Expected coverage:

- `pull_request_target` auto dispatch runs for a non-draft PR.
- Required CI check collection uses exact names from `ci-checks.json`.
- Ready status policy can fail for blocking/high findings, failed required CI, or pending/missing required CI.
