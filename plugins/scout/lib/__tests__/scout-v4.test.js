#!/usr/bin/env node
/**
 * lib/__tests__/scout-v4.test.js
 *
 * Plain Node assertion tests for scout v4 mid-tier features.
 *
 * Covers:
 *   - writeBrief lens mapping per decision_type (auto override)
 *   - writeBrief explicit lens override wins over decision_type
 *   - writeBrief battlecard mapping per decision_type
 *   - v3-shape paste-back (no override blocks) parses with both defaults = 'auto'
 *   - seed-discovery with 6 streams merges + tags trust correctly
 *   - seed-discovery two-LLM consensus bumps low -> medium
 *   - seed-discovery with codex stream empty/undefined behaves same as without
 *   - sortByTrust orders high -> medium -> low, stable within tier
 *   - validateBattlecard rejects missing fields + wrong-length arrays
 *   - renderBattlecard produces a file under 80KB with all 7 sections
 *
 * Run: node lib/__tests__/scout-v4.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parse, writeBrief, LENS_MAPPING, BATTLECARD_MAPPING } = require('../parse-paste-back');
const { discoverSeeds, sortByTrust } = require('../seed-discovery');
const { validateBattlecard, renderBattlecard } = require('../build-battlecard');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok  - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `scout-v4-${tag}-`));
}

// ---------- paste-back samples ----------

function v4Sample({ decisionType = 'pricing', lensOverride = 'auto', bcOverride = 'auto' } = {}) {
  return [
    '=== SCOUT DECISION MAP v2 ===',
    'project_id: sc_v4test',
    'schema: v2',
    'generated_at: 2026-04-21T00:00:00Z',
    '',
    '--- Research question ---',
    'value: How do pricing pages structure their tiers?',
    '',
    '--- Decision type ---',
    'value: ' + decisionType,
    '',
    '--- Inclusion criteria ---',
    'selected: [has pricing page]',
    'custom_added: []',
    '',
    '--- Exclusion criteria ---',
    'selected: []',
    'custom_added: []',
    '',
    '--- Dimensions ---',
    'selected: [headline, primary_cta]',
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
    'value: none',
    '',
    '--- Second-opinion model ---',
    'value: sonnet',
    '',
    '--- Notes ---',
    'value: ',
    '',
    '--- Framework lens override ---',
    'value: ' + lensOverride,
    '',
    '--- Battlecards override ---',
    'value: ' + bcOverride,
    '',
    '--- Approved candidates ---',
    '- id=alpha | label=Alpha | url=https://alpha.test | category=saas',
    '',
    '--- Custom candidates ---',
    '(none)',
    '=== END SCOUT DECISION MAP v2 ===',
  ].join('\n');
}

function v3Sample(decisionType = 'pricing') {
  // v3-shape: no Framework lens / Battlecards blocks at all.
  return [
    '=== SCOUT DECISION MAP v2 ===',
    'project_id: sc_v3test',
    'schema: v2',
    'generated_at: 2026-04-21T00:00:00Z',
    '',
    '--- Research question ---',
    'value: old v3 research',
    '',
    '--- Decision type ---',
    'value: ' + decisionType,
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
    'selected: [headline]',
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
    'value: none',
    '',
    '--- Second-opinion model ---',
    'value: sonnet',
    '',
    '--- Approved candidates ---',
    '- id=alpha | label=Alpha | url=https://alpha.test | category=saas',
    '',
    '--- Custom candidates ---',
    '(none)',
    '=== END SCOUT DECISION MAP v2 ===',
  ].join('\n');
}

// ---------- tests ----------

test('writeBrief applies lens mapping per decision_type when override is auto', () => {
  const cases = [
    ['pricing', 'price_anchor'],
    ['feature_roadmap', 'kano'],
    ['positioning', 'jtbd'],
    ['launch_messaging', 'jtbd'],
    ['ux_pattern', 'descriptive'],
    ['gtm', 'descriptive'],
    ['battlecard', 'descriptive'],
    ['other', 'descriptive'],
  ];
  cases.forEach(([dt, expected]) => {
    const dir = tmpDir('lens-' + dt);
    const parsed = parse(v4Sample({ decisionType: dt, lensOverride: 'auto' }));
    writeBrief(parsed, dir);
    const brief = JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8'));
    assert.strictEqual(brief.framework_lens, expected,
      `decisionType=${dt} should map to ${expected}, got ${brief.framework_lens}`);
    assert.strictEqual(brief.framework_lens_source, 'inferred');
    // Mapping constant also agrees.
    assert.strictEqual(LENS_MAPPING[dt], expected);
  });
});

test('writeBrief explicit lens override wins over decision_type', () => {
  const dir = tmpDir('lens-override');
  // decisionType 'pricing' would infer 'price_anchor'; explicit 'jtbd' should win.
  const parsed = parse(v4Sample({ decisionType: 'pricing', lensOverride: 'jtbd' }));
  writeBrief(parsed, dir);
  const brief = JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8'));
  assert.strictEqual(brief.framework_lens, 'jtbd');
  assert.strictEqual(brief.framework_lens_source, 'explicit');
});

test('writeBrief battlecard mapping per decision_type when override is auto', () => {
  const cases = [
    ['pricing', true],
    ['positioning', true],
    ['launch_messaging', true],
    ['gtm', true],
    ['battlecard', true],
    ['ux_pattern', false],
    ['feature_roadmap', false],
    ['other', false],
  ];
  cases.forEach(([dt, expected]) => {
    const dir = tmpDir('bc-' + dt);
    const parsed = parse(v4Sample({ decisionType: dt, bcOverride: 'auto' }));
    writeBrief(parsed, dir);
    const brief = JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8'));
    assert.strictEqual(brief.battlecard_enabled, expected,
      `decisionType=${dt} battlecard should be ${expected}, got ${brief.battlecard_enabled}`);
    assert.strictEqual(brief.battlecard_source, 'inferred');
    assert.strictEqual(BATTLECARD_MAPPING[dt], expected);
  });
});

test('explicit battlecard override (yes/no) wins over decision_type', () => {
  // ux_pattern would be false; override 'yes' must win.
  const dirYes = tmpDir('bc-yes');
  const parsedYes = parse(v4Sample({ decisionType: 'ux_pattern', bcOverride: 'yes' }));
  writeBrief(parsedYes, dirYes);
  const briefYes = JSON.parse(fs.readFileSync(path.join(dirYes, 'brief.json'), 'utf8'));
  assert.strictEqual(briefYes.battlecard_enabled, true);
  assert.strictEqual(briefYes.battlecard_source, 'explicit');

  // pricing would be true; override 'no' must win.
  const dirNo = tmpDir('bc-no');
  const parsedNo = parse(v4Sample({ decisionType: 'pricing', bcOverride: 'no' }));
  writeBrief(parsedNo, dirNo);
  const briefNo = JSON.parse(fs.readFileSync(path.join(dirNo, 'brief.json'), 'utf8'));
  assert.strictEqual(briefNo.battlecard_enabled, false);
  assert.strictEqual(briefNo.battlecard_source, 'explicit');
});

test('v3-shape paste-back (no override blocks) defaults to auto for both', () => {
  const dir = tmpDir('v3-defaults');
  const parsed = parse(v3Sample('pricing'));
  // structured defaults should be 'auto'
  assert.strictEqual(parsed.structured.frameworkLensOverride, 'auto');
  assert.strictEqual(parsed.structured.battlecardOverride, 'auto');
  writeBrief(parsed, dir);
  const brief = JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8'));
  // auto + pricing → price_anchor + battlecard true
  assert.strictEqual(brief.framework_lens, 'price_anchor');
  assert.strictEqual(brief.framework_lens_source, 'inferred');
  assert.strictEqual(brief.battlecard_enabled, true);
  assert.strictEqual(brief.battlecard_source, 'inferred');
});

test('seed-discovery merges 6 streams and tags trust correctly', () => {
  const { seeds } = discoverSeeds({
    webSearchResults: [
      { url: 'https://alpha.test/pricing', primaryDomain: 'alpha.test', query: 'alpha' },
    ],
    listicleResults: [
      { url: 'https://top10.example/sass', extractedCompanies: [
        { url: 'https://bravo.test', name: 'Bravo' },
      ] },
    ],
    llmProposals: [{ url: 'https://charlie.test', label: 'Charlie' }],
    codexLlmProposals: [{ url: 'https://delta.test', label: 'Delta' }],
    productHuntMentions: [{ url: 'https://echo.test', context: 'PH launch' }],
    hackerNewsMentions: [{ url: 'https://foxtrot.test', context: 'HN comment' }],
    g2CapterraCatalog: [{ url: 'https://golf.test', context: 'G2 category' }],
  });
  const byHost = {};
  seeds.forEach((s) => { byHost[new URL(s.url).hostname] = s; });
  assert.strictEqual(byHost['alpha.test'].source_trust, 'high',  'websearch own-domain → high');
  assert.strictEqual(byHost['bravo.test'].source_trust, 'low',   'listicle → low');
  assert.strictEqual(byHost['charlie.test'].source_trust, 'low', 'claude llm → low');
  assert.strictEqual(byHost['delta.test'].source_trust, 'low',   'codex llm → low');
  assert.strictEqual(byHost['echo.test'].source_trust, 'medium', 'product hunt → medium');
  assert.strictEqual(byHost['foxtrot.test'].source_trust, 'medium', 'hacker news → medium');
  assert.strictEqual(byHost['golf.test'].source_trust, 'medium', 'g2 → medium');
});

test('seed-discovery bumps two-LLM consensus from low to medium', () => {
  const { seeds } = discoverSeeds({
    llmProposals: [{ url: 'https://consensus.test', label: 'Consensus' }],
    codexLlmProposals: [{ url: 'https://consensus.test', label: 'Consensus' }],
  });
  assert.strictEqual(seeds.length, 1);
  assert.strictEqual(seeds[0].source_trust, 'medium');
  assert.ok(String(seeds[0].trust_reason || '').toLowerCase().includes('two-llm'));
});

test('seed-discovery with codex stream empty/undefined matches without', () => {
  const base = {
    webSearchResults: [{ url: 'https://alpha.test', primaryDomain: 'alpha.test' }],
    llmProposals: [{ url: 'https://charlie.test' }],
  };
  const withoutCodex = discoverSeeds(Object.assign({}, base));
  const emptyCodex = discoverSeeds(Object.assign({}, base, { codexLlmProposals: [] }));
  const undefCodex = discoverSeeds(Object.assign({}, base, { codexLlmProposals: undefined }));
  // Same set of hostnames, same trust tiers.
  function shape(r) {
    return r.seeds.map((s) => `${new URL(s.url).hostname}:${s.source_trust}`).sort();
  }
  assert.deepStrictEqual(shape(emptyCodex), shape(withoutCodex));
  assert.deepStrictEqual(shape(undefCodex), shape(withoutCodex));
});

test('sortByTrust orders high -> medium -> low, stable within tier', () => {
  const input = [
    { id: 'a1', source_trust: 'low' },
    { id: 'a2', source_trust: 'high' },
    { id: 'a3', source_trust: 'medium' },
    { id: 'a4', source_trust: 'high' },
    { id: 'a5', source_trust: 'low' },
    { id: 'a6', source_trust: 'medium' },
    { id: 'a7' }, // missing → treated as low
  ];
  const out = sortByTrust(input);
  const ids = out.map((x) => x.id);
  // Stable within each tier by original index
  assert.deepStrictEqual(ids, ['a2', 'a4', 'a3', 'a6', 'a1', 'a5', 'a7']);
});

test('validateBattlecard rejects missing fields and wrong-length arrays', () => {
  assert.throws(() => validateBattlecard(null), /not an object/);
  assert.throws(() => validateBattlecard({}), /required string field/);
  assert.throws(() => validateBattlecard({
    one_line: 'x', when_they_win: 'y', when_we_win: 'z',
    strengths: ['a', 'b'], weaknesses: ['a', 'b', 'c'], how_to_beat: ['a', 'b', 'c'],
  }), /exactly 3 items/);
  assert.throws(() => validateBattlecard({
    one_line: 'x', when_they_win: 'y', when_we_win: 'z',
    strengths: ['a', 'b', 'c', 'd'], weaknesses: ['a', 'b', 'c'], how_to_beat: ['a', 'b', 'c'],
  }), /exactly 3 items/);
  // Valid passes without throwing.
  assert.ok(validateBattlecard({
    one_line: 'one', when_they_win: 'they', when_we_win: 'we',
    strengths: ['s1', 's2', 's3'],
    weaknesses: ['w1', 'w2', 'w3'],
    how_to_beat: ['h1', 'h2', 'h3'],
  }));
});

test('renderBattlecard produces a file under 80KB with all 7 visible sections', () => {
  const outRoot = tmpDir('bc-render');
  const concept = {
    one_line: 'Alpha is a SaaS for small teams who want pipeline dashboards.',
    strengths: [
      'Charts render in 200ms with 50+ indicators.',
      'Slack integration ships event notifications in real time.',
      'Tiered pricing is transparent and anchored at $19.',
    ],
    weaknesses: [
      'No mobile app.',
      'Weak onboarding — first-run flow is 9 steps.',
      'Support only by email, 48h SLA.',
    ],
    how_to_beat: [
      'Ship a mobile app with offline read.',
      'Collapse onboarding to 3 steps with live data.',
      'Offer 4-hour support SLA on annual plans.',
    ],
    when_they_win: 'Small teams that live in Slack and just want the cheapest dashboard.',
    when_we_win: 'Teams that need mobile access and fast onboarding with a human in the loop.',
  };
  const result = renderBattlecard({
    concept,
    entity: { id: 'alpha-co', label: 'Alpha Co.', url: 'https://alpha.test', category: 'saas' },
    outDir: path.join(outRoot, 'battlecards'),
    backHref: '../../research-report.html',
    capturedAt: '2026-04-21 00:00 UTC',
    contentHash: 'abcdef1234567890',
  });
  assert.ok(fs.existsSync(result.filePath), 'file exists');
  assert.ok(result.bytes < 80 * 1024, 'file under 80KB, got ' + result.bytes);
  const html = fs.readFileSync(result.filePath, 'utf8');
  // 7 visible sections: header title, one_line, strengths, weaknesses,
  // how_to_beat, when_they_win, when_we_win.
  assert.ok(html.includes('Alpha Co.'), 'header title');
  assert.ok(html.includes(concept.one_line), 'one_line');
  assert.ok(html.includes('Strengths'), 'strengths header');
  assert.ok(html.includes(concept.strengths[0]), 'strengths item');
  assert.ok(html.includes('Weaknesses'), 'weaknesses header');
  assert.ok(html.includes(concept.weaknesses[0]), 'weaknesses item');
  assert.ok(html.includes('How to beat them'), 'how_to_beat header');
  assert.ok(html.includes(concept.how_to_beat[0]), 'how_to_beat item');
  assert.ok(html.includes('When they win'), 'when_they_win header');
  assert.ok(html.includes(concept.when_they_win), 'when_they_win body');
  assert.ok(html.includes('When we win'), 'when_we_win header');
  assert.ok(html.includes(concept.when_we_win), 'when_we_win body');
  // File path under <category>/<id>.html.
  assert.ok(result.filePath.replace(/\\/g, '/').endsWith('/saas/alpha-co.html'),
    'path under <category>/<id>.html, got ' + result.filePath);
});

// ----------

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll scout v4 tests passed.');
}
