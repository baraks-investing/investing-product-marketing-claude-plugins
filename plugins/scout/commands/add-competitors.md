---
name: scout:add-competitors
description: Add additional competitors to a completed scout run, re-verify, and re-render the report.
argument-hint: "<urls or names, space-separated>"
model: claude-opus-4-7
---

# /scout:add-competitors — extend a completed scout run

> **Model gate.** You are the AI executing this command. Before any other action, check your own model identity declared in your system prompt ("you are powered by the model named ..."). If you are NOT Claude Opus 4.x, STOP IMMEDIATELY and tell the user: "Scout commands require Claude Opus 4.x with maximum thinking. You appear to be running on [your-model]. Switch to Opus 4.x and re-run." Do NOT proceed to any other phase. The user can override only by editing this command file.

You are extending a completed scout run with additional competitor entities. The original `/scout:execute` deliverable already wrote the full state — `brief.json`, `entity-data.json`, `patterns.json`, `capture-metadata.json`, `.layer3-verdicts.json`, `failed-candidates.json`. This command captures + verifies the new candidates, merges them into all those files, recomputes the cross-entity patterns over the full set, and re-renders `research-report.html`.

Cost note: a full aggregator re-run on the merged set is ~15–20s per added entity for capture + verify, plus a full aggregator pass. Heads-up if the user is adding 10+ entities at once.

## Phase -1 — Prerequisite check (auto-install if missing)

Before anything else, verify scout's runtime dependencies are installed in the plugin folder.

1. Use the Bash tool to run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/plugins/scout/lib/prereq-check.js"
   ```
   Parse the JSON output.

2. If `ok === true`, continue. If `ok === false`, follow the same recovery path as `/scout:plan` Phase -1: surface the actionable hint to the user, run `lib/install-deps.js` on consent, abort on failure or decline.

## Phase 0 — Preflight

1. Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/plugins/scout/lib/add-competitors.js" --action preflight --root "$PROJECT_ROOT"
   ```
   Parse the JSON output. If `ok === false`, print the `reason` field verbatim to the user and STOP. Do not modify any state.

2. If `$ARGUMENTS` is empty, ask the user inline: "Which competitors do you want to add? Paste URLs or names, space-separated." Then re-read the value. If still empty, abort.

## Phase 1 — Parse arguments

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/plugins/scout/lib/add-competitors.js" --action parse-args --args "$ARGUMENTS"
```

This returns `{ candidates: [{ kind: 'url'|'label', raw, url, id, label }] }`. Tokens with dots/slashes are treated as URLs; everything else is a label that you (the agent) need to resolve to a URL via the same seed-discovery logic `/scout:plan` uses. For label-only candidates, propose the URL inline ("I'm reading 'attio' as https://attio.com — confirm or correct"). Wait for confirmation before continuing.

## Phase 2 — Filter against existing entities

Pipe the candidates JSON to:
```
echo "$CANDIDATES_JSON" | node "${CLAUDE_PLUGIN_ROOT}/plugins/scout/lib/add-competitors.js" --action filter-new --root "$PROJECT_ROOT"
```

The output `{ fresh: [...], skipped: [...] }` separates new from already-present candidates. For each `skipped` entry print `<label> already in entity set, skipping.` to the user. If `fresh` is empty, print `Nothing new to add.` and STOP.

## Phase 3 — Capture + vision verification

For each candidate in `fresh`:

1. Invoke `lib/capture.js` programmatically (require it from a small Node one-liner via Bash) with `mode: 'full'`, the candidate's URL, and `outputDir: <project>/screenshots`. Use `metadataPath: <project>/analysis/.add-competitors-capture-tmp.json` for the temp metadata.

2. If capture fails (exit non-zero, no screenshot file), tag the candidate as rejected with reason `'capture failed: <error>'` — it goes to `failed-candidates.json`, NOT to `brief.entities`.

3. If capture succeeds, run vision verification using the existing `brief.inclusion_criteria` from `brief.json`. Use the same vision-verify prompt the `/scout:execute` Phase 2 uses (see the README — judge prompt expects `{ url, screenshotPath, inclusion_criteria }` and emits `{ verdict: 'yes'|'partial'|'no', rationale, source_trust, pattern_y_start, pattern_y_height }`).

4. Build a results JSON:
   ```json
   {
     "verified": [{ id, label, url, category, source: 'manual', source_trust, verdict, rationale, screenshotPath, pattern_y_start, pattern_y_height,
                    captureResult: { status, file, captured_at, content_hash } }],
     "rejected": [{ id, label, url, source: 'manual', source_trust, reason }]
   }
   ```
   Verdict `'no'` candidates go in `rejected`. Verdict `'yes'` and `'partial'` go in `verified`.

## Phase 4 — Merge state

Pipe the results JSON to:
```
echo "$RESULTS_JSON" | node "${CLAUDE_PLUGIN_ROOT}/plugins/scout/lib/add-competitors.js" --action merge-results --root "$PROJECT_ROOT"
```

This updates in place: `brief.entities`, `.layer3-verdicts.json`, `capture-metadata.json`, `failed-candidates.json`. Output JSON tells you the new entity count.

## Phase 5 — Per-entity analysis on new entities only

For each newly-verified entity (verdict yes/partial), invoke the `scout-generator` subagent with the same prompt `/scout:execute` Phase 1 uses. The subagent returns a JSON object with all dimension fields PLUS the `per_entity_insight` string (T01 schema requirement — do not omit it). Merge each returned object into `analysis/entity-data.json` keyed by the entity id. Existing entities' analysis is preserved untouched — do NOT re-run analysis on the original cohort.

## Phase 6 — Aggregator re-run on the FULL merged set

Run the patterns aggregator on the entire `brief.entities` list — same prompt and shape `/scout:execute` Phase 2 uses. Output goes to `analysis/patterns.json`, replacing the prior file. The aggregator emits the new T01 fields:
- `bestPractices[].gallery_entities[]` — 1–3 entity ids per practice, each constrained to be a subset of `evidence_entities`.

The denominators in `patterns[]` reflect the new total entity count.

## Phase 7 — State invariant check

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/plugins/scout/lib/add-competitors.js" --action check-invariant --root "$PROJECT_ROOT"
```

If `ok === false`, surface the `missing`, `dual`, or `rejectedInBrief` arrays to the user — these indicate state corruption that must be fixed before re-rendering. Do NOT continue to Phase 8 if the invariant fails.

## Phase 8 — Re-render report

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/plugins/scout/lib/build-report.js" --root "$PROJECT_ROOT"
```

This regenerates `research-report.html` against the merged state. The original `framework_lens` from `brief.json` is preserved — it is not reset by this command.

## Phase 9 — Summary

Print exactly one line to the user:
```
Added N entities (X yes, Y partial, Z rejected). Report re-rendered: research-report.html
```

Where N = X + Y + Z. Do not add suggestions or follow-up questions.
