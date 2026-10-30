# S.O.U.P. walkthrough

Three persona agents try to reach a goal on a surface and report where they looked, not what they think. It answers the one question empirically: *where would a new user look for this Thing?*

It is not a design critique. For scores, hierarchy and feel, run `$impeccable critique` afterwards on the same surface. Do not run both for the same answer.

## Cost, and when to run it

A run is three small browsing agents. Each one spends tokens on page snapshots, so the budgets below are not optional. Run it:

1. **On the HTML mockup**, once the mockup exists. Static page, no server, no data, personas run in parallel with no interference. This is the cheap run and the one that changes the design.
2. **On the running Engine**, once, before the PR is marked ready. Fresh profile, personas run one after another, test data reset afterwards. Skip this run for a mockup-only change.

Do not run it on every commit, after cosmetic changes, or on a surface the user did not ask about.

## Inputs

The person running it supplies:

| Input | Example |
| --- | --- |
| `surface` | A URL: `file:///.../mockup.html`, `http://localhost:5174`, or a dev deployment. For an agent package, an Engine with the package installed. |
| `start` | Where the persona begins, in user words: "the Home screen with no chats". |
| `goals` | One goal per voice, in user words. See the briefs. |
| `thing` | The one Thing the third voice has already seen, and where: "a model row in the Jobs box". |

Nothing else. The personas never receive the plan, the issue, the PR, the diff, component names or file paths. If the brief names a component, it is not blind.

Two things about the surface are allowed in the brief, because they are facts about the page and not about the design:

- **It is a static mockup.** Say so: "This is a prototype page, so some controls do nothing when clicked. A click that does nothing still counts as an action; record what you expected to happen." Without this a persona stops after the first dead click and the run only proves the mockup is static. With it, the first click is still the data, and the report says what they expected to open.
- **It has a harness.** If the page carries switches, captions or a heading that are not part of the app, name them once and tell the persona never to click or read them.

A goal that depends on a control the mockup does not wire up (an Add window, a picker) cannot be judged on the mockup. Note it as a ceiling in the merge and leave it to the Engine run.

## Tools and budgets

Each persona agent gets browser tools only. No repository read, no search, no file edits, no shell.

- **One new tab per persona.** Never reuse an open tab, even at the right URL. Set `document.title = "[P1] " + document.title` after navigation so tabs can be told apart.
- **Text snapshots over screenshots.** A snapshot (accessibility tree) costs text tokens; a screenshot costs image tokens. Take a snapshot after each action and only then. Take at most **two screenshots**: one at the stall point, one at the goal if reached.
- **15 actions** (click, type, key press, scroll). The agent stops at 15 whether or not the goal is reached and reports where it was.
- **Read only what is on screen.** No source, no docs, no help pages the surface does not itself link to.
- **Report in the fixed schema**, at most 30 lines. No prose summary before or after it.
- **Smallest model that drives a browser reliably.** In Claude Code pass `model: "sonnet"` to the Agent tool. The merge is done by the caller from three short reports, never by a fourth agent.

On the running Engine, add:

- Run the three personas **in sequence**, not in parallel. One persona adding an account changes what the next one sees.
- Start each persona from the same state. Reset the profile or restore the test data between runs.
- Treat the dev server as shared and fragile. If it is not already running, ask before starting one.

## The three voices as briefs

Fill the brackets from the inputs. Each brief is the whole prompt the persona gets, plus the schema below.

**P1 · "I have a [thing], where do I put it?"**

> You just installed Marinara. You have [an API key for NanoGPT / a character card / a lorebook file]. You want [to get a reply in a chat / to use it]. You have used other chat apps but never this one. You do not read instructions; you look for where the thing you are holding obviously goes. Open [surface], start at [start], and try. Stop after 15 actions.

**P2 · "I have no idea what I'm doing."**

> You have never used anything like Marinara. A friend said it can [goal in plain words, e.g. "put pictures in your chats"]. You do not know the words "agent", "connection", "model", "job" or "preset". You dislike reading: if a screen has a paragraph, you skim the first line and look for a button. Open [surface], start at [start], and try to make it [goal]. Stop after 15 actions.

**P3 · "I know this Thing from somewhere else."**

> You have used Marinara for a week. You know [thing] as it looks in [where you saw it]: [one sentence describing it as it appears there]. Now you need to [goal, e.g. "change which model the Agents job falls back to"]. You expect the same Thing to look and behave the same way here. Open [surface], start at [start], and do it. Stop after 15 actions. Note anywhere the Thing looks or behaves differently from what you already know.

## Report schema

Every persona returns exactly this. Quotes are verbatim on-screen text.

```text
persona: P1 | P2 | P3
reached_goal: yes | partial | no
actions_used: <n of 15>
first_click: "<label>" in <where>
path: <where> -> <where> -> <where>   (one hop per action, labels as shown on screen)
stalled_at: <where> | none
stall_reason: <one line: what they expected to see and did not>
text_read: "<quote>" | "<quote>"   (only text they actually read to decide)
text_skipped: <where a paragraph was skipped and what they clicked instead>
wrong_turns: <n> - <where> for <why it looked right>
differs_from_known: <P3 only: what looked or behaved differently>
lost_moment: <the single action after which they no longer knew what to do> | none
one_line: <their own words>
```

## Merging

The caller reads the three reports and produces one table, no more than this:

| | P1 | P2 | P3 |
| --- | --- | --- | --- |
| Reached goal | | | |
| Actions used | | | |
| First click | | | |
| Stalled at | | | |
| Lost moment | | | |

Then at most five findings, each one sentence in the user's voice, ordered by how many personas hit it. A finding names a place and an expectation: "P1 and P2 opened Chat Settings first and never found the sidebar."

Findings go into:

- the issue's "What problem does this solve?" or the PR's "Why", as quotes;
- the PR's manual verification list, as "Manually verify a first-time user can ...";
- the inventory, if a persona found a second copy of the Thing.

## Harness notes

- **Claude Code.** Three Agent-tool calls in one message, `model: "sonnet"`, the brief as the whole prompt, tool access limited to the browser MCP. Parallel on a mockup; sequential on the Engine. Do not use a Workflow script for this; three agents need no orchestration.
- **Codex.** The same with subagent spawning. Without subagents, run the three briefs one after another in the main session, each in its own tab, and discard each tab's snapshots before starting the next brief.
- **No browser tools.** Do not fake it from source. Say the walkthrough was not run and list the three goals as manual verification items.

## Ceiling

An agent persona reads faster and more patiently than a person, so it under-reports "too much text". Weight any `text_skipped` entry heavily. It also cannot be surprised by latency or a half-loaded page, so stalls on the running Engine that do not reproduce on the mockup are worth a human look.
