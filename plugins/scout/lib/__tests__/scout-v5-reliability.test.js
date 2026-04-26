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

const { normalizePatterns, cropToTop } = require('../build-report');
const { filterUrlsByResume, newPageWithCdpRetry } = require('../capture');
const parsePasteBack = require('../parse-paste-back');

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

  // ---------- cropToTop (entity-card thumbnail) ----------

  await test('cropToTop — caps tall image at top-1200 px', async () => {
    const sharp = require('sharp');
    const dir = tmpDir('croptop');
    const tilePath = path.join(dir, 'tall.jpg');
    // 800 × 3000 image — taller than 1200 cap
    const buf = await sharp({
      create: { width: 800, height: 3000, channels: 3, background: '#FF0000' },
    }).jpeg({ quality: 80 }).toBuffer();
    fs.writeFileSync(tilePath, buf);

    const dataUri = await cropToTop(tilePath, 1200, 70);
    assert.ok(typeof dataUri === 'string' && dataUri.startsWith('data:image/jpeg;base64,'),
      'returns data URI: ' + (dataUri && dataUri.slice(0, 40)));

    // Decode and check dimensions
    const b64 = dataUri.split(',', 2)[1];
    const outBuf = Buffer.from(b64, 'base64');
    const meta = await sharp(outBuf).metadata();
    assert.strictEqual(meta.height, 1200, 'output height capped at 1200, got ' + meta.height);
    assert.strictEqual(meta.width, 800, 'output width preserved');
  });

  await test('cropToTop — edge case: 1500px source caps at 1200, NOT 1500 (Codex-flagged)', async () => {
    const sharp = require('sharp');
    const dir = tmpDir('croptop-edge');
    const tilePath = path.join(dir, 'mid.jpg');
    // 800 × 1500 — between 1200 and "very tall". Output must still cap at 1200.
    const buf = await sharp({
      create: { width: 800, height: 1500, channels: 3, background: '#0000FF' },
    }).jpeg({ quality: 80 }).toBuffer();
    fs.writeFileSync(tilePath, buf);

    const dataUri = await cropToTop(tilePath, 1200, 70);
    const outBuf = Buffer.from(dataUri.split(',', 2)[1], 'base64');
    const meta = await sharp(outBuf).metadata();
    assert.strictEqual(meta.height, 1200, '1500px source → output must be 1200px not 1500px, got ' + meta.height);
  });

  await test('cropToTop — short image (under cap) uses full height', async () => {
    const sharp = require('sharp');
    const dir = tmpDir('croptop-short');
    const tilePath = path.join(dir, 'short.jpg');
    // 800 × 600 — shorter than the 1200 cap, output should be the full 600.
    const buf = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#00FF00' },
    }).jpeg({ quality: 80 }).toBuffer();
    fs.writeFileSync(tilePath, buf);

    const dataUri = await cropToTop(tilePath, 1200, 70);
    const outBuf = Buffer.from(dataUri.split(',', 2)[1], 'base64');
    const meta = await sharp(outBuf).metadata();
    assert.strictEqual(meta.height, 600, 'short source returns its full height: ' + meta.height);
  });

  // ---------- parse-paste-back: marketing_design enum ----------

  await test('parse-paste-back — accepts marketing_design as valid decision_type', () => {
    const minimalPaste = [
      '=== SCOUT DECISION MAP v2 ===',
      'project_id: sc_test_001',
      'schema: v2',
      'generated_at: 2026-04-26T00:00:00Z',
      '',
      '--- Research question ---',
      'value: Test research question',
      '',
      '--- Decision type ---',
      'value: marketing_design',
      '',
      '--- Inclusion criteria ---',
      'selected: []',
      'custom_added: []',
      '',
      '--- Exclusion criteria ---',
      'selected: []',
      'custom_added: []',
      '',
      '--- Dimensions ---',
      'selected: []',
      'custom_added: []',
      '',
      '--- Visual evidence ---',
      'selected: [desktop]',
      '',
      '--- Target entity count ---',
      'value: 20',
      '',
      '--- Minimum verified ---',
      'value: 15',
      '',
      '--- Mockup count ---',
      'value: 3-5',
      '',
      '--- Second-opinion model ---',
      'value: sonnet',
      '',
      '--- Reference screenshot ---',
      'value: (none)',
      '',
      '--- Notes ---',
      'value:',
      '',
      '--- Approved candidates ---',
      '',
      '--- Custom candidates ---',
      '(none)',
      '',
      '=== END SCOUT DECISION MAP v2 ===',
    ].join('\n');

    const parsed = parsePasteBack.parse(minimalPaste);
    assert.strictEqual(parsed.structured.decisionType, 'marketing_design',
      'decisionType preserved through parse: ' + parsed.structured.decisionType);

    // writeBrief reads parsed.structured directly — pass parsed verbatim.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-mdesign-'));
    parsePasteBack.writeBrief(parsed, tmp);
    const briefJson = JSON.parse(fs.readFileSync(path.join(tmp, 'brief.json'), 'utf8'));
    assert.strictEqual(briefJson.decisionType, 'marketing_design',
      'brief.json decisionType matches: ' + briefJson.decisionType);
    // Inferred lens for marketing_design = descriptive (per LENS_MAPPING update)
    assert.strictEqual(briefJson.framework_lens, 'descriptive',
      'inferred framework lens: ' + briefJson.framework_lens);
    // marketing_design does NOT auto-enable battlecards
    assert.strictEqual(briefJson.battlecard_enabled, false,
      'battlecard_enabled false for marketing_design: ' + briefJson.battlecard_enabled);
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
