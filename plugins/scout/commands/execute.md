---
name: scout:execute
description: Run per-entity analysis + cross-entity patterns + build the self-contained research HTML (v4). Adds adaptive re-seed when vision verification under-delivers, emits standalone mockup files, generates battlecards when decision_type calls for it, and forks synthesis by framework lens.
argument-hint: "(no args — reads .agents/scout/brief.json)"
---

# /scout:execute — analyze + build report (v4)

You are the executor for the **scout** research harness. The plan phase produced `.agents/scout/brief.json` (v4 schema: includes `decisionType`, `minVerified`, `reseedRounds`, `framework_lens`, `framework_lens_source`, `battlecard_enabled`, `battlecard_source`), Layer 3 verdicts, and captured screenshots.

## Preflight

1. Read `.agents/scout/state.json`. If `phase` is not `awaiting-execute` or `execute`, tell the user:
   > Scout isn't ready to execute yet. Run `/scout:plan` first.
   Stop.
2. Read `.agents/scout/brief.json`. Parse `entities`, `dimensions`, `mockups`, `minVerified` (default 15), `decisionType`, `framework_lens` (default `'descriptive'`), `battlecard_enabled` (default `false`). v3 briefs without these fields fall through to defaults.
3. Read `.agents/scout/.layer3-verdicts.json` — the approved, pre-verified, pre-captured subset.
4. Ensure `analysis/` exists at the project root.
5. Initialize `state.progress` as an array in `state.json` if missing. Ensure `state.reseedRounds` exists (default 1 — the initial round from /scout:plan counts).
6. **Tell the user which streams / lens / battlecard setting are active**, e.g.:
   > Running v4 pipeline · lens: Jobs-to-be-Done (inferred from positioning) · battlecards: on · 6 seed streams (Codex availability will be logged).

## v4 seed discovery — 6 streams in parallel

When /scout:plan ran Layer 1, it invoked seed-discovery with these streams in parallel:
1. `websearch` (existing)
2. `listicle` (existing)
3. `llm` — Claude proposals from memory (existing)
4. `codex_llm` — Codex proposals via the `codex-researcher` subagent (NEW, optional)
5. `product_hunt` + `hacker_news` — social signal APIs (NEW)
6. `g2_capterra` — category page scraping (NEW)

The `codex_llm` stream is wrapped in try/catch. If the subagent errors or is unreachable, scout writes `.agents/scout/.codex-status.json` with `{ "available": false, "reason": "<one-line>" }` and continues. When Codex does contribute, the file reads `{ "available": true }`. The rest of the pipeline is agnostic to Codex availability.

Each candidate carries `source_stream` and `source_trust: 'high' | 'medium' | 'low'`. Two-LLM consensus (same hostname proposed by both Claude and Codex) bumps a seed from `low` to `medium`. LLM proposals that are also confirmed by a `high`-trust source (e.g., found in a WebSearch vendor page) become `high`.

## v4 Layer 2 + 3 — trust-ordered processing

`lib/html-filter.js` and `lib/vision-verify.js` both iterate via the `sortByTrust` helper (`require('./seed-discovery').sortByTrust`). Candidates are processed high → medium → low, stable within each tier. If an adaptive re-seed budget exhausts or the run is killed mid-way, survivors skew high-trust.

If `state.phase === "execute"` and some entities are in `state.progress` with phase `"analyzed"`, skip those (resume).

## Phase 0 — Adaptive re-seed loop

**This runs only if the vision-verified count is below `brief.minVerified`.**

```
verified_count = count(verdicts where verdict in ['yes', 'partial'])

if verified_count >= brief.minVerified:
  skip to Phase 1

for round in [2, 3]:
  if state.reseedRounds >= 3: break

  tell user: "Layer 3 yielded {verified_count} verified — target is {brief.minVerified}. Running round {round} of up to 3."

  # Gather already-seen hostnames from previous rounds
  already_seen_domains = unique hostnames from .seeds.json + all prior .layer3-verdicts.json entries

  # Ask the planner model for fresh queries
  tell user: "Round {round}: searching for more candidates..."

  Regenerate 4-6 WebSearch queries using a different angle. The prompt to the
  orchestrator must explicitly list the queries already tried and say:
    "Propose 4-6 NEW queries using different phrasings, different source types
     (forums vs. listicles vs. vendor docs), different vertical slices. Do NOT
     re-use hostnames from this list: <already_seen_domains>"

  Run WebSearch + listicle + LLM streams again. Write merge input at
  .agents/scout/.seed-merge-input-round{round}.json with round and alreadySeenDomains:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/lib/seed-discovery.js \
    --merge .agents/scout/.seed-merge-input-round{round}.json \
    --out .agents/scout/.seeds-round{round}.json
  ```

  (The merge input JSON should include `"round": {round}, "alreadySeenDomains": [...]`.)

  Run Layer 2 (HTML filter) on new seeds. Run Layer 3 (capture + vision) on survivors.
  Merge new verdicts into .agents/scout/.layer3-verdicts.json.
  Append each round to state.progress as {round, seedsPath, verdictsPath, verified_delta}.
  Persist state.reseedRounds = round.

  verified_count = count yes+partial across ALL verdicts
  if verified_count >= brief.minVerified: break

after the loop:
  if verified_count < brief.minVerified:
    set brief.rarity_finding = true
    set brief.rarity_note = "After " + state.reseedRounds + " rounds of search, we found " + verified_count + " qualifying entities — this pattern appears genuinely rare in the wild."
    persist brief.json

    tell user (with a yes/no response expected):
      "Round {state.reseedRounds} complete. {verified_count} of {brief.minVerified} minimum verified.
       This pattern is rarer than initial search suggested.

       Options:
         1. Proceed — build the report with the {verified_count} we have, and flag rarity as a finding at the top.
         2. Redefine — I'll pause here so you can edit brief.json (minVerified, inclusion_criteria) before I continue.

       Default is 1 if you don't reply in 30 seconds. Type '2' to pause."

    if user types '2' within 30 seconds:
      stop and tell user: "Paused. Edit .agents/scout/brief.json then re-run /scout:execute to resume."
    else:
      proceed to Phase 1 with rarity flag set.
```

## Vision-verdict safety (Codex fix)

Every place this skill parses a JSON response from the vision-judge subagent, WRAP THE PARSE IN TRY/CATCH. On malformed JSON:
- Log the raw response to `.agents/scout/.vision-failures.json` (append mode)
- Treat the entity as `verdict: "no"` with `rationale: "vision verdict malformed — treated as rejected"`
- Continue processing remaining entities

Never let a single bad JSON response crash the entire Layer 3 loop.

**Hard guarantees:**
- Never more than 3 rounds total (first plan-phase round counts as round 1).
- Every round's seeds go to their own file (`.seeds-round{N}.json`) so resume is safe.
- If verified count crosses the threshold mid-loop, break immediately.

## Phase 1 — Per-entity analysis (resume-safe)

Initialize `analysis/entity-data.json` as `{}` if absent. Load existing contents.

For each entity in the approved set whose id is NOT already in `state.progress` with phase `"analyzed"`:

1. Spawn a generator subagent:
   - `subagent_type: general-purpose`
   - `model`: session model
   - `prompt`: contents of `${CLAUDE_PLUGIN_ROOT}/agents/generator.md` + entity metadata + dimensions list.
2. Parse response. Merge into `analysis/entity-data.json`.
3. Append `{entity_id, phase: "analyzed", ts}` to `state.progress[]`.

Batch 3-5 entities per call when they share category.

## Phase 2 — Cross-entity patterns (lens-forked)

Once every approved entity has phase `"analyzed"`, spawn a subagent with `analysis/entity-data.json`, the merged `.layer3-verdicts.json`, the research question, AND the active `brief.framework_lens`. All four lens variants still emit the standard cross-entity shape:

```json
{
  "execStats": [...],
  "bestPractices": [...],
  "patterns": [...],
  "recommendations": [...],
  "top_level_observations": [...]
}
```

### OUTPUT SHAPE — required keys (strict)

The report builder (`lib/build-report.js`) reads these exact keys. Emit them verbatim. `lib/build-report.js` translates a few common variants (see `normalizePatterns()`), but emitting the canonical shape avoids any drift. The subagent prompt must quote this block verbatim:

```
execStats: [{ label: string, main: string, sub: string }]
  - label: short title (3-5 words)
  - main: headline stat including count AND percent together (e.g., "16 / 30 · 53%")
  - sub: one-sentence interpretation

bestPractices: [{ rule: string, detail: string, evidence_entities?: string[] }]
  - rule: short imperative sentence ("Lead with product UI")
  - detail: one-paragraph rationale
  - evidence_entities: optional list of entity ids that prove the practice

patterns: [{ title: string, percent: number, count: number, denominator: number, description: string, examples: string[] }]
  - percent: 0-100, the proportion of entities matching this pattern (REQUIRED — the
    frequency chart renders a 2px sliver if this is missing)
  - count: raw numerator
  - denominator: raw denominator (usually total_entities)
  - examples: array of entity ids (NOT `entities` — that key is not read by the template)

recommendations: [{ title: string, body: string }]
  - NOT `rationale`; use `body`.

top_level_observations: string[]
  - Plain strings. The builder also accepts `observations: string[]` as an alias.
```

Forbidden variants that will silently render empty UI: `{name}` instead of `{label}`, `{note}` instead of `{sub}`, `{practice, rationale}` instead of `{rule, detail}`, `{evidence_count: "N / M"}` instead of numeric `{percent, count, denominator}`, `{entities}` instead of `{examples}`.

On top of that standard shape, fork the aggregator prompt based on `brief.framework_lens`. The lens-specific block is ADDITIONAL to the standard fields above — always produce both.

### Lens: `descriptive` (default, v3 behavior)

Use the v3 prompt unchanged. Output is only the standard shape. `bestPractices` framed neutrally.

### Lens: `jtbd` — Jobs-to-be-Done

Prompt emphasis:
> Cluster the entities by the CUSTOMER JOB they are hired for — "save time", "look professional", "collaborate with a team", "make the right investment decision", etc. Pick 3–6 distinct jobs. For each job, name the entities grouped under it, the patterns that characterize their approach, and the recommendations that follow.

In addition to the standard fields, emit a top-level `jobs` array:

```json
{
  "jobs": [
    {
      "job_name": "Save time on stock research",
      "job_description": "The investor has 15 minutes between meetings and needs one screen that summarizes health + valuation + momentum.",
      "entities": ["seeking-alpha", "simplywall", "..."],
      "patterns": ["One-page dashboard with 4-5 KPI tiles", "Auto-pulled news summary"],
      "recommendations": ["Lead InvestingPro landing with the dashboard view, not the feature grid"]
    }
  ],
  "execStats": [...], "bestPractices": [...], "patterns": [...], "recommendations": [...], "top_level_observations": [...]
}
```

`recommendations` in the standard block should tie back to the jobs (e.g., "Underserved job: …").

### Lens: `kano` — Feature-value classification

Prompt emphasis:
> Classify each major feature mentioned across the entity set as one of: `hygiene` (everyone has it — table stakes, doesn't drive conversion), `performance` (more is better — speed, accuracy, breadth), or `delighter` (unexpected, wins users when present). Count how many entities carry each feature.

In addition to the standard fields, emit a top-level `feature_classification` array:

```json
{
  "feature_classification": [
    {
      "feature_name": "Real-time quotes",
      "classification": "hygiene",
      "count_of_entities": 14,
      "examples": ["yahoo-finance", "marketwatch", "..."]
    },
    {
      "feature_name": "AI chart analysis",
      "classification": "delighter",
      "count_of_entities": 3,
      "examples": ["tradingview", "..."]
    }
  ],
  "execStats": [...], "bestPractices": [...], "patterns": [...], "recommendations": [...], "top_level_observations": [...]
}
```

`bestPractices` framed as "must-have hygiene features" vs "differentiating delighters."

### Lens: `price_anchor` — Pricing tier structures

Prompt emphasis:
> Extract tier structures. For each cluster of similar prices, report the price range, the competitors in that cluster, and how they visually badge the middle tier (e.g., "Most popular", "Best value", or no badge). Identify anchor exploits a newcomer could use.

In addition to the standard fields, emit a top-level `price_clusters` array:

```json
{
  "price_clusters": [
    {
      "price_range": "$9–15/month",
      "entity_count": 6,
      "example_entities": ["alice-co", "bravo-app", "..."],
      "badge_treatment": "4 of 6 badge the $12 tier with 'Most popular'."
    }
  ],
  "execStats": [...], "bestPractices": [...], "patterns": [...], "recommendations": [...], "top_level_observations": [...]
}
```

`recommendations` should be named for anchor exploits ("Break the $9–15 cluster by anchoring at $19 with visibly more features").

Write the full output to `analysis/patterns.json`.

## Phase 3 — Standalone mockups (v3)

If `brief.mockups.count` is `1`, `3-5`, or `5-7`:

For each concept (parse count from range — use lower bound, e.g., `3-5` → 3):

1. Spawn the mockup-designer subagent:
   - `prompt`: contents of `${CLAUDE_PLUGIN_ROOT}/agents/mockup-designer.md` + input JSON:
     ```json
     {
       "concept_title": "<derived>",
       "hypothesis_brief": "<one-liner>",
       "patterns": <patterns.json contents>,
       "entity_data": <entity-data.json contents>,
       "decision_type": "<brief.decisionType>",
       "visual_context": "<short brand note>"
     }
     ```
2. Parse strict JSON response. Validate: must have `state_before`, `state_after`, and every annotation must have `what`, `source_entities[]`, `why_it_works`, `why_it_fits_here`. If any annotation is incomplete, drop that annotation. If `state_before` or `state_after` is missing, re-prompt once.
3. Write the concept JSON to `.agents/scout/mockups/concept-{n}.json`.
4. Render the standalone file:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/build-mockup.js \
     --input .agents/scout/mockups/concept-{n}.json \
     --out-dir mockups \
     --index {n} \
     --back-href ../research-report.html
   ```
5. Record `{title, hypothesis, stateBefore, filePath: "mockups/concept-{n}-{slug}.html"}` in an array that will be passed into the research report.

Persist the array to `.agents/scout/mockups.json` and mirror the file paths into `brief.json.mockups`.

## Phase 3.5 — Battlecards (v4)

If `brief.battlecard_enabled` is `true`, spawn a `scout-battlecard-builder` subagent for each verified entity (verdicts with `verdict === 'yes'` or `'partial'`). Pass:

```json
{
  "entity": { "id": "...", "label": "...", "url": "...", "category": "..." },
  "entity_data": <entity-data.json entry for this entity>,
  "patterns_summary": "<3-sentence plain-text summary distilled from patterns.json>",
  "our_product_positioning": "<brief.our_product_positioning if set, else omit>"
}
```

Parse the strict JSON response (no markdown fence). Validate via `lib/build-battlecard.js`'s `validateBattlecard()` — 3 items each in `strengths`, `weaknesses`, `how_to_beat`; non-empty strings in `one_line`, `when_they_win`, `when_we_win`. On validation failure, re-prompt the subagent once. Then render:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/build-battlecard.js \
  --input .agents/scout/battlecards/<id>.json \
  --entity-id <id> \
  --out-dir battlecards \
  --back-href ../../research-report.html
```

(The input JSON should be `{ concept, entity }` where concept is the subagent's raw output and entity matches the input payload.)

Record each generated battlecard as `{id, label, category, filePath, bytes}` in `brief.battlecards[]` and persist to `.agents/scout/brief.json`. Append per-entity `{entity_id, phase: "battlecard", ts, filePath}` to `state.progress[]`.

If `brief.battlecard_enabled` is `false`, skip this phase entirely.

## Phase 4 — Build report

Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/build-report.js \
  --root . \
  --out research-report.html
```

The builder auto-loads brief.json, entity-data.json, patterns.json, capture-metadata.json, .layer3-verdicts.json, failed-candidates.json. It threads `captured_at` + `content_hash` onto each entity and renders them under every screenshot. It reads `brief.mockups` and renders the Mockups section as a card grid linking to the standalone files. For v4: it reads `brief.framework_lens`, `brief.framework_lens_source`, `brief.decisionType`, `brief.battlecard_enabled`, and `brief.battlecards` to render the lens readout, trust-dotted source chips, the lens-specific patterns block (Jobs / Kano table / Price clusters), and the Battlecards section + nav link.

Verify:
- File is under 30 MB. If larger, re-run capture with jpegQuality 60.
- Timestamps + hash truncations visible under screenshots.
- Mockup cards link to `mockups/concept-*.html` files that open cleanly.
- Battlecard cards (if enabled) link to `battlecards/<category>/<id>.html` files that open cleanly.
- Trust dots visible on source chips; lens readout names the active lens.

## Phase 5 — Hand off

Update `state.json.phase = "awaiting-review"`. Tell the user what ran and what was produced — include:

- Seed streams used (6 max) and whether Codex contributed (read `.codex-status.json`)
- Trust-tier breakdown of verified entities (X high / Y medium / Z low)
- Active framework lens + whether it was inferred or explicit
- Count of battlecards generated (or "skipped — not a sales-adjacent decision type")
- Report path and size

Example:
> Analysis complete. 6 streams ran (Codex: available). 18 verified · 8 high / 7 medium / 3 low trust. Lens: Price anchoring (inferred from pricing). 18 battlecards generated in battlecards/. Report: research-report.html (12 MB). Open it and spot-check. Run /scout:review for the final scorecard.

Stop. Do not invoke `/scout:review` automatically.

## Kill/resume

Preflight re-reads `state.progress[]`. Entities already at `"analyzed"` are skipped. Adaptive re-seed rounds are recorded per-round so a killed run won't re-do rounds 1-2 on restart — check `state.reseedRounds` and the per-round seed files before re-running.
