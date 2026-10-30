---
name: soup
description: Use for any Marinara Engine or Marinara-Agents work that a user will see or touch, including panels, pickers, fields, chips, messages, toasts, empty states, setup flows, agent package UI and docs that describe them. S.O.U.P. (Simplify · Organize · Unify · Polish) is Gunterlie's product philosophy for Marinara. It is a lens for planning, implementing, reviewing and filing UI work, not a visual style guide. Also use when asked to file or write a soup/ issue or PR, inventory duplicated UI, run a persona walkthrough of a surface, or judge whether a change belongs in the Engine's existing screens.
---

# S.O.U.P. 🥣

**S**implify · **O**rganize · **U**nify · **P**olish

*An intuitive Marinara, built on clear interaction rules, thoughtful UX, and a cohesive, polished UI.*

S.O.U.P. is a philosophy, not a design. It has one question and two rules. The four words are the means, not the goal.

## The question

> **Where would a new user intuitively look for that thing?**

Every Thing in the Engine (a panel, a row, a field, a chip, a setting, a message) lives where a person who has never seen Marinara would look for it. If you have to tell them where it is, it is in the wrong place.

Answer the question in the user's voice before any code. Three voices cover almost every case:

| Voice | What it demands |
| --- | --- |
| *"I have a NanoGPT account, where do I put it?"* | The Thing is where I would look. No new screen, tab or button when a row in a list I already know can hold it. |
| *"I have no idea what I'm doing."* | The UX helps me understand and guides me. I do not like reading, so controls and defaults over text. |
| *"A Thing should look and behave the same everywhere in the Engine."* | Familiar UI. Once I have learned a Thing in one place, I already know it everywhere else. |

## The two rules

1. **Guide, don't explain.** When the user is lost, the interface moves them forward with as little text as possible: a sensible default, one obvious next step, a chip with a "Set up" button. Never a sentence that tells them to go somewhere else.
2. **One Thing, one look, one behaviour.** A model shows as its picture, its name, then "account · via X" in a Jobs row, a fallback line, a closed field and a picker alike. A picker searches, pages and handles keyboard the same way for characters, languages and models. If a Thing looks different in two places, one of them is wrong.

## The four words as means

- **Simplify.** Fewer places to look, fewer steps, less text. Delete before adding.
- **Organize.** Put the Thing where the question says it belongs. Group by what the user owns (an account, a folder), not by how the code is shaped.
- **Unify.** One shared component replaces every copy. Extract at the second exact copy or the third similar one, never with a single caller.
- **Polish.** Keyboard, touch, phone width, both themes, localization and empty states, done once in the shared Thing so every caller gets them.

## Red flags

Any of these in a plan, a diff or a review comment means S.O.U.P. is being broken:

- Copy that says "go to Settings → X" or names a path. Replace it with the action itself.
- A new screen, tab, modal or button where an existing list could take a row.
- A paragraph of explanation where a default, a placeholder or a chip would do.
- A second copy of a picker, select, chip or message with its own markup and state.
- The same Thing rendered as plain text in one place and as a tile with a subtitle in another.
- An unread first-run state, an intro panel or a tutorial step that exists because the UI itself does not guide.
- A fix applied to one caller when the Thing is shared and the fix belongs in the shared part.

## How a S.O.U.P. item is done

1. **Inventory.** Read-only scan of the UI source: `packages/client/src` in the Engine, `sources/<package>/` in Marinara-Agents (its `packages/**/client.js` is generated output, never the thing to read). Produce a table of every place the Thing appears, with file and approximate line, grouped into: move to the shared part, leave as is with a reason, special-purpose. Engine issue #7803 is the reference shape.
2. **Write the voices.** One line per affected voice, as a quote. These become the issue's "What problem does this solve?" and the PR's "Why".
3. **Mockup before code.** An interactive HTML mockup, or an in-Engine preview on a dev deployment, goes to the maintainer before merge-scale work. Record the approval in the issue.
4. **Walkthrough.** Three blind persona agents, one per voice, try to reach a goal on the mockup and report where they looked. It costs three small browsing agents, so it runs once on the mockup and once on the running Engine before the PR is ready, not per commit. Load [reference/walkthrough.md](reference/walkthrough.md) only when running it; it holds the briefs, the tool and token budgets and the report schema.
5. **Migrate one caller per small PR.** Keep current behaviour. Screenshots at 390, 768 and 1440 px in both themes are the proof.
6. **Shared parts have a home.** In the Engine, `components/ui/` takes domain-free parts fed by props only, `components/<entity>/` takes parts that read one entity, and `features/` stays self-contained, so anything imported from outside moves out. An agent package reuses the Engine's shared parts through the capability API before building its own.
7. **Quality lives once.** Localization keys, keyboard and focus, mobile layout and theme tokens go in the shared part, never per surface.

The repository's own rules still apply on top: `AGENTS.md` and `CONTRIBUTING.md` in either repo, plus `packages/client/.instructions.md` and `.github/agents/chai-workflow.md` in the Engine. For deep UX critique use the `impeccable` skill; S.O.U.P. decides *where* and *whether*, `impeccable` refines *how it feels*. The walkthrough and `impeccable critique` answer different questions, so never run both for the same one.

## Conventions

- Issues and PRs start with the banner, copied exactly:

  ```markdown
  > **Part of S.O.U.P. 🥣**
  > **S**implify · **O**rganize · **U**nify · **P**olish
  >
  > *An intuitive Marinara, built on clear interaction rules, thoughtful UX, and a cohesive, polished UI.*
  ```

- Label `soup`. Title prefix `soup/`. Branch prefix `soup/`. Browser tests named `soup/...`. The same conventions apply in Marinara-Agents; UI that ships in a package is filed there, host UI in the Engine.
- The issue uses the feature-request template: problem in the user's voice, proposed solution, alternatives considered, implementation owner.
- The PR follows the repository template: a TL;DR line, `Closes #`, Why, What changed written from the final diff, validation boxes left unchecked, automated results with commit hashes, manual items phrased "Manually verify X", UI evidence as screenshots.

## Self-review before "done"

Answer each in one line. A "no" is a finding, not a note.

- Would a new user look here for this Thing without being told?
- Did I remove text, or add it?
- Can a lost user get unstuck with one tap from where they are?
- Does this Thing now look and behave like itself everywhere else in the Engine?
- Did I delete the copies I replaced?
- Does the shared part carry the keyboard, phone, theme and localization work, so no caller has to?
- If a walkthrough ran, did every persona reach the goal, and are the stalls in the PR as "Manually verify" items?
