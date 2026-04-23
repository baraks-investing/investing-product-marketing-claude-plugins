# scout — deterministic web-evidence research harness

Turn a research question into a self-contained HTML deliverable with screenshots, per-entity analysis, and quantified patterns. Three commands, one coherent pipeline.

## When to use it

- "How do competitors X do Y?" (landing pages, pricing, onboarding, empty states, etc.)
- Anything where you'd end up opening 30 browser tabs and taking notes
- PMM / product / design teams who want a defensible evidence pack, not vibes

## When NOT to use it

- You already know the answer and just need slides — use a PPT tool
- You need live data (prices that change hourly) — this is a point-in-time snapshot
- The research is about internal systems — scout captures public web pages

## The three commands

### `/scout:plan "your research question"`

Duration: 5-15 minutes (mostly your thinking time + thumbnail capture in background)

What happens:
1. Scout asks 3-4 clarifying questions in chat.
2. It proposes 20-40 candidate entities matching your question.
3. An interactive HTML decision map opens in your browser. Thumbnails hydrate progressively as Puppeteer captures them.
4. You fill in 8 scoping questions (research question, inclusion criteria, exclusion criteria, target count, dimensions, visual evidence spec, mockups option, second-opinion model), approve or reject candidates, add custom ones, click Generate response.
5. Paste the block back into Claude. The parser writes `brief.md`, `rubric.json`, and `tasks/*.json` under `.agents/scout/`.
6. A second-opinion subagent on a different model critiques the brief. Must-address items get folded in; nice-to-haves come back to you.
7. You say "execute" when happy.

### `/scout:execute`

Duration: 15-60 minutes depending on entity count and network.

What happens:
1. Full-fidelity capture of every approved entity (1440x900 by default) with cookie-banner dismissal and retries.
2. A generator subagent analyzes each entity against the dimensions you approved, writing `analysis/entity-data.json`.
3. A second pass aggregates cross-entity patterns with denominators, writing `analysis/patterns.json`.
4. If you opted into mockups, a third pass generates 3-5 or 5-7 inline mockup HTMLs.
5. The builder assembles `research-report.html` — self-contained, under 30 MB, with exec summary, filterable gallery, per-entity cards, patterns, recommendations, and optional inline mockups.

Resume-safe: killing mid-run and rerunning picks up from `state.progress[]`. Already-captured entities are not re-downloaded.

### `/scout:review`

Duration: 2-5 minutes.

What happens:
1. Mechanical checks (entity coverage, report size, dimension population, denominators).
2. Rubric evaluation per criterion (functionality, code_quality, product_depth, visual_design) with scores and evidence.
3. Second-opinion subagent on a different model critiques the final deliverable.
4. Scorecard posted in chat. Learnings appended to `.agents/scout/LEARNINGS.md`. State flipped to `done`.

## What scout produces (in your project)

```
.agents/scout/
├── state.json                       (phase, progress, project id)
├── brief.md                         (human brief)
├── brief.json                       (machine brief)
├── rubric.json
├── tasks/
├── reviews/
│   ├── second-opinion-plan.md
│   └── second-opinion-final.md
├── LEARNINGS.md
└── decision-map.html                (thrown away after paste-back)
screenshots/<category>/<id>.jpg
analysis/
├── entity-data.json
├── patterns.json
└── capture-metadata.json
research-report.html                 ← the deliverable you share
```

## Troubleshooting

**"Scout needs puppeteer and ejs"**
Run `npm i puppeteer ejs` in the project root.

**Chromium doesn't download on install**
Puppeteer downloads Chromium the first time. On corporate networks this sometimes fails. Set `PUPPETEER_DOWNLOAD_BASE_URL` or install `puppeteer-core` + a local Chrome and configure `executablePath` in `lib/capture.js`.

**Thumbnails never appear in the decision map**
Check `.agents/scout/thumbs/` — if the JPGs are landing but the HTML isn't showing them, your browser is blocking `file://` image loads. Open the HTML via `npx http-server .agents/scout` and navigate to `decision-map.html`.

**Paste-back parser rejects with "project_id mismatch"**
You pasted a block from an earlier plan run. Rerun `/scout:plan` and use the new HTML.

**Report file is over 30 MB**
Rerun the builder with lower JPEG quality (edit `.agents/scout/brief.json` and add `"jpegQuality": 60` under `visualEvidence`). Or run capture with fewer entities.

**One or two entities fail capture**
Expected. They appear in the gallery as placeholder cards and are flagged in the report. If a specific site keeps failing, it probably has bot detection — capture it manually, save as `screenshots/<category>/<id>.jpg`, and rerun `/scout:execute` (resume will see the file and skip re-capture).

**Cookie banner is blocking the screenshot**
`lib/capture.js` has a default list of common selectors. Add site-specific selectors via `brief.json`'s `visualEvidence.cookieSelectors` array.

## Design notes

- Plugin code is generic. No hardcoded company lists, no domain assumptions.
- The April 2026 Ultra-plan pricing research (42 companies) is reference material only, not a default.
- Second-opinion uses Claude Code's Agent tool with a `model` override. Fallback to manual-paste flow is documented in `agents/second-opinion.md` but not wired up — flip to it if the override stops working.
- Decision-map HTML style matches the `docs/bundle-*-decision-map.html` pattern that Investing.com teams already recognize.

## Files

```
plugins/scout/
├── .claude-plugin/plugin.json
├── package.json
├── commands/{plan,execute,review}.md
├── agents/{generator,evaluator,second-opinion}.md
├── skills/scout-protocol/SKILL.md
├── lib/
│   ├── capture.js              (Puppeteer capture module)
│   ├── build-decision-map.js   (plan-phase HTML generator)
│   ├── build-report.js         (final report builder)
│   └── parse-paste-back.js     (paste-back parser + brief writer)
└── templates/
    ├── decision-map.html.ejs
    └── research-report.html.ejs
```
