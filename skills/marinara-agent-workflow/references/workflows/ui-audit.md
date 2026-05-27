# UI Audit Workflow Card

Use this when the user asks to map the UI, audit confusing controls, simplify workflows, review labels, or decide which actions should be renamed, merged, moved, hidden, or removed.

## Scope First

- Pick one surface or workflow at a time: app shell, mode surface, catalog/resource editor, settings, onboarding, or Professor Mari.
- Name the user goal, primary path, likely user state, and owner files before judging controls.

## Surface Map First

- For whole-UI requests, map breadth before auditing depth.
- List each surface, user goal, primary actions, risky actions, likely owner files, and obvious decision points.
- Use the map to choose the first two or three detailed audit targets by user confusion and product risk.
- Do not deeply critique every control during the map pass.

## Control Inventory

For each visible action, record: surface, user goal, control text or icon, component/file when known, action/result, state, risk, and recommendation.

## Review Checks

- Ask whether each control has one clear job, user-language label, visible state, consequence, and matching hierarchy.
- Flag icon-only controls without discoverable names, duplicate actions, vague verbs, conflicting primary actions, risky actions near routine actions, hidden state changes, unexplained disabled/loading states, and advanced controls exposed before the primary path needs them.
- Count choices at each decision point. More than four visible action choices need a simplification recommendation unless the surface is explicitly expert-only.

## Simplification Moves

- Prefer rename, regroup, change hierarchy, move to overflow, progressive disclosure, merge, or remove in that order.
- Keep destructive, import/export, provider, persistence, and security-sensitive actions explicit. Do not simplify by hiding consequences or confirmations.
- If simplification changes product behavior, switch to feature-build and name the product decision.

## Output Shape

- Lead with the top findings, ordered by user impact.
- Include a compact inventory table when it clarifies the map; skip exhaustive tables when they add noise.
- For each finding, state the confusing control, why it matters, proposed simplification, owner surface/file, and proof needed.
- Separate "can fix now" from "needs product decision."
- Do not create durable repo notes or screenshots unless requested.
