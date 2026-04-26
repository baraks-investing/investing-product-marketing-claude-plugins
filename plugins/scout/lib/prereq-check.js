#!/usr/bin/env node
/**
 * lib/prereq-check.js
 *
 * Verifies scout's prerequisites are in place. Run before /scout:plan or
 * /scout:install to decide whether the user needs an install pass.
 *
 * IMPORTANT: this file is ES5-only on purpose. It must parse on old Node
 * versions (14, 16) so we can REPORT "your Node is too old" instead of
 * crashing with a SyntaxError. No arrow functions, const, template literals,
 * destructuring, or other modern syntax. Use var, function expressions,
 * string concatenation.
 *
 * Public API:
 *   var result = require('./prereq-check').checkPrereqs();
 *   // result = {
 *   //   ok: true | false,
 *   //   nodeVersion: "20.10.0",
 *   //   missing: ["puppeteer", "sharp"],   // names of missing required deps
 *   //   errors: { node?: string, write?: string, ... },
 *   //   cacheWritable: true | false,
 *   //   pluginRoot: "/abs/path/to/plugin"
 *   // }
 *
 * CLI:
 *   node lib/prereq-check.js
 *   prints JSON to stdout, exits 0 if ok else 1.
 */

'use strict';

var fs = require('fs');
var path = require('path');

// Plugin root = parent of this file's directory (lib/ -> plugin root).
var PLUGIN_ROOT = path.resolve(__dirname, '..');

// Minimum Node major version. Keep in sync with package.json "engines".
var MIN_NODE_MAJOR = 18;

// Required runtime dependencies. Keep in sync with package.json "dependencies".
var REQUIRED_DEPS = ['puppeteer', 'ejs', 'sharp'];

function parseNodeMajor(versionString) {
  // versionString examples: "20.10.0", "18.19.0"
  var m = String(versionString || '').match(/^(\d+)\./);
  if (!m) return 0;
  return parseInt(m[1], 10) || 0;
}

function checkNodeVersion() {
  var v = process.versions && process.versions.node ? process.versions.node : '';
  var major = parseNodeMajor(v);
  if (major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      version: v,
      message: 'Node.js ' + MIN_NODE_MAJOR + '+ required, you have ' + (v || 'unknown') + '. Install a newer Node from https://nodejs.org and re-run.'
    };
  }
  return { ok: true, version: v };
}

function checkDepResolves(depName) {
  // Resolve from the plugin folder explicitly so we never accidentally pick up
  // a copy installed in the user's project tree.
  try {
    require.resolve(depName, { paths: [PLUGIN_ROOT] });
    return true;
  } catch (e) {
    return false;
  }
}

function checkCacheWritable() {
  // Confirm we can actually write into the plugin folder before we tell the
  // user "I'll install everything for you here." If this fails, the install
  // will fail too — better to detect it now with a clear recovery message.
  var probe = path.join(PLUGIN_ROOT, '.prereq-write-test');
  try {
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    var msg = 'Cannot write to plugin folder (' + PLUGIN_ROOT + '). ';
    msg += 'Try one of: ';
    msg += '(a) restart Claude Code with elevated permissions (right-click "Run as Administrator" on Windows); ';
    msg += '(b) check whether the folder is on a sync-locked drive (OneDrive/iCloud occasionally locks files); ';
    msg += '(c) ask your IT team if your machine has restricted permissions on this path.';
    return { ok: false, message: msg, error: String(e && e.message || e) };
  }
}

function checkPrereqs() {
  var result = {
    ok: true,
    nodeVersion: '',
    missing: [],
    errors: {},
    cacheWritable: true,
    pluginRoot: PLUGIN_ROOT,
  };

  var nodeCheck = checkNodeVersion();
  result.nodeVersion = nodeCheck.version;
  if (!nodeCheck.ok) {
    result.ok = false;
    result.errors.node = nodeCheck.message;
    // Keep going — a no-Node-version case still wants the dependency report.
  }

  var i;
  for (i = 0; i < REQUIRED_DEPS.length; i++) {
    if (!checkDepResolves(REQUIRED_DEPS[i])) {
      result.missing.push(REQUIRED_DEPS[i]);
      result.ok = false;
    }
  }

  var write = checkCacheWritable();
  result.cacheWritable = write.ok;
  if (!write.ok) {
    result.ok = false;
    result.errors.write = write.message;
  }

  return result;
}

module.exports = {
  checkPrereqs: checkPrereqs,
  PLUGIN_ROOT: PLUGIN_ROOT,
  MIN_NODE_MAJOR: MIN_NODE_MAJOR,
  REQUIRED_DEPS: REQUIRED_DEPS,
};

// CLI mode
if (require.main === module) {
  var out = checkPrereqs();
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out.ok ? 0 : 1);
}
