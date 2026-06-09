# Bunny ready transition fixture

This fixture exists only to exercise the draft-to-ready Bunny Review path.

Expected coverage:

- Opening as draft lets Bunny record a draft review for the first head SHA.
- Marking ready for review dispatches Bunny again even when the same SHA was already reviewed.
- The ready event requests full mode so ready-policy status is recomputed.
