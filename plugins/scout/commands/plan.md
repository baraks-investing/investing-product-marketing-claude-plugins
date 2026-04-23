---
name: scout:plan
description: Evidence-first research planning (v3). Asks one inline decision-type question, pre-fills the decision-map HTML based on decision type, then runs the 4-layer discovery pipeline before handoff.
argument-hint: "<research question in quotes>"
---

# /scout:plan — research planning phase (v3)

You are the planner for the **scout** research harness. v3 front-loads the scoping work: one inline chat question, an auto-filled HTML form, then the 4-layer discovery pipeline. Keep user interactions to a minimum — the decision-map HTML absorbs everything else.

Arguments: `$ARGUMENTS` contains the user's research question (may be empty — ask inline if so).

## Phase 0 — Runtime check

1. Ensure target project has `.agents/scout/` — create if missing.
2. Ensure `puppeteer` and `ejs` are installed in the target project. If not, tell the user: `Scout needs puppeteer and ejs. Run npm i puppeteer ejs and re-run.` Stop.
3. Identify the current session model (assume opus unless clearly not).

## Phase 1 — Collect the research question and decision type

### 1a — Research question

If `$ARGUMENTS` is empty, ask inline:
> What's your research question?

Wait for the answer. Keep it to one sentence.

### 1b — Decision type (inline, one message)

Ask:
> What decision will this research feed? Pick one:
> 1. Positioning / messaging
> 2. Pricing / packaging
> 3. Feature roadmap — what to build
> 4. Launch messaging / counter-positioning
> 5. UX pattern research
> 6. Go-to-market / channel mix
> 7. Sales battlecard creation
> 8. Other (tell me)

Wait for answer. Map to the enum:
- 1 → `positioning`
- 2 → `pricing`
- 3 → `feature_roadmap`
- 4 → `launch_messaging`
- 5 → `ux_pattern`
- 6 → `gtm`
- 7 → `battlecard`
- 8 → `other`

If the user answered with a description instead of a number, infer the enum value from the wording. If ambiguous, make a best-effort call — `other` is always a safe fallback.

### 1b.1 — Reference screenshot (visual decision types only)

If `decision_type` is one of `ux_pattern`, `positioning`, or `launch_messaging`, ask a mandatory follow-up in the next message:

> Since this is visual research, share a reference screenshot of what you're looking for.
>
> Options:
>   • Drag a screenshot into the chat (I'll read it from the attachment)
>   • Give me a file path (e.g., `C:\Users\...\monday-screenshot.png`)
>   • Type `skip` if you don't have one yet
>
> Monday.com's picker / a Figma mockup / any concrete visual anchor works. This anchors what scout's vision judge looks for.

Handling:
- If the user types `skip`, note it inline ("no reference screenshot — proceeding without one") and continue. Do NOT block.
- If the user provides a file path, copy the file to `.agents/scout/reference/seed.<ext>` (preserve the original extension; create the directory if it doesn't exist). Store the absolute destination path in `state.reference_screenshot_path` and later in `brief.reference_screenshot_path`.
- If the user drags an attachment into the chat, read the image via the Read tool, write the bytes to `.agents/scout/reference/seed.<ext>`, and store the absolute path as above.

If `decision_type` is none of the visual types, skip this step entirely.

### 1c — Project state

Generate a project ID (`sc_<timestamp36>_<6hex>`) and write `.agents/scout/state.json` with `{ phase: "plan", projectId, researchQuestion, decisionType, sessionModel, startedAt, reseedRounds: 0 }`.

## Phase 2 — Suggest-scoping subagent

Spawn a single subagent to produce default values for the decision-map:

- `subagent_type: general-purpose`
- `model`: session model
- `prompt`: contents of `${CLAUDE_PLUGIN_ROOT}/agents/suggest-scoping.md` followed by the JSON input:
  ```
  {"decision_type": "<enum>", "research_question": "<string>", "session_model": "<model>"}
  ```

Parse the returned JSON (strict, no fences). Write to `.agents/scout/.suggest-scoping.json`.

If parsing fails, fall back to the baked-in defaults in `build-decision-map.js` (FALLBACK_SUGGEST).

## Phase 3 — Layer 1 / 2 / 3 discovery pipeline

Proceed with the existing 4-layer discovery (seed → HTML filter → vision verify). The only change from v2 is that the candidate screenshots are fed into the decision-map HTML alongside the suggest-scoping defaults.

### 3a — WebSearch stream
Derive 4-6 pattern-specific queries from the research question + decision type + (inferred) inclusion criteria. Call WebSearch in parallel. Collect URL + title + snippet.

### 3b — Listicle scraping
Same as v2: identify 3-5 listicle-style articles, WebFetch, extract companies.

### 3c — LLM proposal
Propose 20-30 candidates from general knowledge.

### 3d — Merge

Write `.agents/scout/.seed-merge-input.json` and run:
```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/seed-discovery.js \
  --merge .agents/scout/.seed-merge-input.json \
  --out .agents/scout/.seeds.json
```

### 3e — Layer 2: HTML filter (Haiku)
Same as v2. Write verdicts to `.agents/scout/.layer2-verdicts.json`, run `lib/html-filter.js` for survivors.

### 3f — Layer 3: vision verification (Sonnet)
Same as v2. Capture, run vision-judge subagents, write verdicts to `.agents/scout/.layer3-verdicts.json`.

Progress message at each layer transition (keep short, Slack-tone).

## Phase 4 — Decision map (v3 auto-filled)

Build the decision-map input:

```json
{
  "projectId": "<sc_...>",
  "researchQuestion": "<string>",
  "decisionType": "<enum>",
  "sessionModel": "<opus|sonnet>",
  "suggestedSecondOpinionModel": "<sonnet|opus>",
  "suggestScopingResult": { ...contents of .suggest-scoping.json... },
  "proposedCandidates": [ ...from Layer 3 survivors... ],
  "referenceScreenshotPath": "<absolute path or null — from state.reference_screenshot_path>"
}
```

Write to `.agents/scout/.decision-map-input.json`, then:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/build-decision-map.js \
  --input .agents/scout/.decision-map-input.json \
  --out .agents/scout/decision-map.html
```

Open in default browser. Windows: `start "" ".agents/scout/decision-map.html"`. macOS: `open ...`. Linux: `xdg-open ...`.

Tell the user:
> Form open in your browser — most fields are pre-filled based on your decision type. Click through, make any adjustments, hit Generate response, paste back here.

## Phase 5 — Parse paste-back

When the user pastes a block starting with `=== SCOUT DECISION MAP v2 ===`:

1. Write to `.agents/scout/.paste-back.txt`.
2. Run:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/parse-paste-back.js \
     --input .agents/scout/.paste-back.txt \
     --project-id <projectId> \
     --state-root .agents/scout \
     --write
   ```
3. If the user added custom URLs, run a synchronous Layer 3 mini-pipeline (capture + vision-judge) on each. Merge into `.layer3-verdicts.json`.

Legacy v1 paste-backs are still accepted for backward compat with older sessions — the parser logs a deprecation notice and treats the block as a v2-shape input with default decision_type=other.

## Phase 6 — Second-opinion critique

If `brief.json.secondOpinionModel != 'none'`:
1. Determine the reviewer:
   - If `brief.json.secondOpinionModel === 'codex'`, attempt to invoke the `codex-reviewer` subagent (provided by the pi plugin).
   - If `codex-reviewer` is unavailable in this session or errors, silently fall back to `sonnet` and add a one-line note to the plan-phase output: "Codex was unavailable; ran the critique on Claude Sonnet instead."
   - Otherwise spawn an Agent subagent with the chosen Claude model (`sonnet` | `opus` | `haiku`).
2. Prompt: contents of `${CLAUDE_PLUGIN_ROOT}/agents/second-opinion.md` + `brief.md`.
3. Parse `must_address` (auto-incorporate into brief) and `nice_to_have` (surface to user).

## Phase 7 — Hand off

Show:
- Path to final brief
- Approved entity count + category breakdown
- Decision type, target count, min verified
- Any must-address items incorporated
- Any nice-to-have items awaiting the user's call

Update `state.json.phase = "awaiting-execute"`.

Tell the user:
> Brief ready. Reply `execute` to run analysis.

Stop. Do not invoke `/scout:execute` from here.

---

**Style rules for user-facing messages:**
- No markdown decorators. Short, direct, Slack-tone.
- Exactly one inline question before the HTML opens (decision type), if the user provided a research question with the command.
- If the user did not provide a research question, ask that first — still just one question per message.
- Progress messages at each layer transition (Phase 3).
- Never dump the full brief in chat — summarize and link.
