#!/usr/bin/env node
/**
 * lib/build-decision-map.js
 *
 * Renders the interactive decision-map HTML for /scout:plan.
 *
 * v3 change: input.json now carries a `suggestScopingResult` produced by the
 * suggest-scoping subagent, which pre-fills every structured field. Schema
 * version is 'v2'; the paste-back header the HTML emits is
 *   === SCOUT DECISION MAP v2 ===
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ejs = require('ejs');
const { inferFrameworkLens, inferBattlecardEnabled } = require('./parse-paste-back');

// Friendly labels for inferred framework lens / battlecard — used in the
// decision-map Advanced research settings helper text.
const LENS_LABELS = {
  jtbd: 'Jobs-to-be-Done',
  kano: 'Feature-value (Kano)',
  price_anchor: 'Price anchoring',
  descriptive: 'Descriptive only',
};

function newProjectId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `sc_${ts}_${rand}`;
}

function fileToDataUri(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (_) { return null; }
}

// Safe default so the template never blows up on missing suggest-scoping data.
const FALLBACK_SUGGEST = {
  inclusion_defaults: [],
  exclusion_defaults: [],
  dimension_defaults: [],
  visual_evidence_default: 'desktop-atf',
  visual_evidence_rationale: '',
  mockup_count_default: 'none',
  mockup_count_rationale: '',
  suggested_entity_count: 20,
  suggested_min_verified: 15,
};

function renderDecisionMap(input) {
  if (!input || typeof input !== 'object') throw new Error('renderDecisionMap: input required');

  const projectId = input.projectId || newProjectId();
  const templatePath = path.resolve(__dirname, '..', 'templates', 'decision-map.html.ejs');
  const tpl = fs.readFileSync(templatePath, 'utf8');

  const candidates = (Array.isArray(input.proposedCandidates) ? input.proposedCandidates : [])
    .map((c) => {
      const screenshotDataUri = c.screenshotDataUri
        || (c.screenshotPath ? fileToDataUri(c.screenshotPath) : null);
      return Object.assign({}, c, { screenshotDataUri });
    });

  // Normalize suggest-scoping result — accept various key shapes defensively.
  const raw = input.suggestScopingResult || input.suggest_scoping_result || input.suggest || {};
  const suggest = Object.assign({}, FALLBACK_SUGGEST, raw);

  const referenceScreenshotPath = input.referenceScreenshotPath || null;
  const referenceScreenshotFilename = referenceScreenshotPath
    ? path.basename(referenceScreenshotPath)
    : null;

  const decisionType = input.decisionType || 'other';
  const inferredLensKey = inferFrameworkLens(decisionType);
  const inferredLensLabel = LENS_LABELS[inferredLensKey] || 'Descriptive only';
  const inferredBattlecardEnabled = inferBattlecardEnabled(decisionType);

  const data = {
    projectId,
    researchQuestion: input.researchQuestion || '',
    decisionType,
    sessionModel: input.sessionModel || 'opus',
    suggestedSecondOpinionModel: input.suggestedSecondOpinionModel
      || ((input.sessionModel === 'sonnet') ? 'opus' : 'sonnet'),
    suggest,
    proposedCandidates: candidates,
    referenceScreenshotPath,
    referenceScreenshotFilename,
    generatedAt: input.generatedAt || new Date().toISOString(),
    schemaVersion: 'v2',
    // v4: Advanced research settings context for the template.
    inferredLensKey,
    inferredLensLabel,
    inferredBattlecardEnabled,
  };

  const html = ejs.render(tpl, data, { filename: templatePath });

  const outputPath = input.outputPath || path.resolve(process.cwd(), '.agents/scout/decision-map.html');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');

  return { path: outputPath, projectId, candidateCount: candidates.length };
}

async function runCli() {
  const args = process.argv.slice(2);
  function getArg(name) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  }
  const inputPath = getArg('--input');
  if (!inputPath) {
    console.log('Usage: node build-decision-map.js --input path/to/input.json [--out path/to/out.html]');
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const out = getArg('--out');
  if (out) input.outputPath = path.resolve(out);
  const result = renderDecisionMap(input);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { renderDecisionMap, newProjectId };

if (require.main === module) {
  runCli().catch((e) => { console.error(e); process.exit(1); });
}
