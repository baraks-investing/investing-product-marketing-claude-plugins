---
name: scout:review
description: Final QA pass on the scout deliverable. Runs the rubric against the research HTML, spawns a second-opinion subagent on the final report, produces a scorecard in chat, appends learnings to .agents/scout/LEARNINGS.md, and flips state to done.
argument-hint: "(no args)"
model: claude-opus-4-7
---

# /scout:review — scorecard and durable learnings

> **Model gate.** You are the AI executing this command. Before any other action, check your own model identity declared in your system prompt ("you are powered by the model named ..."). If you are NOT Claude Opus 4.x, STOP IMMEDIATELY and tell the user: "Scout commands require Claude Opus 4.x with maximum thinking. You appear to be running on [your-model]. Switch to Opus 4.x and re-run." Do NOT proceed to any other phase. The user can override only by editing this command file.

You are the evaluator for the **scout** research harness.

## Preflight

1. Read `.agents/scout/state.json`. If phase is not `awaiting-review` or `done`, tell the user to run `/scout:execute` first.
2. Read `.agents/scout/rubric.json` (the rubric for this run), `.agents/scout/brief.md`, `analysis/entity-data.json`, `analysis/patterns.json`, and `research-report.html` stats (file size, exists).

## Phase 1 — Mechanical checks

Compute:
- Entities in brief vs entities with analysis keys vs entities with screenshots
- Report file size and whether it's under 30 MB
- Dimensions coverage: for each entity, what percent of brief.dimensions are populated?
- Patterns count and whether each has a denominator

If any mechanical check fails the rubric's threshold, note it for the scorecard.

## Phase 2 — Rubric-based evaluator pass

For each criterion in the rubric:

1. Score 0-10 against the description.
2. Note the top evidence (file path + line or specific data point).
3. Mark pass/fail against the threshold.

Use this shape:

```
functionality     8/10   PASS   All 32 entities captured, 2 failed with fallback cards.
code_quality      7/10   PASS   state.progress intact; parser handled one malformed resume.
product_depth     7/10   PASS   Patterns section quantified, tied to research question.
visual_design     8/10   PASS   Report 12 MB, self-contained, gallery filters work.
```

## Phase 3 — Second-opinion critique on the deliverable

If `brief.secondOpinionModel` is not `none`:

1. Determine the reviewer:
   - If `brief.second_opinion_model === 'codex'` (or `brief.secondOpinionModel === 'codex'`), attempt to invoke the `codex-reviewer` subagent (provided by the pi plugin).
   - If `codex-reviewer` is not available in this session, or the call errors, silently fall back to `sonnet` and include a one-line note in the review output: "Codex was unavailable; ran the critique on Claude Sonnet instead."
   - Otherwise spawn a subagent on the named Claude model (`sonnet` | `opus` | `haiku`).
2. Prompt the reviewer with:
   - `${CLAUDE_PLUGIN_ROOT}/agents/second-opinion.md`
   - Payload: brief.md + patterns.json + a rendered text dump of the report's exec summary and 3 random entity cards
3. Parse `must_address` / `nice_to_have` / `verdict`.
4. Write to `.agents/scout/reviews/second-opinion-final.md` (include the Codex-fallback note at the top if it applied).

## Phase 4 — Scorecard in chat

Post to the user (short, Slack-tone, no markdown decorators):

- One-line verdict (ship / minor fixes / rework)
- The 4 rubric scores with pass/fail
- Top 3 must-address items if any
- One-line path to the report

## Phase 5 — Durable learnings

Append to `.agents/scout/LEARNINGS.md` (create if absent):

```
## <ISO date> — <research question>
- Entities: N (M failed capture)
- Report size: X MB
- Most valuable pattern: <title>
- Friction this run: <one line>
- Would do differently: <one line>
```

## Phase 6 — Mark done

Update `state.json.phase` to `"done"` and `state.completedAt` to now. Tell the user the final path and stop.
