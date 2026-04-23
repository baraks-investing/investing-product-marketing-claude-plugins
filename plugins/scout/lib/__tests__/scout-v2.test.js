#!/usr/bin/env node
/**
 * lib/__tests__/scout-v2.test.js
 *
 * Round-trip tests for scout v2 orchestration modules. No test framework —
 * plain Node assertions. Exits non-zero on failure.
 *
 * Covers:
 *   - seed-discovery: merge + dedupe by domain + priority ordering
 *   - html-filter: writeSurvivors validation + no-drop
 *   - vision-verify: writeVerdicts validation + evidence binding + prepareVerdictsForDecisionMap
 *
 * Run: node lib/__tests__/scout-v2.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { discoverSeeds, safeHost } = require('../seed-discovery');
const { writeSurvivors, filterByHtml, validateVerdict: validateHtml } = require('../html-filter');
const {
  writeVerdicts,
  validateVerdict: validateVision,
  prepareVerdictsForDecisionMap,
} = require('../vision-verify');

let failures = 0;
function test(name, fn) {
  try {
    const p = fn();
    if (p && typeof p.then === 'function') {
      return p.then(
        () => console.log(`ok  - ${name}`),
        (err) => { failures++; console.error(`FAIL - ${name}`); console.error(err.stack || err); }
      );
    }
    console.log(`ok  - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(err.stack || err);
  }
}

function tmp(name) {
  return path.join(os.tmpdir(), `scout-v2-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

// ---------- seed-discovery ----------

test('seed-discovery: safeHost strips www and lowercases', () => {
  assert.strictEqual(safeHost('https://www.Monday.com/signup'), 'monday.com');
  assert.strictEqual(safeHost('not a url'), null);
});

test('seed-discovery: dedupes by host with priority websearch > listicle > llm', () => {
  const { seeds, stats } = discoverSeeds({
    webSearchResults: [{ url: 'https://monday.com/a' }],
    listicleResults: [{ url: 'https://listicle.com/post', extractedCompanies: [
      { name: 'Monday', url: 'https://www.monday.com/b' },
      { name: 'ClickUp', url: 'https://clickup.com' },
    ] }],
    llmProposals: [
      { id: 'monday', label: 'Monday', url: 'https://monday.com/', category: 'pm' },
      { id: 'asana', label: 'Asana', url: 'https://asana.com', category: 'pm' },
    ],
    maxSeeds: 10,
  });
  const hosts = seeds.map((s) => safeHost(s.url));
  assert.deepStrictEqual(new Set(hosts).size, hosts.length, 'no duplicate hosts');
  const monday = seeds.find((s) => safeHost(s.url) === 'monday.com');
  assert.strictEqual(monday.source, 'websearch', 'websearch wins dedup');
  assert.ok(seeds.find((s) => safeHost(s.url) === 'clickup.com'));
  assert.ok(seeds.find((s) => safeHost(s.url) === 'asana.com'));
  assert.strictEqual(stats.bySource.websearch, 1);
});

test('seed-discovery: respects maxSeeds cap', () => {
  const { seeds } = discoverSeeds({
    llmProposals: Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`, label: `E${i}`, url: `https://site${i}.com`, category: 'x',
    })),
    maxSeeds: 5,
  });
  assert.strictEqual(seeds.length, 5);
});

test('seed-discovery: writes output file when outputPath given', () => {
  const outPath = tmp('seeds.json');
  discoverSeeds({
    webSearchResults: [{ url: 'https://example.com' }],
    maxSeeds: 5,
    outputPath: outPath,
  });
  const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.strictEqual(written.length, 1);
  fs.unlinkSync(outPath);
});

test('seed-discovery: drops seeds with unparseable URLs', () => {
  const { seeds } = discoverSeeds({
    llmProposals: [
      { id: 'ok', label: 'Ok', url: 'https://ok.com' },
      { id: 'bad', label: 'Bad', url: 'not-a-url' },
    ],
  });
  assert.strictEqual(seeds.length, 1);
  assert.strictEqual(seeds[0].id, 'ok');
});

// ---------- html-filter ----------

test('html-filter: validateVerdict rejects bad verdict values', () => {
  assert.strictEqual(validateHtml({ url: 'https://x.com', verdict: 'bogus' }), null);
  assert.strictEqual(validateHtml({ url: 'https://x.com', verdict: 'yes' }).verdict, 'yes');
  assert.strictEqual(validateHtml({ verdict: 'yes' }), null); // missing url
});

test('html-filter: writeSurvivors drops no, keeps yes+maybe', () => {
  const outPath = tmp('survivors.json');
  const { survivors, stats } = writeSurvivors({
    verdicts: [
      { url: 'https://a.com', verdict: 'yes', reason: 'clear' },
      { url: 'https://b.com', verdict: 'maybe', reason: 'unsure' },
      { url: 'https://c.com', verdict: 'no', reason: 'mismatch' },
      { url: 'https://d.com', verdict: 'INVALID' },
    ],
    outputPath: outPath,
  });
  assert.strictEqual(survivors.length, 2);
  assert.strictEqual(stats.dropped, 1);
  assert.strictEqual(stats.yes, 1);
  assert.strictEqual(stats.maybe, 1);
  const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.strictEqual(written.length, 2);
  fs.unlinkSync(outPath);
});

test('html-filter: filterByHtml runs injected judgeFn', async () => {
  const rows = await filterByHtml({
    seeds: [
      { id: 'a', url: 'https://a.com', htmlSnippet: 'has picker' },
      { id: 'b', url: 'https://b.com', htmlSnippet: 'unrelated' },
    ],
    researchQuestion: 'does X happen',
    inclusionCriteria: 'shows a picker',
    judgeFn: async ({ htmlSnippet }) => (
      htmlSnippet.includes('picker')
        ? { verdict: 'yes', reason: 'mention' }
        : { verdict: 'no', reason: 'no mention' }
    ),
  });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].verdict, 'yes');
  assert.strictEqual(rows[1].verdict, 'no');
});

// ---------- vision-verify ----------

test('vision-verify: validateVerdict normalizes placement + bounds', () => {
  const row = validateVision({
    url: 'https://x.com',
    verdict: 'yes',
    options_count: 6,
    picker_placement: 'bogus-value',
    rationale: 'grid of six',
    screenshotPath: '/tmp/x.jpg',
  });
  assert.strictEqual(row.picker_placement, 'none-visible'); // invalid -> default
  assert.strictEqual(row.options_count, 6);

  const row2 = validateVision({
    url: 'https://x.com',
    verdict: 'yes',
    picker_placement: 'signup-step',
    rationale: 'ok',
    screenshotPath: '/tmp/x.jpg',
  });
  assert.strictEqual(row2.picker_placement, 'signup-step');
  assert.strictEqual(row2.options_count, null);
});

test('vision-verify: writeVerdicts filters no + enforces evidence binding', () => {
  const verdictsPath = tmp('verdicts.json');
  const failedPath = tmp('failed.json');
  const { verdicts, failed, stats } = writeVerdicts({
    verdicts: [
      { id: 'a', url: 'https://a.com', verdict: 'yes', picker_placement: 'hero',
        rationale: 'clear grid', screenshotPath: '/tmp/a.jpg' },
      { id: 'b', url: 'https://b.com', verdict: 'partial', picker_placement: 'modal',
        options_count: 3, rationale: 'three only', screenshotPath: '/tmp/b.jpg' },
      { id: 'c', url: 'https://c.com', verdict: 'no', picker_placement: 'none-visible',
        rationale: 'nothing visible' },
      // Missing screenshotPath — should go to failed, not survivors
      { id: 'd', url: 'https://d.com', verdict: 'yes', picker_placement: 'hero',
        rationale: 'found' },
    ],
    verdictsPath,
    failedPath,
  });
  assert.strictEqual(verdicts.length, 2, 'a + b pass binding');
  assert.strictEqual(stats.yes, 1);
  assert.strictEqual(stats.partial, 1);
  assert.strictEqual(failed.length, 2, 'c (no) + d (unbound) go to failed');
  const writtenVerdicts = JSON.parse(fs.readFileSync(verdictsPath, 'utf8'));
  assert.strictEqual(writtenVerdicts.length, 2);
  const writtenFailed = JSON.parse(fs.readFileSync(failedPath, 'utf8'));
  assert.strictEqual(writtenFailed.length, 2);
  fs.unlinkSync(verdictsPath);
  fs.unlinkSync(failedPath);
});

test('vision-verify: prepareVerdictsForDecisionMap keeps yes+partial, maps matchesCriteria', () => {
  const candidates = prepareVerdictsForDecisionMap([
    { id: 'a', label: 'A', url: 'https://a.com', category: 'x', verdict: 'yes',
      rationale: 'clear', source: 'websearch', screenshotPath: '/tmp/a.jpg',
      options_count: 5, picker_placement: 'hero' },
    { id: 'b', label: 'B', url: 'https://b.com', category: 'x', verdict: 'partial',
      rationale: 'iffy', source: 'listicle', screenshotPath: '/tmp/b.jpg' },
    { id: 'c', label: 'C', url: 'https://c.com', verdict: 'no' },
  ]);
  assert.strictEqual(candidates.length, 2);
  assert.strictEqual(candidates[0].matchesCriteria, 'yes');
  assert.strictEqual(candidates[1].matchesCriteria, 'maybe');
  assert.strictEqual(candidates[0].source, 'websearch');
  assert.strictEqual(candidates[0].screenshotPath, '/tmp/a.jpg');
});

// ---------- round-trip: seeds -> survivors -> verdicts -> decision-map input ----------

test('round-trip: seed discovery output feeds html-filter which feeds vision-verify', async () => {
  // Layer 1: merge
  const { seeds } = discoverSeeds({
    webSearchResults: [{ url: 'https://yes.com' }, { url: 'https://maybe.com' }],
    llmProposals: [{ id: 'no', label: 'No', url: 'https://no.com', category: 'x' }],
  });
  assert.strictEqual(seeds.length, 3);

  // Layer 2: simulate Haiku verdicts
  const htmlVerdicts = seeds.map((s) => {
    const host = safeHost(s.url);
    if (host === 'yes.com') return Object.assign({}, s, { verdict: 'yes', reason: 'match' });
    if (host === 'maybe.com') return Object.assign({}, s, { verdict: 'maybe', reason: 'unsure' });
    return Object.assign({}, s, { verdict: 'no', reason: 'mismatch' });
  });
  const { survivors } = writeSurvivors({ verdicts: htmlVerdicts });
  assert.strictEqual(survivors.length, 2);

  // Layer 3: simulate Sonnet verdicts with screenshot paths
  const visionVerdicts = survivors.map((s, i) => Object.assign({}, s, {
    verdict: i === 0 ? 'yes' : 'partial',
    options_count: i === 0 ? 6 : 3,
    picker_placement: 'hero',
    rationale: 'grid visible',
    screenshotPath: `/tmp/${s.id}.jpg`,
  }));
  const { verdicts: bound } = writeVerdicts({ verdicts: visionVerdicts });
  assert.strictEqual(bound.length, 2);

  // Prepare for decision map
  const dmCandidates = prepareVerdictsForDecisionMap(bound);
  assert.strictEqual(dmCandidates.length, 2);
  assert.ok(dmCandidates.every((c) => c.url && c.rationale && c.screenshotPath));
});

// Finalize
setTimeout(() => {
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  } else {
    console.log('\nAll scout-v2 tests passed.');
  }
}, 100);
