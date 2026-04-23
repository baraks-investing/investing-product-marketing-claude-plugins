# Got a zip of Scout? Start here.

Welcome. Scout is a tool that does competitive research for you — it finds competitor companies, takes screenshots of their websites, analyzes patterns, and writes a full research report. You'll run it inside Claude Code.

This guide takes about 10 minutes the first time. After that, starting a new research is one command.

---

## Step 1 — Unzip the folder somewhere you'll remember

1. Find the zip file you were given. It's probably called something like `investing-product-marketing-claude-plugins-v1.0.0.zip`.
2. Right-click → "Extract all" (Windows) or double-click (Mac).
3. Move the unzipped folder somewhere stable on your computer. Suggested location:

   **Windows:**
   ```
   C:\Users\<your-name>\Desktop\Claude code projects\investing-product-marketing-claude-plugins
   ```

   **Mac:**
   ```
   /Users/<your-name>/Desktop/Claude code projects/investing-product-marketing-claude-plugins
   ```

   **Write down the full path to that folder.** You'll need it in Step 3.

---

## Step 2 — Install the tools Scout needs (one-time, ~3 minutes)

Scout takes screenshots of competitor websites, so it needs a tool called "Node.js" to do that.

### Do you already have Node.js?

Open a terminal (Terminal on Mac, or PowerShell/Command Prompt on Windows). Type:

```
node --version
```

- If you see something like `v20.11.0` or any version **18 or higher** — you're good. Skip to Step 2b.
- If you see "command not found" or nothing useful — keep reading this step.

### Install Node.js

1. Go to https://nodejs.org
2. Click the big green **"LTS"** button to download.
3. Open the downloaded file and click Next through the installer. On Windows, **check the "Tools for Native Modules" box** when it asks (important — Scout needs this).
4. Close and reopen your terminal.
5. Type `node --version` again to confirm it works.

### Step 2b — Install Scout's helper libraries

1. In your terminal, go into Scout's folder:

   ```
   cd "<path-you-wrote-down>/plugins/scout"
   ```

   For example: `cd "C:\Users\barak.s\Desktop\Claude code projects\investing-product-marketing-claude-plugins\plugins\scout"`

2. Run this command:

   ```
   npm install
   ```

3. Wait 1-2 minutes. It's downloading a browser-engine that Scout uses for screenshots. When it's done, you'll see something like "added 110 packages."

Done with the one-time setup.

---

## Step 3 — Tell Claude Code about Scout (one-time)

1. Open Claude Code (same app you normally use for coding assistance).
2. In the prompt, type this and hit enter — **replace the path with the full path to YOUR unzipped folder** (the one you wrote down in Step 1):

   ```
   /plugin marketplace add "C:\Users\<your-name>\Desktop\Claude code projects\investing-product-marketing-claude-plugins"
   ```

   Keep the quotes around the path. On Mac, the path starts with `/Users/`.

3. A menu will appear. You should see a plugin called `scout` in the list. Click it (or press Enter when it's highlighted).

4. Claude Code will ask **"Where to install?"**. Pick **"Install for you (user scope)"**. That makes Scout available in all your projects.

5. When it's done, close Claude Code completely and reopen it.

---

## Step 4 — Check it worked

In Claude Code, type:

```
/sc
```

You should see three suggestions pop up:

- `/scout:plan`
- `/scout:execute`
- `/scout:review`

**If you see them — you're done. Skip to Step 5.**

**If you don't see them:**
- Type `/reload-plugins` and try again
- If still nothing, check that you added the marketplace in Step 3 (type `/plugin` to see what's installed)

---

## Step 5 — Run your first research

1. On your computer, make a new folder for this research. Name it something descriptive, like `pricing-research-may` or `onboarding-study`.

2. In your terminal, go into that folder:

   ```
   cd "<path-to-that-new-folder>"
   ```

3. Open Claude Code from inside that folder. Just type:

   ```
   claude
   ```

4. Once Claude Code is open, start your research. Type this followed by your question:

   ```
   /scout:plan How do subscription trading platforms structure their pricing page?
   ```

   Put whatever you actually want to research after `/scout:plan`. Some examples:
   - `/scout:plan How do fintech apps onboard new users in the first 60 seconds?`
   - `/scout:plan How do project management tools position themselves on their homepage?`
   - `/scout:plan Compare top 10 CRM tools and how we beat them`

5. Scout will ask you one short question about what decision you're making with this research. Pick the option that fits — for most research questions it'll auto-suggest the right one.

6. A form will open in your web browser. Most of it is already filled in. Read through, adjust anything that's wrong, add a free text note if you want, and hit the big **"Generate response"** button at the bottom. Click **"Copy to clipboard"**, then paste it back into Claude Code.

7. Scout will work for 15-25 minutes. You'll see messages as it progresses — looking for companies, analyzing their pages, generating the report.

8. When it's done, you'll have a bunch of new files in the folder you created in Step 5:
   - **`research-report.html`** — the main deliverable. Double-click to open in your browser.
   - **`battlecards/`** — one-page sales summaries per competitor (if the decision type triggered them)
   - **`mockups/`** — design concept pages with annotations (if the research asked for them)
   - **`screenshots/`** — full captures of every competitor page

That's your research.

---

## Troubleshooting

**"The commands don't show up" (even after Step 4):**
Try `/reload-plugins`. Then restart Claude Code fully (close the window, reopen).

**"npm install fails with some permission error" (Mac):**
Try adding `sudo` in front: `sudo npm install`. It'll ask for your password.

**"Scout failed to capture some websites":**
That's normal. Some sites block automated screenshots. Scout will flag them in the final report's "No-pattern list" section. Don't worry about it.

**"The research is taking forever":**
It should take 15-25 minutes. If it's been longer than 45 minutes, you can interrupt with Ctrl+C and re-run `/scout:execute` — it'll resume where it left off, not start over.

**"I got a new zip because the plugin was updated":**
Delete your old folder, unzip the new one in the same location, then in the terminal: `cd <path>/plugins/scout && npm install`. In Claude Code, run `/reload-plugins`. Done.

**"I can't find Claude Code" or "I don't know what Claude Code is":**
Claude Code is Anthropic's AI coding assistant. If you don't have it yet, ask IT or your team lead — it's a separate app from claude.ai.

---

## Starting a new research later

Once setup is done, starting a new research is just:

1. Make a new folder for it
2. `cd` into it in your terminal
3. Type `claude`
4. Type `/scout:plan your research question`

That's it.

---

## Getting help

If something breaks or the output looks wrong, save the whole folder you ran the research in (including the hidden `.agents/scout/` folder) and share it with whoever gave you the zip. They can look at the state and figure out what went sideways.
