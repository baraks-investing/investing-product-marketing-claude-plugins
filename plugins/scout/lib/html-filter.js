#!/usr/bin/env node
/**
 * lib/html-filter.js — Layer 2 runner for scout v2.
 *
 * The command skill (plan.md) does the actual WebFetch + Haiku subagent spawning,
 * because only Claude Code has access to those tools. This module's job is to:
 *
 *   1. Accept a list of already-judged seeds (caller ran subagents per seed).
 *   2. Validate each verdict row.
 *   3. Drop `no` verdicts, keep `yes` + `maybe`.
 *   4. Write `.layer2-survivors.json` to disk.
 *
 * It also exports a pure `filterByHtml({ seeds, judgeFn })` helper that lets a
 * test or a future in-process driver run the filter synchronously by providing
 * a mock `judgeFn`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { sortByTrust } = require('./seed-discovery');

const VALID_VERDICTS = new Set(['yes', 'maybe', 'no']);

function validateVerdict(row) {
  if (!row || typeof row !== 'object') return null;
  if (!row.url) return null;
  const verdict = (row.verdict || '').toLowerCase();
  if (!VALID_VERDICTS.has(verdict)) return null;
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
    reason: row.reason || '',
  };
}

/**
 * Pure-function variant. Accepts:
 *   - seeds: [{ id, label, url, source, sourceContext, category, htmlSnippet }]
 *   - judgeFn: async ({url, htmlSnippet, researchQuestion, inclusionCriteria}) => {verdict, reason}
 */
async function filterByHtml(opts) {
  const {
    seeds = [],
    researchQuestion = '',
    inclusionCriteria = '',
    judgeFn,
  } = opts || {};
  if (typeof judgeFn !== 'function') {
    throw new Error('filterByHtml requires a judgeFn');
  }
  // v4: iterate in descending source_trust order so Layer 2 processes the
  // highest-trust candidates first. If the run is killed mid-loop, survivors
  // skew high-trust.
  const ordered = sortByTrust(seeds);
  const rows = [];
  for (const s of ordered) {
    let verdict;
    try {
      verdict = await judgeFn({
        url: s.url,
        htmlSnippet: s.htmlSnippet || '',
        researchQuestion,
        inclusionCriteria,
      });
    } catch (err) {
      verdict = { verdict: 'no', reason: `judge error: ${err.message}` };
    }
    const validated = validateVerdict(Object.assign({}, s, verdict));
    if (validated) rows.push(validated);
  }
  return rows;
}

/**
 * Writes survivors to disk given an already-collected verdict array.
 * Drops `no`. Returns { survivors, stats }.
 */
function writeSurvivors({ verdicts, outputPath }) {
  const validated = (verdicts || [])
    .map(validateVerdict)
    .filter(Boolean);
  const survivors = validated.filter((r) => r.verdict !== 'no');
  const dropped = validated.filter((r) => r.verdict === 'no');

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(survivors, null, 2), 'utf8');
  }

  return {
    survivors,
    stats: {
      total: validated.length,
      yes: survivors.filter((r) => r.verdict === 'yes').length,
      maybe: survivors.filter((r) => r.verdict === 'maybe').length,
      dropped: dropped.length,
    },
  };
}

// CLI: node lib/html-filter.js --verdicts input.json --out survivors.json
function runCli() {
  const args = process.argv.slice(2);
  function getArg(n) { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; }
  const inputPath = getArg('--verdicts');
  const outPath = getArg('--out');
  if (!inputPath) {
    console.error('Usage: node html-filter.js --verdicts verdicts.json [--out survivors.json]');
    process.exit(1);
  }
  const verdicts = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const result = writeSurvivors({ verdicts, outputPath: outPath || null });
  console.log(JSON.stringify(result.stats, null, 2));
}

module.exports = { filterByHtml, writeSurvivors, validateVerdict, sortByTrust };

if (require.main === module) {
  try { runCli(); }
  catch (e) { console.error(e.stack || e.message); process.exit(1); }
}
