# investing-claude-plugins

Internal Claude Code plugin marketplace for Investing.com product, PMM, and design teams.

## What's inside

| Plugin | Commands | What it does |
|---|---|---|
| `scout` | `/scout:plan`, `/scout:execute`, `/scout:review` | Three-phase competitive/web-evidence research harness. Turns a research question into a self-contained HTML deliverable with screenshots, per-entity analysis, and quantified patterns. |

## Install

Open any Claude Code session in any project and run:

```
/plugin marketplace add <path-or-git-url-to-this-repo>
/plugin install scout
```

If you cloned this repo locally, the path is the absolute path to the repo root (the one containing `.claude-plugin/marketplace.json`). If you pushed it to GitHub, use the clone URL.

After installation, restart Claude Code (or run `/plugin reload`). You should see `/scout:plan`, `/scout:execute`, and `/scout:review` in the slash menu.

## Smoke test — verify install worked

1. In a throwaway project directory, run `/scout:plan "test run"`.
2. Scout should ask 3-4 clarifying questions. That means the command file was loaded and the plan skill is running.
3. If the slash menu doesn't show the commands after install + reload, check:
   - `/plugin list` — is `scout` listed as enabled?
   - `.claude-plugin/marketplace.json` parses as valid JSON
   - `plugins/scout/.claude-plugin/plugin.json` parses as valid JSON
   - Both command files (`commands/plan.md`, `commands/execute.md`, `commands/review.md`) have frontmatter with `name: scout:plan` etc.
4. To abort the smoke test without running capture, just tell Claude "cancel" before the HTML opens.

## Runtime dependencies

The `scout` plugin shells out to Node for Puppeteer capture and EJS templating. Install dependencies once per target project:

```
cd <your project>
npm i puppeteer ejs
```

On first run Scout checks for these and prompts if missing.

## Adding a new plugin to this marketplace

1. Create `plugins/<name>/` with `.claude-plugin/plugin.json`, `commands/`, `agents/`, optional `skills/`, `lib/`, `templates/`.
2. Add an entry to `.claude-plugin/marketplace.json` under `plugins[]`.
3. Bump the marketplace version.
4. Users run `/plugin marketplace update investing-claude-plugins` and then `/plugin install <name>`.

## Support

Questions: `barak.s@investing.com` or `#product-tools` on Slack.
