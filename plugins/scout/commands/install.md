---
name: scout:install
description: Install or refresh scout's runtime dependencies (puppeteer, ejs, sharp). Safe to run anytime. Idempotent.
argument-hint: "(no args)"
---

# /scout:install — install or refresh scout's dependencies

Standalone command for installing scout's runtime dependencies. Safe to run any time — if everything is already installed, it just confirms and exits. Useful for:

- Pre-installing dependencies before the first /scout:plan run, so the plan flow doesn't pause for an install.
- Recovering from a partial install (e.g., npm got interrupted partway through Chromium download).
- Refreshing dependencies after a scout plugin update.

## How to run

1. Use the Bash tool to run prereq-check:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/plugins/scout/lib/prereq-check.js"
   ```
   Parse the JSON output.

2. **If `ok === true`**: tell the user "Scout's dependencies are already in place ({nodeVersion}, all required packages found). You're ready to run /scout:plan." STOP.

3. **If `errors.node` is set**: tell the user "Scout needs Node.js 18 or newer — your version is too old (or missing). Install from https://nodejs.org, then re-run /scout:install." STOP. Do NOT try to npm install — the install script also needs modern Node.

4. **If `cacheWritable === false`**: surface `errors.write` verbatim (already contains an actionable hint). STOP.

5. **Otherwise** (only missing dependencies): use the Bash tool to run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/plugins/scout/lib/install-deps.js"
   ```
   The Bash tool streams npm output as it runs. Expect ~5 minutes for the first install (most of that is Chromium download). Apple Silicon sharp rebuild is handled automatically.

6. **After install**:
   - Exit code 0: tell the user "Done. Scout is ready — run /scout:plan whenever you have a research question."
   - Non-zero: surface the `[scout] Install failed.` message from stderr (already actionable). The user should retry or follow the recovery hint.

## Style note

This command should not ask the user any questions — it's "do the install, report the result." If the user wanted a consent prompt, they'd be running /scout:plan. /scout:install is the explicit "yes please install now" path.
