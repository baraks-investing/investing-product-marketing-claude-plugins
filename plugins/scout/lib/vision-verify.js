#!/usr/bin/env node
/**
 * lib/vision-verify.js — Layer 3 runner for scout v2.
 *
 * Like html-filter.js this is an orchestration module: the command skill runs
 * Puppeteer captures + Sonnet vision subagents (which need tool access we don't
 * have from plain Node). This module validates their output, writes
 * `.layer3-verdicts.json` + `analysis/failed-candidates.json`, and exposes a
 * helper to shape the surviving entries for the decision-map template.
 *
 * Expected verdict row shape from caller:
 *   {
 *     id, label, url, source, sourceContext, category,
 *     verdict: "yes"|"partial"|"no",
 *     options_count: int|null,
 *     picker_placement: "hero"|"below-hero"|"modal"|"signup-step"|"none-visible",
 *     rationale: "one sentence pointing at pixels",
 *     screenshotPath: "screenshots/<category>/<id>.jpg"
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { sortByTrust } = require('./seed-discovery');

const VALID_VERDICTS = new Set(['yes', 'partial', 'no']);
const VALID_PLACEMENTS = new Set([
  'hero', 'below-hero', 'modal', 'signup-step', 'none-visible',
]);

function validateVerdict(row) {
  if (!row || typeof row !== 'object' || !row.url) return null;
  const verdict = (row.verdict || '').toLowerCase();
  if (!VALID_VERDICTS.has(verdict)) return null;

  const placement = VALID_PLACEMENTS.has(row.picker_placement)
    ? row.picker_placement
    : 'none-visible';

  return {
    id: row.id || null,
    label: row.label || null,
    url: row.url,
    source: row.source || 'unknown',
    source_stream: row.source_stream || row.source || null,
    source_trust: row.source_trust || 'low',
    sourceContext: row.sourceContext || '',
    category: row.category || null,
    verdict,
    options_count: (typeof row.options_count === 'number' && isFinite(row.options_count))
      ? row.options_count
      : null,
    picker_placement: placement,
    rationale: row.rationale || '',
    screenshotPath: row.screenshotPath || null,
    pattern_y_start: (typeof row.pattern_y_start === 'number') ? row.pattern_y_start : null,
    pattern_y_height: (typeof row.pattern_y_height === 'number') ? row.pattern_y_height : null,
  };
}

/**
 * Writes verdicts + failed-candidates to disk. Returns { verdicts, failed, stats }.
 */
function writeVerdicts({ verdicts, verdictsPath, failedPath }) {
  const validated = (verdicts || []).map(validateVerdict).filter(Boolean);

  const survivors = validated.filter((r) => r.verdict !== 'no');
  const failed = validated
    .filter((r) => r.verdict === 'no')
    .map((r) => ({
      id: r.id,
      label: r.label,
      url: r.url,
      source: r.source,
      reason: r.rationale || 'no pattern visible',
      picker_placement: r.picker_placement,
      category: r.category,
    }));

  // Drop any survivor missing the hard-requirement evidence binding (P4).
  // Must carry: screenshotPath, rationale, url, verdict.
  const bound = [];
  const lostToBinding = [];
  for (const r of survivors) {
    if (r.screenshotPath && r.rationale && r.url) bound.push(r);
    else lostToBinding.push({
      id: r.id,
      label: r.label,
      url: r.url,
      source: r.source,
      reason: 'missing evidence binding (screenshot/rationale/url)',
      picker_placement: r.picker_placement,
      category: r.category,
    });
  }
  failed.push(...lostToBinding);

  if (verdictsPath) {
    fs.mkdirSync(path.dirname(verdictsPath), { recursive: true });
    fs.writeFileSync(verdictsPath, JSON.stringify(bound, null, 2), 'utf8');
  }
  if (failedPath) {
    fs.mkdirSync(path.dirname(failedPath), { recursive: true });
    fs.writeFileSync(failedPath, JSON.stringify(failed, null, 2), 'utf8');
  }

  return {
    verdicts: bound,
    failed,
    stats: {
      total: validated.length,
      yes: bound.filter((r) => r.verdict === 'yes').length,
      partial: bound.filter((r) => r.verdict === 'partial').length,
      failed: failed.length,
    },
  };
}

/**
 * Shapes verdict rows for the decision-map template's `proposedCandidates`.
 * Filters to yes + partial. Keeps the fields the template expects plus the
 * new verdict/source/rationale metadata.
 */
function prepareVerdictsForDecisionMap(verdicts) {
  return (verdicts || [])
    .filter((v) => v && (v.verdict === 'yes' || v.verdict === 'partial'))
    .map((v) => ({
      id: v.id,
      label: v.label,
      url: v.url,
      category: v.category || 'uncategorized',
      rationale: v.rationale || '',
      matchesCriteria: v.verdict === 'yes' ? 'yes' : 'maybe',
      verdict: v.verdict,
      source: v.source,
      screenshotPath: v.screenshotPath,
      options_count: v.options_count,
      picker_placement: v.picker_placement,
    }));
}

// CLI: node lib/vision-verify.js --verdicts input.json --out .layer3-verdicts.json --failed analysis/failed-candidates.json
function runCli() {
  const args = process.argv.slice(2);
  function getArg(n) { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; }
  const inputPath = getArg('--verdicts');
  const verdictsPath = getArg('--out');
  const failedPath = getArg('--failed');
  if (!inputPath) {
    console.error('Usage: node vision-verify.js --verdicts input.json [--out verdicts.json] [--failed failed.json]');
    process.exit(1);
  }
  const verdicts = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const result = writeVerdicts({ verdicts, verdictsPath, failedPath });
  console.log(JSON.stringify(result.stats, null, 2));
}

/**
 * Build the input payload passed to a scout-vision-judge subagent invocation.
 * Keeps the shape consistent across callers. If `referenceScreenshotPath` is
 * truthy, it's threaded into the payload so the judge uses it as its primary
 * matching anchor (see agents/vision-judge.md).
 */
function buildJudgeInput({
  screenshotPath,
  url,
  researchQuestion,
  inclusionCriteria,
  optionsThreshold,
  referenceScreenshotPath,
}) {
  const payload = {
    screenshot_path: screenshotPath,
    url: url || '',
    research_question: researchQuestion || '',
    inclusion_criteria: inclusionCriteria || '',
  };
  if (typeof optionsThreshold === 'number') payload.options_threshold = optionsThreshold;
  if (referenceScreenshotPath) payload.reference_screenshot_path = referenceScreenshotPath;
  return payload;
}

module.exports = { writeVerdicts, validateVerdict, prepareVerdictsForDecisionMap, buildJudgeInput, sortByTrust };

if (require.main === module) {
  try { runCli(); }
  catch (e) { console.error(e.stack || e.message); process.exit(1); }
}
