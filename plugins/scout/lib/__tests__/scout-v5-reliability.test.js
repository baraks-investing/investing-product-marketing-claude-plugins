#!/usr/bin/env node
/**
 * lib/__tests__/scout-v5-reliability.test.js
 *
 * Plain Node assertion tests for scout v5 reliability fixes.
 *
 * Covers:
 *   - normalizePatterns: template-shape pass-through
 *   - normalizePatterns: drift-shape mapping
 *   - normalizePatterns: hybrid-shape input
 *   - filterUrlsByResume: skips successful ids with on-disk files intact
 *   - newPageWithCdpRetry: succeeds on second attempt after CDP disconnect
 *   - newPageWithCdpRetry: gives up after 1 retry, surfaces original error
 *   - build-report mockups accepts both array and {count, items} shapes
 *
 * Run: node lib/__tests__/scout-v5-reliability.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizePatterns } = require('../build-report');
const { filterUrlsByResume, newPageWithCdpRetry } = require('../capture');

let failures = 0;
function test(name, fn) {
  const run = async () => {
    try {
      await fn();
      console.log(`ok  - ${name}`);
    } catch (err) {
      failures++;
      console.error(`FAIL - ${name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  };
  return run();
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `scout-v5-${tag}-`));
}

(async () => {

  // ---------- normalizePatterns ----------

  await test('normalizePatterns — template-shape pass-through', () => {
    const input = {
      execStats: [{ label: 'entities', main: '12', sub: 'analyzed' }],
      bestPractices: [{ rule: 'Anchor high', detail: 'Set price anchors.' }],
      patterns: [{
        title: 'Anchor visible above fold',
        percent: 67, count: 8, denominator: 12,
        description: 'Most pages anchor.', examples: ['alpha', 'bravo'],
      }],
      recommendations: [{ title: 'Anchor', body: 'Place anchor above fold.' }],
      observations: ['obs 1'],
    };
    const out = normalizePatterns(input);
    assert.strictEqual(out.execStats.length, 1);
    assert.strictEqual(out.execStats[0].main, '12');
    assert.strictEqual(out.execStats[0].sub, 'analyzed');
    assert.strictEqual(out.bestPractices[0].rule, 'Anchor high');
    assert.strictEqual(out.bestPractices[0].detail, 'Set price anchors.');
    assert.strictEqual(out.patterns.length, 1);
    assert.strictEqual(out.patterns[0].title, 'Anchor visible above fold');
    assert.strictEqual(out.patterns[0].percent, 67);
    assert.strictEqual(out.recommendations[0].body, 'Place anchor above fold.');
    assert.deepStrictEqual(out.observations, ['obs 1']);
  });

  await test('normalizePatterns — drift-shape mapping', () => {
    const input = {
      execStats: [
        { label: 'entities', value: '12', detail: 'analyzed' },
        { label: 'mode', value: 'full', description: 'capture mode' },
      ],
      bestPractices: [
        { title: 'Anchor high', description: 'Anchor above fold.', evidence_entities: ['alpha', 'bravo'] },
      ],
      patterns: [
        {
          dimension: 'anchor_placement',
          value_frequency: { above_fold: 8, below_fold: 4 },
          n_total: 12,
          dominant_value: 'above_fold',
          interpretation: 'Most pages anchor above the fold.',
        },
      ],
      recommendations: [{ title: 'Anchor', rationale: 'Place anchor above fold.' }],
      top_level_observations: ['obs A', 'obs B'],
    };
    const out = normalizePatterns(input);

    assert.strictEqual(out.execStats[0].main, '12');
    assert.strictEqual(out.execStats[0].sub, 'analyzed');
    assert.strictEqual(out.execStats[1].main, 'full');
    assert.strictEqual(out.execStats[1].sub, 'capture mode');

    assert.strictEqual(out.bestPractices[0].rule, 'Anchor high');
    assert.ok(out.bestPractices[0].detail.includes('Anchor above fold.'));
    assert.ok(out.bestPractices[0].detail.includes('Evidence: alpha, bravo.'),
      'evidence_entities appended: ' + out.bestPractices[0].detail);

    assert.strictEqual(out.patterns.length, 1);
    assert.ok(out.patterns[0].title.includes('Above Fold'), 'dominant prettified: ' + out.patterns[0].title);
    assert.ok(out.patterns[0].title.includes('anchor_placement'));
    assert.strictEqual(out.patterns[0].percent, 67);
    assert.strictEqual(out.patterns[0].count, 8);
    assert.strictEqual(out.patterns[0].denominator, 12);
    assert.strictEqual(out.patterns[0].description, 'Most pages anchor above the fold.');
    assert.deepStrictEqual(out.patterns[0].examples, []);

    assert.strictEqual(out.recommendations[0].body, 'Place anchor above fold.');
    assert.deepStrictEqual(out.observations, ['obs A', 'obs B']);
  });

  await test('normalizePatterns — hybrid shape (template bestPractices + drift execStats)', () => {
    const input = {
      execStats: [{ label: 'entities', value: '7', detail: 'analyzed' }],
      bestPractices: [{ rule: 'Already template', detail: 'ok' }],
      patterns: [],
      recommendations: [],
      observations: [],
    };
    const out = normalizePatterns(input);
    assert.strictEqual(out.execStats[0].main, '7');
    assert.strictEqual(out.execStats[0].sub, 'analyzed');
    assert.strictEqual(out.bestPractices[0].rule, 'Already template');
    assert.strictEqual(out.bestPractices[0].detail, 'ok');
  });

  // ---------- filterUrlsByResume ----------

  await test('filterUrlsByResume — skips successful ids with on-disk files', () => {
    const dir = tmpDir('resume');
    const f1 = path.join(dir, 'alpha.jpg');
    const f2 = path.join(dir, 'bravo.jpg');
    fs.writeFileSync(f1, 'x');
    fs.writeFileSync(f2, 'x');
    const metadata = {
      results: [
        { id: 'alpha', status: 'success', file: f1 },
        { id: 'bravo', status: 'success', file: f2 },
        { id: 'charlie', status: 'error', file: null },
      ],
    };
    const urls = [
      { id: 'alpha', url: 'https://alpha.test' },
      { id: 'bravo', url: 'https://bravo.test' },
      { id: 'charlie', url: 'https://charlie.test' },
    ];
    const { toCapture, skipped } = filterUrlsByResume(urls, metadata, fs.existsSync);
    assert.strictEqual(toCapture.length, 1);
    assert.strictEqual(toCapture[0].id, 'charlie');
    assert.strictEqual(skipped.length, 2);

    // If on-disk file missing, the entry should NOT be skipped (retry path).
    fs.unlinkSync(f1);
    const { toCapture: t2, skipped: s2 } = filterUrlsByResume(urls, metadata, fs.existsSync);
    const t2Ids = t2.map((u) => u.id).sort();
    assert.deepStrictEqual(t2Ids, ['alpha', 'charlie']);
    assert.strictEqual(s2.length, 1);
    assert.strictEqual(s2[0].id, 'bravo');
  });

  // ---------- newPageWithCdpRetry ----------

  await test('newPageWithCdpRetry — succeeds on second newPage after CDP disconnect', async () => {
    let newPageCalls = 0;
    let closeCalls = 0;
    let launcherCalls = 0;
    const fakePage1 = { _id: 'page1' };
    const fakePage2 = { _id: 'page2' };
    const firstBrowser = {
      async newPage() {
        newPageCalls++;
        throw new Error('Protocol error (Target.createTarget): Connection closed.');
      },
      async close() { closeCalls++; },
    };
    const secondBrowser = {
      async newPage() { newPageCalls++; return fakePage2; },
      async close() { closeCalls++; },
    };
    void fakePage1;
    const holder = { current: firstBrowser };
    async function launcher() { launcherCalls++; return secondBrowser; }

    const page = await newPageWithCdpRetry(holder, launcher);
    assert.strictEqual(page, fakePage2);
    assert.strictEqual(newPageCalls, 2);
    assert.strictEqual(launcherCalls, 1);
    assert.strictEqual(closeCalls, 1);
    assert.strictEqual(holder.current, secondBrowser);
  });

  await test('newPageWithCdpRetry — gives up after 1 retry', async () => {
    let newPageCalls = 0;
    let launcherCalls = 0;
    function makeBadBrowser() {
      return {
        async newPage() {
          newPageCalls++;
          throw new Error('Protocol error: Connection closed.');
        },
        async close() { /* noop */ },
      };
    }
    const holder = { current: makeBadBrowser() };
    async function launcher() { launcherCalls++; return makeBadBrowser(); }

    let caught = null;
    try {
      await newPageWithCdpRetry(holder, launcher);
    } catch (err) { caught = err; }
    assert.ok(caught, 'should have thrown');
    assert.ok(/Protocol error|Connection closed/i.test(caught.message));
    assert.strictEqual(newPageCalls, 2, 'exactly one retry after the initial failure');
    assert.strictEqual(launcherCalls, 1, 'relaunch called exactly once');
  });

  // ---------- build-report: brief.mockups shape tolerance ----------

  await test('buildReport — brief.mockups as array (legacy)', async () => {
    // Use a throwaway project root with just enough scaffolding for buildReport.
    const root = tmpDir('mockup-array');
    fs.writeFileSync(path.join(root, 'brief.json'), JSON.stringify({
      projectId: 'test', researchQuestion: 'test q', dimensions: [],
      entities: [], mockups: [{ title: 'A', hypothesis: 'h', filePath: 'mockups/a.html' }],
    }));
    fs.writeFileSync(path.join(root, 'entity-data.json'), '{}');
    fs.writeFileSync(path.join(root, 'patterns.json'), JSON.stringify({ patterns: [], recommendations: [], observations: [] }));
    fs.mkdirSync(path.join(root, 'mockups'));
    fs.writeFileSync(path.join(root, 'mockups', 'a.html'), '<!doctype html><title>a</title>');
    const { buildReport } = require('../build-report');
    const out = path.join(root, 'research-report.html');
    await buildReport({ briefPath: path.join(root, 'brief.json'), entityDataPath: path.join(root, 'entity-data.json'), patternsPath: path.join(root, 'patterns.json'), outputPath: out });
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(html.includes('mockup-card'), 'expected mockup card markup from array-shape brief.mockups');
  });

  await test('buildReport — brief.mockups as {count, items} (new /scout:execute shape)', async () => {
    const root = tmpDir('mockup-object');
    fs.writeFileSync(path.join(root, 'brief.json'), JSON.stringify({
      projectId: 'test', researchQuestion: 'test q', dimensions: [],
      entities: [],
      mockups: { count: 1, items: [{ title: 'A', hypothesis: 'h', filePath: 'mockups/a.html' }] },
    }));
    fs.writeFileSync(path.join(root, 'entity-data.json'), '{}');
    fs.writeFileSync(path.join(root, 'patterns.json'), JSON.stringify({ patterns: [], recommendations: [], observations: [] }));
    fs.mkdirSync(path.join(root, 'mockups'));
    fs.writeFileSync(path.join(root, 'mockups', 'a.html'), '<!doctype html><title>a</title>');
    const { buildReport } = require('../build-report');
    const out = path.join(root, 'research-report.html');
    await buildReport({ briefPath: path.join(root, 'brief.json'), entityDataPath: path.join(root, 'entity-data.json'), patternsPath: path.join(root, 'patterns.json'), outputPath: out });
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(html.includes('mockup-card'), 'expected mockup card markup from {count,items}-shape brief.mockups');
  });

  // ----------

  if (failures) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll scout v5 reliability tests passed.');
  }
})();
