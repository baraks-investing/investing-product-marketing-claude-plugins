---
name: scout-protocol
description: Shared protocol, state conventions, and phase logic for the scout research harness. Commands reference this for behavior that spans plan/execute/review.
---

# Scout protocol

All three scout commands share this protocol. When behavior is ambiguous in a command file, defer here.

## State root

Every scout run writes to `.agents/scout/` in the target project's root. Files:

```
.agents/scout/
├── state.json               ← phase + projectId + progress[]
├── brief.md                 ← human-readable brief
├── brief.json               ← machine-readable brief (execute reads this)
├── rubric.json              ← criteria + thresholds for this run
├── tasks/                   ← E01-E04 per-phase tasks
│   ├── E01.json
│   ├── E02.json
│   ├── E03.json
│   └── E04.json
├── contracts/               ← (optional) per-pass contracts if the user asks
├── reviews/
│   ├── second-opinion-plan.md
│   └── second-opinion-final.md
├── evaluations/             ← evaluator outputs per pass
├── decision-map.html        ← plan phase deliverable (throwaway after paste-back)
├── thumbs/                  ← <id>.jpg and <id>.failed.png
│   └── metadata.json
├── LEARNINGS.md             ← appended each /scout:review
└── .paste-back.txt          ← most recent raw paste (for re-parsing)
```

## state.json shape

```json
{
  "projectId": "sc_abc123",
  "phase": "plan" | "awaiting-execute" | "execute" | "awaiting-review" | "done",
  "researchQuestion": "...",
  "sessionModel": "opus",
  "startedAt": "...",
  "updatedAt": "...",
  "progress": [
    { "entity_id": "notion", "phase": "captured", "status": "success", "ts": "..." },
    { "entity_id": "notion", "phase": "analyzed", "ts": "..." }
  ]
}
```

## Resume rules

- Before capture, filter entities whose latest `progress[]` entry for their id has `phase: "captured"` — skip those.
- Before analysis, skip entities whose latest phase is `"analyzed"`.
- After each entity (or batch) completes a step, persist `state.json` immediately. A kill loses at most the current batch.

## Schema version

The decision-map paste-back uses `=== SCOUT DECISION MAP v1 ===` ... `=== END SCOUT DECISION MAP v1 ===`. If the parser is ever upgraded, bump to `v2` and keep a compatibility shim. Never silently accept a v1 paste in a v2 runtime.

## project_id hygiene

The project_id is generated once at plan-phase kickoff and burned into:
- `state.json`
- The decision-map HTML (embedded in the `<script>` block)
- The paste-back block

The parser rejects a paste-back whose project_id doesn't match the current state.json. This prevents a user accidentally pasting a stale block from an earlier plan run.

## Second-opinion invocation

Primary: Agent tool with explicit `model` override. Confirmed working in Claude Code as of 2026-04.
Fallback (documented in agents/second-opinion.md, not wired): write critique-prompt.md and surface the HTML's second paste-box. Flip to fallback only if the model override stops working.

## Output style for commands

All user-facing messages from scout commands follow the human-writing rules:
- No markdown decorators in chat output (no `---`, no `**`, no bullet lists unless listing options)
- Direct, short, Slack-tone
- No padding like "let me know if you have questions"
- Summarize, don't dump — link to files
