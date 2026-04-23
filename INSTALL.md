# How to install and use Scout at Investing.com

**Scout** is a Claude Code plugin for competitive research. It finds candidate companies, screenshots them, analyzes patterns, and produces a branded research report (plus optional battlecards and mockups).

There are two paths depending on where you are:

- **You're the person setting this up for the company** → [Setup (once per company)](#setup-once-per-company)
- **You're a PM/PMM who wants to use it** → [Install for users](#install-for-users)

---

## Setup (once per company)

The plugin currently lives as a local folder on Barak's machine at:
```
C:\Users\barak.s\Desktop\Claude code projects\investing-claude-plugins\
```

For other employees to use it, you have 3 options. Pick one.

### Option A — Push to an internal GitHub repo (recommended)

1. Create a new repo on Investing.com's GitHub organisation: `investing-claude-plugins` (or similar name).
2. From the current local folder, push everything:
   ```bash
   cd "C:\Users\barak.s\Desktop\Claude code projects\investing-claude-plugins"
   git init
   git add .
   git commit -m "Initial scout plugin"
   git remote add origin https://github.com/<investing-org>/investing-claude-plugins.git
   git push -u origin main
   ```
3. In the repo's README, paste the [Install for users](#install-for-users) section below so employees know how to use it.
4. Share the repo URL in your company chat/wiki.

### Option B — Push to a public GitHub repo

Same steps as Option A but create the repo under a personal/company public GitHub account. Only do this if the plugin is fine to be public — the scout code itself is generic, but if you've committed any Investing.com-specific research or screenshots, clean those out first (the `.agents/` and `screenshots/` folders should not be committed).

### Option C — Shared network drive

If GitHub isn't an option, copy the `investing-claude-plugins` folder to a shared drive (Dropbox / OneDrive / Google Drive / a company NAS). Employees clone the folder to their local machine and follow the "local folder install" instructions below.

### What NOT to commit to the shared repo

The plugin itself lives at `plugins/scout/`. Only that folder + the `.claude-plugin/marketplace.json` file at the root need to be shared. Anything else is deliverables from runs:

```
# Add these to .gitignore BEFORE pushing:
node_modules/
.agents/
screenshots/
analysis/
mockups/
battlecards/
*.html
*.pdf
```

A `.gitignore` file is already in the repo root. Verify it's correct before pushing.

---

## Install for users

These are the instructions you paste in your company chat/wiki for everyone else.

### Prerequisites

- Claude Code installed and working (you can run `/help`)
- Node.js 18+ (for Puppeteer screenshot capture)
- A terminal / command prompt

### Install (one-time)

1. **Clone the repo** (replace the URL with whatever the admin shared):
   ```bash
   cd <your-projects-folder>
   git clone https://github.com/<investing-org>/investing-claude-plugins.git
   ```

2. **Install the plugin's dependencies** (puppeteer, ejs, sharp):
   ```bash
   cd investing-claude-plugins/plugins/scout
   npm install
   ```
   This downloads ~130MB of Puppeteer's Chrome binary. Takes 1-2 minutes the first time.

3. **Register the plugin with Claude Code.** Open Claude Code and run:
   ```
   /plugin marketplace add "C:\path\to\investing-claude-plugins"
   ```
   Replace the path with the absolute path to the folder you just cloned.

4. **Install the scout plugin:**
   ```
   /plugin install scout
   ```
   Claude Code will ask where to install it. Pick "user scope" (applies to all projects) or "project scope" (just this repo).

5. **Verify:** type `/sc` in the Claude Code prompt. You should see autocomplete for:
   - `/scout:plan`
   - `/scout:execute`
   - `/scout:review`

If those don't show up, run `/reload-plugins` and try again.

### Your first research

```
/scout:plan How do subscription trading platforms structure their pricing page?
```

Scout will:
1. Ask you 1-2 quick clarifying questions in chat
2. Open an HTML form in your browser (most fields pre-filled)
3. Fill it in (~2 minutes), hit "Generate response", paste the block back into Claude
4. Run 4-layer discovery + analysis (~15-25 minutes)
5. Produce `research-report.html` + optional `mockups/` + optional `battlecards/` in your current working directory

Open the HTML in your browser. That's the deliverable.

### Updating the plugin

When the admin pushes a new version:
```bash
cd <your-projects-folder>/investing-claude-plugins
git pull
cd plugins/scout
npm install
```
Then in Claude Code: `/reload-plugins`

### Troubleshooting

**`/scout:plan` doesn't appear after install:**
- Run `/reload-plugins`
- If still missing, close Claude Code, reopen, and try `/plugin list` to verify it's installed

**Puppeteer fails to capture certain sites:**
- Some sites have bot detection. Scout retries once, then flags the capture as failed in the report.
- For `ECONNRESET` errors or timeouts, re-run `/scout:execute` — resume picks up where it left off.

**"npm install" fails on Windows:**
- You need Python + build tools for Puppeteer's native dependency. Install [Node.js with build tools](https://nodejs.org/) (check the "Tools for Native Modules" box during install).

**Codex subagent not available:**
- Scout uses Codex as an optional 6th seed source and for second-opinion review. If you don't have Codex CLI installed and subscribed, scout silently skips it. No action needed.

**Path with spaces not working:**
- Wrap paths in double quotes: `/plugin marketplace add "C:\path with spaces\investing-claude-plugins"`

### Running a specific research type

Scout handles 7 decision types — each changes what it analyzes:

| You want to decide… | Use `/scout:plan` with… |
|---|---|
| Positioning / messaging | "How do [competitors] position themselves on their homepage?" |
| Pricing / packaging | "How do [competitors] structure their pricing page?" |
| Feature roadmap | "What features do [competitors] ship in [category]?" |
| Launch messaging | "How did [competitors] announce their [feature] launch?" |
| UX pattern | "How do [competitors] handle [onboarding/search/checkout/etc]?" |
| Go-to-market | "What channels do [competitors] use to acquire users?" |
| Sales battlecard | "Who are our top 10 competitors and how do we beat them?" |

Scout picks the analytical lens (JTBD / Kano / Price anchoring / Descriptive) and whether to auto-generate battlecards based on what you pick. You can override both in the Advanced Research Settings section of the form.

### Getting help

- The plugin source is in `plugins/scout/`
- Architecture overview: `plugins/scout/README.md`
- Changelog: `plugins/scout/LEARNINGS.md`
- If scout breaks or produces weird output, save the `.agents/scout/` folder from your run and share with the admin
