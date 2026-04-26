#!/usr/bin/env node
/**
 * lib/install-deps.js
 *
 * Runs `npm install` in the plugin folder so scout's runtime dependencies
 * (puppeteer, ejs, sharp) are present and usable. Designed to be invoked by
 * Claude (via Bash tool) from the /scout:plan or /scout:install skill.
 *
 * Mechanism note: the Bash tool streams subprocess stdout to the chat in
 * near-real-time, so the user sees npm progress (especially the ~5-min
 * Chromium download) as it happens. We use spawnSync with stdio:'inherit' as
 * a defensive belt-and-suspenders so live invocation works either way.
 *
 * Apple Silicon edge case: sharp's prebuilt binary path differs by arch and
 * occasionally the first install lands a wrong-arch copy. We preemptively
 * detect darwin+arm64 after the install and rebuild sharp once if its native
 * binary directory looks empty.
 *
 * Errors get translated into ACTIONABLE messages (run as admin, switch
 * networks, install Node, etc.) before being surfaced to the chat.
 *
 * CLI:
 *   node lib/install-deps.js
 *   exit 0 = success (prereq-check returns ok)
 *   exit 1 = failure (message printed to stderr)
 */

'use strict';

var fs = require('fs');
var path = require('path');
var child_process = require('child_process');
var prereq = require('./prereq-check');

var PLUGIN_ROOT = prereq.PLUGIN_ROOT;

function actionable(stderr) {
  // Convert raw npm error output into a recovery hint.
  var s = String(stderr || '').toLowerCase();
  if (s.indexOf('eacces') >= 0 || s.indexOf('permission denied') >= 0) {
    return [
      'Could not write to the plugin folder.',
      'Try one of:',
      '(a) restart Claude Code with elevated permissions (right-click "Run as Administrator" on Windows)',
      '(b) check whether the folder is on a sync-locked drive (OneDrive sometimes locks files)',
      '(c) ask your IT team if your machine has restricted permissions on this path',
    ].join('\n');
  }
  if (s.indexOf('enotfound') >= 0 || s.indexOf('econnrefused') >= 0 || s.indexOf('etimedout') >= 0 || s.indexOf('registry') >= 0) {
    return [
      'npm could not reach the package registry.',
      'This usually means: ',
      '(a) your corporate network is blocking npm — switch to a personal network or hotspot for the install, then come back',
      '(b) ask IT for an internal npm mirror URL and run `npm config set registry <url>` first',
    ].join('\n');
  }
  if (s.indexOf('command not found') >= 0 || s.indexOf("'npm' is not recognized") >= 0) {
    return 'npm is not installed. Install Node.js from https://nodejs.org (npm is bundled), then retry.';
  }
  return null; // No translation; caller surfaces raw stderr.
}

function runNpmInstall() {
  // spawnSync with inherit so output streams to the chat as it runs.
  var npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  var result = child_process.spawnSync(npmCmd, ['install', '--no-fund', '--no-audit'], {
    cwd: PLUGIN_ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    var hint = actionable(String(result.error));
    return { ok: false, message: hint || ('npm install failed to start: ' + result.error.message) };
  }
  if (result.status !== 0) {
    return { ok: false, message: 'npm install exited with code ' + result.status + '. See output above for details.' };
  }
  return { ok: true };
}

function maybeRebuildSharp() {
  // Apple Silicon sharp edge: occasionally the first npm install lands a
  // wrong-arch copy. If we detect arm64 darwin AND sharp does not resolve
  // cleanly, rebuild once.
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return { ok: true, ran: false };
  }
  // Try to load sharp; if it throws on require, rebuild.
  var needsRebuild = false;
  try {
    require.resolve('sharp', { paths: [PLUGIN_ROOT] });
    // Resolve worked — try a soft load too.
    var sharpPath = require.resolve('sharp', { paths: [PLUGIN_ROOT] });
    delete require.cache[sharpPath];
    require(sharpPath);
  } catch (e) {
    needsRebuild = true;
  }
  if (!needsRebuild) return { ok: true, ran: false };

  process.stdout.write('\n[scout] Rebuilding sharp for Apple Silicon (one-time)...\n');
  var npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  var result = child_process.spawnSync(npmCmd, ['rebuild', 'sharp'], {
    cwd: PLUGIN_ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    return { ok: false, ran: true, message: 'npm rebuild sharp failed with code ' + result.status + '. See output above.' };
  }
  return { ok: true, ran: true };
}

function installDeps() {
  process.stdout.write('[scout] Installing dependencies in ' + PLUGIN_ROOT + '\n');
  process.stdout.write('[scout] First-time install pulls Chromium (~170MB), takes ~5 min. You will see npm progress below.\n\n');

  var npmResult = runNpmInstall();
  if (!npmResult.ok) {
    return { ok: false, message: npmResult.message };
  }

  var rebuild = maybeRebuildSharp();
  if (!rebuild.ok) {
    return { ok: false, message: rebuild.message };
  }

  // Final verification — re-run prereq check.
  var check = prereq.checkPrereqs();
  if (!check.ok) {
    var lines = ['Install completed but prereq-check still reports problems:'];
    if (check.missing.length) lines.push('  Missing: ' + check.missing.join(', '));
    if (check.errors && check.errors.node) lines.push('  Node: ' + check.errors.node);
    if (check.errors && check.errors.write) lines.push('  Write: ' + check.errors.write);
    return { ok: false, message: lines.join('\n') };
  }

  return { ok: true, message: 'Scout dependencies are ready. You can now run /scout:plan.' };
}

module.exports = {
  installDeps: installDeps,
  runNpmInstall: runNpmInstall,
  maybeRebuildSharp: maybeRebuildSharp,
};

if (require.main === module) {
  var out = installDeps();
  if (out.ok) {
    process.stdout.write('\n[scout] ' + out.message + '\n');
    process.exit(0);
  } else {
    process.stderr.write('\n[scout] Install failed.\n' + out.message + '\n');
    process.exit(1);
  }
}
