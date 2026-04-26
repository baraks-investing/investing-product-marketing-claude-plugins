#!/usr/bin/env node
/**
 * lib/add-competitors.js
 *
 * Pure-Node orchestrator for /scout:add-competitors. Handles the deterministic
 * pieces — argument parsing, preflight, state merge, state-invariant check —
 * so the slash command body stays focused on the LLM-driven steps (vision
 * verification, per-entity analysis, pattern aggregation).
 *
 * The vision verdict and per-entity analysis are produced by the LLM running
 * the slash command (delegating to the scout-generator subagent for the
 * analysis step). This script is invoked at multiple points:
 *
 *   --action preflight     — read state.json, refuse if phase isn't done/awaiting-review.
 *   --action parse-args    — split $ARGUMENTS into URL + label candidates as JSON.
 *   --action filter-new    — given candidates JSON on stdin, return only those not already in brief.entities.
 *   --action merge-results — given verdicts JSON on stdin, append to brief.entities + .layer3-verdicts + capture-metadata + failed-candidates.
 *   --action check-invariant — verify every id in brief.entities is in exactly one of entity-data.json / failed-candidates.json.
 *
 * Each action prints a single JSON object to stdout. Errors print to stderr
 * with exit code 1. The slash command parses the JSON between steps.
 */

const fs = require('fs');
const path = require('path');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return fallback; }
}

// Defensive parse for stdin payloads piped between actions. Accepts either
// a bare JSON array or an object that wraps the array under a known key
// (e.g. parse-args emits { candidates: [...] }, merge-results consumes
// { verified: [...], rejected: [...] }). Returns the parsed value as-is;
// callers normalize to the array shape they expect.
function parseStdinJson(stdin, fallback) {
  const raw = (stdin == null ? '' : String(stdin)).trim();
  if (!raw) return fallback;
  try { return JSON.parse(raw); }
  catch (_) { return fallback; }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// Slugify a URL or label into an entity id matching the format scout uses
// elsewhere (lowercase, alphanumeric, hyphens). Keeps drift small with the
// existing capture.slugify; we re-implement here to avoid loading puppeteer.
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function looksLikeUrl(token) {
  return /[./]/.test(token) && !/\s/.test(token);
}

function normalizeUrl(token) {
  if (!token) return null;
  let t = String(token).trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
  try { const u = new URL(t); return u.toString().replace(/\/$/, ''); }
  catch (_) { return null; }
}

function parseArgs(argv) {
  // $ARGUMENTS comes through as a single space-separated string. Tokens with
  // dots/slashes are URLs; everything else is a label that the agent will
  // resolve via seed-discovery (out of scope for this script).
  const tokens = String(argv || '').trim().split(/\s+/).filter(Boolean);
  const candidates = tokens.map((tok) => {
    if (looksLikeUrl(tok)) {
      const url = normalizeUrl(tok);
      const id = slugify(tok);
      return { kind: 'url', raw: tok, url, id, label: id };
    }
    return { kind: 'label', raw: tok, url: null, id: slugify(tok), label: tok };
  });
  return { candidates };
}

function actionPreflight(root) {
  const statePath = path.join(root, '.agents/scout/state.json');
  const state = readJson(statePath, null);
  if (!state) {
    return { ok: false, reason: 'No .agents/scout/state.json found. Run /scout:plan and /scout:execute first.' };
  }
  const phase = state.phase || '';
  if (phase !== 'done' && phase !== 'awaiting-review') {
    return {
      ok: false,
      phase,
      reason: 'Scout phase is "' + phase + '". /scout:add-competitors requires phase "done" or "awaiting-review". Run /scout:execute first.',
    };
  }
  return { ok: true, phase };
}

function actionFilterNew(root, candidatesJson) {
  const briefPath = path.join(root, '.agents/scout/brief.json');
  const brief = readJson(briefPath, null);
  if (!brief) return { ok: false, reason: 'brief.json not found at ' + briefPath };
  const existingIds = new Set((brief.entities || []).map((e) => e.id));
  const existingUrls = new Set((brief.entities || []).map((e) => (e.url || '').replace(/\/$/, '')));
  const existingLabels = new Set((brief.entities || []).map((e) => (e.label || '').toLowerCase()));
  // Accept either a bare array of candidates OR the wrapped shape emitted
  // by actionParseArgs ({ candidates: [...] }). The slash command pipes
  // parse-args stdout straight into filter-new stdin, so this defensive
  // normalization is what keeps the documented invocation path working.
  const parsed = parseStdinJson(candidatesJson, []);
  let cands;
  if (Array.isArray(parsed)) {
    cands = parsed;
  } else if (parsed && Array.isArray(parsed.candidates)) {
    cands = parsed.candidates;
  } else {
    cands = [];
  }
  const fresh = [];
  const skipped = [];
  cands.forEach((c) => {
    const idHit = c.id && existingIds.has(c.id);
    const urlHit = c.url && existingUrls.has(c.url.replace(/\/$/, ''));
    const labelHit = c.label && existingLabels.has(String(c.label).toLowerCase());
    if (idHit || urlHit || labelHit) {
      skipped.push({ ...c, reason: 'already in brief.entities' });
    } else {
      fresh.push(c);
    }
  });
  return { ok: true, fresh, skipped, totalExisting: existingIds.size };
}

function actionMergeResults(root, resultsJson) {
  // resultsJson shape:
  //   { verified: [{ id, label, url, category, source, source_trust, verdict, rationale, screenshotPath, captureResult }],
  //     rejected: [{ id, label, url, source, source_trust, reason }] }
  // Defensive parse — accept the documented {verified, rejected} shape; if
  // the caller piped a bare array (unlikely but symmetric with filter-new),
  // treat it as the verified bucket.
  const parsed = parseStdinJson(resultsJson, {});
  let verified;
  let rejected;
  if (Array.isArray(parsed)) {
    verified = parsed;
    rejected = [];
  } else {
    verified = Array.isArray(parsed && parsed.verified) ? parsed.verified : [];
    rejected = Array.isArray(parsed && parsed.rejected) ? parsed.rejected : [];
  }

  const briefPath = path.join(root, '.agents/scout/brief.json');
  const verdictsPath = path.join(root, '.agents/scout/.layer3-verdicts.json');
  const captureMetaPath = path.join(root, 'analysis/capture-metadata.json');
  const failedPath = path.join(root, 'analysis/failed-candidates.json');
  const entityDataPath = path.join(root, 'analysis/entity-data.json');

  const brief = readJson(briefPath, null);
  if (!brief) return { ok: false, reason: 'brief.json not found' };
  if (!Array.isArray(brief.entities)) brief.entities = [];

  const verdicts = readJson(verdictsPath, []);
  const verdictsArr = Array.isArray(verdicts) ? verdicts : [];
  const captureMeta = readJson(captureMetaPath, { results: [] });
  if (!Array.isArray(captureMeta.results)) captureMeta.results = [];
  const failedList = readJson(failedPath, []);
  let failedArr = Array.isArray(failedList) ? failedList : [];
  // entity-data.json is an object keyed by id; only mutate it when we
  // actually need to delete a key (verified→rejected transition). Reading
  // it lazily keeps merge-results a no-op for fresh runs where the file
  // does not exist yet.
  let entityData = null;
  let entityDataDirty = false;
  function ensureEntityData() {
    if (entityData == null) entityData = readJson(entityDataPath, {}) || {};
    return entityData;
  }

  const beforeEntityCount = brief.entities.length;
  let removedFromFailed = 0;
  let removedFromVerified = 0;

  verified.forEach((v) => {
    if (!v.id) return;
    // Rejected → verified transition: a previously-failed id now verifies.
    // Drop the stale failed entry before we add the verified record so the
    // state invariant (id appears in exactly one bucket) holds after merge.
    const failedIdx = failedArr.findIndex((x) => x && x.id === v.id);
    if (failedIdx >= 0) {
      failedArr.splice(failedIdx, 1);
      removedFromFailed += 1;
    }
    if (!brief.entities.find((e) => e.id === v.id)) {
      brief.entities.push({
        id: v.id,
        label: v.label || v.id,
        url: v.url || null,
        category: v.category || 'uncategorized',
        source: v.source || 'manual',
        source_trust: v.source_trust || 'medium',
      });
    }
    if (!verdictsArr.find((x) => x && x.id === v.id)) {
      verdictsArr.push({
        id: v.id,
        verdict: v.verdict || 'yes',
        rationale: v.rationale || null,
        source: v.source || 'manual',
        source_trust: v.source_trust || 'medium',
        screenshotPath: v.screenshotPath || null,
        pattern_y_start: v.pattern_y_start != null ? v.pattern_y_start : null,
        pattern_y_height: v.pattern_y_height != null ? v.pattern_y_height : null,
      });
    }
    if (v.captureResult && !captureMeta.results.find((r) => r && r.id === v.id)) {
      captureMeta.results.push({
        id: v.id,
        url: v.url,
        status: v.captureResult.status || 'success',
        file: v.captureResult.file || v.screenshotPath || null,
        captured_at: v.captureResult.captured_at || new Date().toISOString(),
        content_hash: v.captureResult.content_hash || null,
        error: v.captureResult.error || null,
      });
    }
  });

  rejected.forEach((r) => {
    if (!r.id) return;
    // Verified → rejected transition: a previously-verified id now fails.
    // Strip it from brief.entities and entity-data.json before adding the
    // failed record so the same id never lives in two buckets at once.
    const briefIdx = brief.entities.findIndex((e) => e && e.id === r.id);
    if (briefIdx >= 0) {
      brief.entities.splice(briefIdx, 1);
      removedFromVerified += 1;
    }
    const ed = ensureEntityData();
    if (Object.prototype.hasOwnProperty.call(ed, r.id)) {
      delete ed[r.id];
      entityDataDirty = true;
    }
    if (!failedArr.find((x) => x && x.id === r.id)) {
      failedArr.push({
        id: r.id,
        label: r.label || r.id,
        url: r.url || null,
        source: r.source || 'manual',
        source_trust: r.source_trust || 'low',
        reason: r.reason || 'no pattern visible',
      });
    }
    // Rejected candidates do NOT go into brief.entities — they live in
    // failed-candidates.json only. This preserves the state invariant.
  });

  writeJsonAtomic(briefPath, brief);
  writeJsonAtomic(verdictsPath, verdictsArr);
  writeJsonAtomic(captureMetaPath, captureMeta);
  writeJsonAtomic(failedPath, failedArr);
  if (entityDataDirty) writeJsonAtomic(entityDataPath, entityData);

  return {
    ok: true,
    addedVerified: verified.length,
    addedRejected: rejected.length,
    removedFromFailed,
    removedFromVerified,
    entityCountBefore: beforeEntityCount,
    entityCountAfter: brief.entities.length,
  };
}

function actionCheckInvariant(root) {
  const briefPath = path.join(root, '.agents/scout/brief.json');
  const entityDataPath = path.join(root, 'analysis/entity-data.json');
  const failedPath = path.join(root, 'analysis/failed-candidates.json');

  const brief = readJson(briefPath, null);
  if (!brief) return { ok: false, reason: 'brief.json not found' };
  const entityData = readJson(entityDataPath, {});
  const failed = readJson(failedPath, []);

  const briefIds = (brief.entities || []).map((e) => e.id).filter(Boolean);
  const verifiedIds = new Set(Object.keys(entityData || {}));
  const failedIds = new Set((Array.isArray(failed) ? failed : []).map((f) => f.id).filter(Boolean));

  const missing = []; // in brief but neither verified nor failed
  const dual = [];    // in both verified and failed
  briefIds.forEach((id) => {
    const v = verifiedIds.has(id);
    const f = failedIds.has(id);
    if (!v && !f) missing.push(id);
    if (v && f) dual.push(id);
  });

  // Also check failed entries that appear in brief.entities (rejected
  // candidates should NOT live in brief.entities).
  const briefIdSet = new Set(briefIds);
  const rejectedInBrief = [];
  failedIds.forEach((id) => { if (briefIdSet.has(id)) rejectedInBrief.push(id); });

  const ok = missing.length === 0 && dual.length === 0 && rejectedInBrief.length === 0;
  return {
    ok,
    briefEntityCount: briefIds.length,
    verifiedCount: verifiedIds.size,
    failedCount: failedIds.size,
    missing,
    dual,
    rejectedInBrief,
  };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

async function runCli() {
  const args = process.argv.slice(2);
  function getArg(n) { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; }
  const action = getArg('--action');
  const root = path.resolve(getArg('--root') || process.cwd());

  let result;
  if (action === 'preflight') {
    result = actionPreflight(root);
  } else if (action === 'parse-args') {
    result = parseArgs(getArg('--args') || '');
  } else if (action === 'filter-new') {
    const stdinJson = await readStdin();
    result = actionFilterNew(root, stdinJson);
  } else if (action === 'merge-results') {
    const stdinJson = await readStdin();
    result = actionMergeResults(root, stdinJson);
  } else if (action === 'check-invariant') {
    result = actionCheckInvariant(root);
  } else {
    console.error('Unknown --action. Expected: preflight | parse-args | filter-new | merge-results | check-invariant');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result && result.ok === false) process.exit(1);
}

module.exports = {
  parseArgs,
  parseStdinJson,
  slugify,
  normalizeUrl,
  looksLikeUrl,
  actionPreflight,
  actionFilterNew,
  actionMergeResults,
  actionCheckInvariant,
};

if (require.main === module) {
  runCli().catch((err) => { console.error(err); process.exit(1); });
}
