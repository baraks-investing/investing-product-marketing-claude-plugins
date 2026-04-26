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

const { normalizePatterns, buildShareText } = require('../build-report');
const { filterUrlsByResume, newPageWithCdpRetry } = require('../capture');
const { composeGallery } = require('../gallery-composer');

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

  // ---------- normalizePatterns — variant keys (scout-plugin-bug-report fixes) ----------

  await test('normalizePatterns — execStats {name, value, percent, note} variant', () => {
    const input = {
      execStats: [
        { name: 'Product-UI hero', value: '16 / 30', percent: 53, note: 'The dominant pattern.' },
        { name: 'No device chrome', value: '24 / 30', percent: 80 },
        { name: 'Real humans', percent: 7 },
      ],
    };
    const out = normalizePatterns(input);
    // name → label
    assert.strictEqual(out.execStats[0].label, 'Product-UI hero');
    // value + percent → "value · percent%"
    assert.strictEqual(out.execStats[0].main, '16 / 30 · 53%');
    // note → sub
    assert.strictEqual(out.execStats[0].sub, 'The dominant pattern.');
    // no note still works
    assert.strictEqual(out.execStats[1].main, '24 / 30 · 80%');
    assert.strictEqual(out.execStats[1].sub, undefined);
    // percent-only → "N%"
    assert.strictEqual(out.execStats[2].main, '7%');
  });

  await test('normalizePatterns — bestPractices {practice, rationale} variant', () => {
    const input = {
      bestPractices: [
        { practice: 'Lead with product UI', rationale: 'Removes the what-is-this friction.' },
        { practice: 'Skip the device mockup', rationale: 'Floating UI is modern.', evidence_entities: ['stripe', 'attio'] },
      ],
    };
    const out = normalizePatterns(input);
    // practice → rule
    assert.strictEqual(out.bestPractices[0].rule, 'Lead with product UI');
    // rationale → detail
    assert.strictEqual(out.bestPractices[0].detail, 'Removes the what-is-this friction.');
    // evidence_entities still append
    assert.ok(out.bestPractices[1].detail.includes('Evidence: stripe, attio.'),
      'evidence appended: ' + out.bestPractices[1].detail);
  });

  await test('normalizePatterns — patterns {evidence_count string, entities} variant', () => {
    const input = {
      patterns: [
        {
          title: 'Floating UI beats device mockups',
          evidence_count: '24 / 30',
          description: 'Only 2 of 30 show browser chrome.',
          entities: ['stripe', 'slack', 'attio'],
        },
        {
          title: 'Already numeric',
          percent: 20,
          count: 6,
          denominator: 30,
          description: 'no-op',
          examples: [],
        },
      ],
    };
    const out = normalizePatterns(input);
    // evidence_count "24 / 30" → numeric percent=80, count=24, denominator=30
    assert.strictEqual(out.patterns[0].percent, 80);
    assert.strictEqual(out.patterns[0].count, 24);
    assert.strictEqual(out.patterns[0].denominator, 30);
    // entities → examples
    assert.deepStrictEqual(out.patterns[0].examples, ['stripe', 'slack', 'attio']);
    // pattern that was already canonical is untouched
    assert.strictEqual(out.patterns[1].percent, 20);
    assert.strictEqual(out.patterns[1].count, 6);
  });

  await test('normalizePatterns — empty-string value does not emit dangling separator', () => {
    // Guard against Codex-flagged edge case: { value: "", percent: 5 } used to
    // produce main = " · 5%". Treat empty/whitespace-only value as absent.
    const input = {
      execStats: [
        { label: 'Only percent', value: '', percent: 5 },
        { label: 'Whitespace value', value: '   ', percent: 12 },
      ],
    };
    const out = normalizePatterns(input);
    assert.strictEqual(out.execStats[0].main, '5%', 'empty string value: ' + out.execStats[0].main);
    assert.strictEqual(out.execStats[1].main, '12%', 'whitespace value: ' + out.execStats[1].main);
  });

  await test('normalizePatterns — recommendations without body fall back to empty string', () => {
    // Codex-flagged: missing body used to pass-through and render literal 'undefined'.
    const input = {
      recommendations: [
        { title: 'Has rationale', rationale: 'x' },
        { title: 'Has body', body: 'y' },
        { title: 'Has neither' },
      ],
    };
    const out = normalizePatterns(input);
    assert.strictEqual(out.recommendations[0].body, 'x', 'rationale alias: ' + out.recommendations[0].body);
    assert.strictEqual(out.recommendations[1].body, 'y');
    assert.strictEqual(out.recommendations[2].body, '', 'missing body normalized to empty string, got: ' + JSON.stringify(out.recommendations[2].body));
  });

  // ---------- gallery-composer + buildShareText (share-button feature) ----------

  await test('buildShareText — full shape with company list under cap', () => {
    const txt = buildShareText({
      title: 'Hero images research',
      researchQuestion: 'How do top SaaS companies design their hero sections?',
      totalEntities: 30,
      patternsCount: 8,
      bestPracticesCount: 6,
      topFindings: ['Lead with product UI', 'Skip device mockups', 'Static + one accent'],
      companyNames: ['Stripe', 'Figma', 'Notion'],
      attachmentNote: 'Full report attached.',
    });
    assert.ok(txt.includes('How do top SaaS companies'), 'researchQuestion present');
    assert.ok(txt.includes('30 entities analyzed · 8 patterns · 6 best practices'), 'stats line: ' + txt);
    assert.ok(txt.includes('• Lead with product UI'), 'finding bullet');
    assert.ok(txt.includes('Researched: Stripe, Figma, Notion.'), 'company list with period: ' + txt);
    assert.ok(txt.includes('Full report attached.'), 'attachment note');
    assert.ok(!txt.includes('…'), 'no truncation marker for short list');
  });

  await test('buildShareText — long company list truncated at cap with ellipsis', () => {
    const names = [];
    for (let i = 1; i <= 35; i++) names.push('Company' + i);
    const txt = buildShareText({
      title: 't',
      totalEntities: 35,
      companyNames: names,
      companyCap: 30,
    });
    // First 30 included, 31..35 excluded, ellipsis marker present
    assert.ok(txt.includes('Company1,'), 'first company listed');
    assert.ok(txt.includes('Company30,'), 'cap company listed');
    assert.ok(!txt.includes('Company31'), 'over-cap company excluded: ' + txt);
    assert.ok(txt.includes('…'), 'truncation marker: ' + txt);
  });

  await test('buildShareText — empty company list omits the Researched line', () => {
    const txt = buildShareText({ title: 't', totalEntities: 0, companyNames: [] });
    assert.ok(!txt.includes('Researched:'), 'no Researched line when list empty');
  });

  await test('composeGallery — produces JPEG given 3 generated tiles + 6 missing paths', async () => {
    const sharp = require('sharp');
    const dir = tmpDir('gallery');
    // Generate 3 small test JPEGs (red, green, blue)
    const colors = ['#FF0000', '#00FF00', '#0000FF'];
    const paths = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(dir, 'tile' + i + '.jpg');
      const buf = await sharp({
        create: { width: 800, height: 1200, channels: 3, background: colors[i] },
      }).jpeg({ quality: 80 }).toBuffer();
      fs.writeFileSync(p, buf);
      paths.push(p);
    }
    const tiles = paths.map((p) => ({ path: p }));
    // Pad with 6 missing paths to fill 9 cells
    for (let i = 0; i < 6; i++) tiles.push({ path: path.join(dir, 'missing' + i + '.jpg') });

    const out = path.join(dir, 'composed.jpg');
    const result = await composeGallery({ tiles, outputPath: out });

    assert.strictEqual(result.outputPath, out);
    assert.ok(result.bytes > 0 && result.bytes < 500 * 1024, 'output JPEG ~under 500KB: ' + result.bytes);
    assert.deepStrictEqual(result.usedPaths.sort(), paths.slice().sort(), 'usedPaths matches the 3 valid');
    assert.strictEqual(result.skipped.length, 6, 'six skipped: ' + JSON.stringify(result.skipped));
    assert.ok(result.skipped.every((s) => s.reason === 'missing'), 'all skipped due to missing');

    // Verify output dimensions match the canvas math
    const meta = await sharp(out).metadata();
    assert.strictEqual(meta.width, 3 * 400 + 2 * 12, 'canvas width');
    assert.strictEqual(meta.height, 3 * 250 + 2 * 12, 'canvas height');
    assert.strictEqual(meta.format, 'jpeg', 'format is JPEG');
  });

  await test('composeGallery — null cropTop/cropHeight uses default top-600 (regression for nullish coercion)', async () => {
    const sharp = require('sharp');
    const dir = tmpDir('gallery-null');
    // Tall image: red on top 600, blue from 600 to 1200. With default
    // top-600 crop, output should be red. If null is coerced to 1, output
    // would degenerate to a one-pixel band (the bug we are guarding against).
    const buf = await sharp({
      create: { width: 800, height: 1200, channels: 3, background: '#FF0000' },
    })
      .composite([{
        input: await sharp({ create: { width: 800, height: 600, channels: 3, background: '#0000FF' } }).png().toBuffer(),
        top: 600, left: 0,
      }])
      .jpeg({ quality: 80 })
      .toBuffer();
    const tilePath = path.join(dir, 'two-band.jpg');
    fs.writeFileSync(tilePath, buf);

    const out = path.join(dir, 'null-out.jpg');
    await composeGallery({
      tiles: [{ path: tilePath, cropTop: null, cropHeight: null }],
      outputPath: out,
      cols: 1, rows: 1,
    });

    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const cx = Math.floor(info.width / 2);
    const cy = Math.floor(info.height / 2);
    const idx = (cy * info.width + cx) * info.channels;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    assert.ok(r > b && r > g, 'top-600 default produced red-dominant output (not 1px stretched): r=' + r + ' g=' + g + ' b=' + b);
  });

  await test('composeGallery — honors per-tile cropTop / cropHeight', async () => {
    const sharp = require('sharp');
    const dir = tmpDir('gallery-crop');
    // Generate a tall image with two color bands so we can verify which slice
    // gets used: red on top half, blue on bottom half. Crop the bottom half
    // and check the cell's average color leans blue.
    const buf = await sharp({
      create: { width: 800, height: 1200, channels: 3, background: '#FF0000' },
    })
      .composite([{
        input: await sharp({ create: { width: 800, height: 600, channels: 3, background: '#0000FF' } }).png().toBuffer(),
        top: 600, left: 0,
      }])
      .jpeg({ quality: 80 })
      .toBuffer();
    const tilePath = path.join(dir, 'two-band.jpg');
    fs.writeFileSync(tilePath, buf);

    const out = path.join(dir, 'crop-out.jpg');
    await composeGallery({
      tiles: [{ path: tilePath, cropTop: 600, cropHeight: 600 }], // bottom half (blue)
      outputPath: out,
      cols: 1, rows: 1,
    });

    // Read top-left pixel of output; should be blue-dominant.
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    // Sample center pixel
    const cx = Math.floor(info.width / 2);
    const cy = Math.floor(info.height / 2);
    const idx = (cy * info.width + cx) * info.channels;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    assert.ok(b > r && b > g, 'center pixel blue-dominant: r=' + r + ' g=' + g + ' b=' + b);
  });

  await test('normalizePatterns — evidence_count percent is clamped to [0, 100]', () => {
    // Codex-flagged: "30 / 24" used to yield percent 125. Clamp it so the
    // template's bar scale and value label stay in bounds.
    const input = {
      patterns: [
        { title: 'Over-100', evidence_count: '30 / 24', description: '' },
        { title: 'Under-0 impossible but safe', evidence_count: '0 / 10', description: '' },
      ],
    };
    const out = normalizePatterns(input);
    assert.strictEqual(out.patterns[0].percent, 100, 'clamp >100: ' + out.patterns[0].percent);
    assert.strictEqual(out.patterns[0].count, 30);
    assert.strictEqual(out.patterns[0].denominator, 24);
    assert.strictEqual(out.patterns[1].percent, 0);
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
