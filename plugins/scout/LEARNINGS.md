# Scout plugin — learnings from dogfood runs

## Dogfood run 1 — 2026-04-21 — "profiling in acquisition funnels" (v1)

- Entities: 34 (0 failed capture)
- Report size: 10.18 MB
- Most valuable pattern: Fintech abstains entirely (0/4 entities have visible profiling) — directly relevant to InvestingPro as a category norm they'd be breaking.
- Friction this run: Thumbnail hydration bug left 40 candidate cards stuck on "capturing…" — user had to approve blindly. Fixed in capture.js (thumbnail mode now writes flat). Also: filter step between Q2/Q3 answers and candidate list lived in my head instead of the decision map — added to plugin LEARNINGS for fix.
- Would do differently: Run a claim-integrity audit agent on patterns.json BEFORE building the report. The second-opinion pass caught 4 real factual errors (miscounted denominators, misclassified entities, contradicted friction claim) that would have embarrassed the user if a stakeholder spot-checked. A pre-report audit would surface these when they're cheaper to fix.

## Dogfood run 2 — 2026-04-23 — "profiling in acquisition funnels" (v2)

- Entities: 9 verified (of 60 seeded → 31 L2 survivors → 9 L3 verified). 22 routed to "No pattern found" appendix.
- Report size: 2.75 MB (dropped from 10.18 MB in v1 because there's no more garbage data)
- Pipeline win: zero em-dash entity rows in main gallery. Every entity has screenshot + vision rationale + URL.
- Friction — **exec summary KPI cards were process stats, not content insights.** User called them "not really insightful". Showing "60 seeded / 31 L2 survivors / 9 verified / 22 dropped" is pipeline plumbing, not pattern insight.
- Friction — **no "best practices" card.** The April pricing report has a compact prescriptive block near the top; scout v2 buried the same information in the full recommendations section near the bottom.
- Friction — **tautological patterns and observations.** "Profiling pickers are rarer than they appear" and "Fintech abstains from profiling pickers" are restatements of how filtering works. If the pipeline filters non-matching candidates, saying "the pattern is rare" or "category X abstains" is circular — you excluded them yourself.

**Fixes landed in plugin:**
- Template now has an `execStats` stat grid (content-insight cards driven by patterns.json data, not hardcoded process numbers) and a gradient `best-practices-card` near the top of exec summary.
- `build-report.js` passes `execStats` and `bestPractices` arrays from patterns.json to the template.
- `commands/execute.md` patterns-aggregator prompt explicitly forbids tautological observations and requires execStats + bestPractices, with concrete GOOD and BAD examples.
- Report regenerated with the corrected content — 0 tautologies, 5 content-insight KPIs, 6 best-practice rules.

**Would do differently next time:** pattern aggregator should write execStats + bestPractices in the FIRST pass, not as a repair. The updated command prompt now requires it upfront.

## 2026-04-23 — Scout v3 repair pass 1

- **R1: removed Mockup kind field.** Pre-specifying mockup style biases mockup-designer, which already decides concept shapes from patterns.json findings. Lesson: when a later agent derives output from earlier findings, don't collect user intent that duplicates or constrains that derivation — it poisons the well. Kept parser tolerance for legacy v2 paste-backs that still carry the block.
- **R2: added Codex as a second-opinion option.** Codex-via-codex-reviewer gives a genuinely independent second-provider read (not just a second Claude). Plumbed with a silent sonnet fallback so users who picked Codex without the CLI available still get a critique pass instead of a hard failure.
- **R3: reference screenshot for visual decision types.** Text rubrics like ">=4 options above the fold" miss user intent when the user is actually looking for a specific visual *shape*. For ux_pattern / positioning / launch_messaging, /scout:plan now asks for a reference image (skippable), stores it at `.agents/scout/reference/seed.<ext>`, and threads the path into the vision-judge subagent as the primary matching anchor. Lesson: vision-judge is only as good as the anchor it compares against; the text rubric alone is lossy.
