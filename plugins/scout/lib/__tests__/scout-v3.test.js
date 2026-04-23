#!/usr/bin/env node
/**
 * lib/__tests__/scout-v3.test.js
 *
 * Plain Node assertion tests. Exits non-zero on failure.
 *
 * Covers:
 *   - parse-paste-back v2 round-trip (structured inputs + custom_added)
 *   - parse-paste-back v1 legacy parses with defaults
 *   - Missing new-schema fields fall through to sensible defaults
 *   - util.contentHash stability (same bytes -> same hash; different bytes -> different hash)
 *   - build-mockup validateConcept enforces required annotation fields
 *   - build-mockup renders HTML containing title, annotations, and both tabs
 *   - seed-discovery round-tracking + already-seen-domain dedupe
 *
 * Run: node lib/__tests__/scout-v3.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parse, writeBrief } = require('../parse-paste-back');
const { contentHash } = require('../util');
const { validateConcept, renderMockup } = require('../build-mockup');
const { discoverSeeds } = require('../seed-discovery');
const { buildJudgeInput } = require('../vision-verify');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), `scout-v3-${tag}-`));
}

// ---------- v2 paste-back sample ----------

const V2_SAMPLE = [
  '=== SCOUT DECISION MAP v2 ===',
  'project_id: sc_abc123',
  'schema: v2',
  'generated_at: 2026-04-21T12:00:00Z',
  '',
  '--- Research question ---',
  'value: How do AI-native pricing pages frame the top tier?',
  '',
  '--- Decision type ---',
  'value: pricing',
  '',
  '--- Inclusion criteria ---',
  'selected: [three_plus_tiers, public_pricing, retail_self_serve]',
  'custom_added: [has_annual_toggle]',
  '',
  '--- Exclusion criteria ---',
  'selected: [contact_sales_only, single_tier]',
  'custom_added: []',
  '',
  '--- Dimensions ---',
  'selected: [tier_names, price_delta, badge_placement]',
  'custom_added: [annual_discount_pct]',
  '',
  '--- Visual evidence ---',
  'value: desktop-atf',
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
  '--- Mockup kind ---',
  'selected: [tier_layout, badge_treatment]',
  'custom_added: [anchor_pricing]',
  '',
  '--- Second-opinion model ---',
  'value: opus',
  '',
  '--- Notes ---',
  'value: |',
  '  prefer examples with yearly savings highlighted',
  '  skip crypto-only tools',
  '',
  '--- Approved candidates ---',
  '- id=stripe | label=Stripe | url=https://stripe.com/pricing | category=devtools',
  '- id=notion | label=Notion | url=https://notion.so/pricing | category=productivity',
  '',
  '--- Custom candidates ---',
  '(none)',
  '',
  '=== END SCOUT DECISION MAP v2 ===',
].join('\n');

test('v2 paste-back parses structured fields', () => {
  const parsed = parse(V2_SAMPLE);
  assert.strictEqual(parsed.schemaVersion, 'v2');
  assert.strictEqual(parsed.projectId, 'sc_abc123');
  assert.strictEqual(parsed.structured.decisionType, 'pricing');
  assert.strictEqual(parsed.structured.researchQuestion, 'How do AI-native pricing pages frame the top tier?');
  assert.deepStrictEqual(parsed.structured.inclusionSelected, ['three_plus_tiers', 'public_pricing', 'retail_self_serve']);
  assert.deepStrictEqual(parsed.structured.inclusionCustom, ['has_annual_toggle']);
  assert.deepStrictEqual(parsed.structured.dimensionsCustom, ['annual_discount_pct']);
  assert.strictEqual(parsed.structured.targetCount, 20);
  assert.strictEqual(parsed.structured.minVerified, 15);
  assert.strictEqual(parsed.structured.mockupCount, '3-5');
  // Mockup kind field was removed; legacy paste-backs that include it are tolerated (block ignored).
  assert.strictEqual(parsed.structured.mockupKindSelected, undefined);
  assert.strictEqual(parsed.structured.secondOpinionModel, 'opus');
  assert.ok(parsed.structured.notes.includes('yearly savings'));
  assert.strictEqual(parsed.approvedCandidates.length, 2);
});

test('v2 writeBrief emits brief.json with all new fields', () => {
  const parsed = parse(V2_SAMPLE);
  const dir = tmpDir('v2-write');
  writeBrief(parsed, dir);
  const brief = JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8'));
  assert.strictEqual(brief.decisionType, 'pricing');
  assert.strictEqual(brief.minVerified, 15);
  assert.strictEqual(brief.targetCount, 20);
  assert.strictEqual(brief.reseedRounds, 1);
  // mockupKind removed from brief shape post-v3 repair pass 1
  assert.strictEqual(brief.mockupKind, undefined);
  assert.ok(brief.dimensions.includes('tier_names'));
  assert.ok(brief.dimensions.includes('annual_discount_pct'));
  assert.strictEqual(brief.schemaVersion, 'v2');
});

test('v2 paste-back missing optional blocks falls through to defaults', () => {
  // Strip Notes block — still valid since Notes is optional
  const minimal = V2_SAMPLE
    .replace(/--- Mockup kind ---[\s\S]*?(?=\n---|\n===)/,
      '--- Mockup kind ---\nselected: []\ncustom_added: []\n')
    .replace('value: 3-5', 'value: none')
    .replace('value: opus', 'value: sonnet');
  const parsed = parse(minimal);
  const dir = tmpDir('v2-defaults');
  writeBrief(parsed, dir);
  const brief = JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8'));
  assert.strictEqual(brief.mockups.count, 'none');
  assert.strictEqual(brief.mockupKind, undefined);
  assert.strictEqual(brief.secondOpinionModel, 'sonnet');
});

// ---------- legacy tolerance: paste-back without Mockup kind block ----------

test('v2 paste-back without Mockup kind block parses cleanly (post-repair-pass-1)', () => {
  const noMockupKind = V2_SAMPLE.replace(/\n--- Mockup kind ---[\s\S]*?(?=\n--- Second-opinion)/, '\n');
  const parsed = parse(noMockupKind);
  assert.strictEqual(parsed.schemaVersion, 'v2');
  assert.strictEqual(parsed.structured.mockupCount, '3-5');
});

// ---------- reference screenshot plumbing (R3) ----------

test('buildJudgeInput threads reference_screenshot_path when provided', () => {
  const input = buildJudgeInput({
    screenshotPath: '/abs/shot.jpg',
    url: 'https://example.com',
    researchQuestion: 'profiling pickers',
    inclusionCriteria: '>=4 options',
    optionsThreshold: 4,
    referenceScreenshotPath: '/abs/reference/seed.png',
  });
  assert.strictEqual(input.screenshot_path, '/abs/shot.jpg');
  assert.strictEqual(input.reference_screenshot_path, '/abs/reference/seed.png');
  assert.strictEqual(input.options_threshold, 4);
});

test('buildJudgeInput omits reference_screenshot_path when not provided', () => {
  const input = buildJudgeInput({
    screenshotPath: '/abs/shot.jpg',
    url: 'https://example.com',
    researchQuestion: 'q',
    inclusionCriteria: 'x',
  });
  assert.ok(!('reference_screenshot_path' in input));
});

test('writeBrief persists reference_screenshot_path when parsed carries one', () => {
  const parsed = parse(V2_SAMPLE);
  parsed.referenceScreenshotPath = '/abs/reference/seed.png';
  const dir = tmpDir('v2-ref-shot');
  writeBrief(parsed, dir);
  const brief = JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8'));
  assert.strictEqual(brief.reference_screenshot_path, '/abs/reference/seed.png');
});

// ---------- v1 legacy ----------

const V1_SAMPLE = [
  '=== SCOUT DECISION MAP v1 ===',
  'project_id: sc_legacy',
  'schema: v1',
  'generated_at: 2026-04-01T00:00:00Z',
  '',
  '--- Q1: Research question ---',
  'choice: custom',
  'note: Legacy question',
  '',
  '--- Q2: Inclusion criteria ---',
  'choice: strict',
  'note: B2B only',
  '',
  '--- Q3: Exclusion criteria ---',
  'choice: list',
  'note: ',
  '',
  '--- Q4: Target entity count ---',
  'choice: 25-40',
  'note: ',
  '',
  '--- Q5: Dimensions of analysis ---',
  'choice: default',
  'note: ',
  '',
  '--- Q6: Visual evidence ---',
  'choice: desktop-atf',
  'note: ',
  '',
  '--- Q7: Mockups ---',
  'choice: none',
  'note: ',
  '',
  '--- Q8: Second-opinion model ---',
  'choice: sonnet',
  'note: ',
  '',
  '--- Approved candidates ---',
  '- id=foo | label=Foo | url=https://foo.com | category=x',
  '',
  '--- Custom candidates ---',
  '(none)',
  '=== END SCOUT DECISION MAP v1 ===',
].join('\n');

test('v1 legacy paste-back still parses with schemaVersion=v1 and default decisionType', () => {
  const parsed = parse(V1_SAMPLE);
  assert.strictEqual(parsed.schemaVersion, 'v1');
  assert.strictEqual(parsed.structured.decisionType, 'other');
  assert.strictEqual(parsed.structured.researchQuestion, 'Legacy question');
  assert.ok(parsed.structured.inclusionSelected.includes('B2B only'));
  assert.strictEqual(parsed.approvedCandidates.length, 1);
});

test('v1 legacy writeBrief emits v3-shape brief.json with minVerified default', () => {
  const parsed = parse(V1_SAMPLE);
  const dir = tmpDir('v1-legacy');
  writeBrief(parsed, dir);
  const brief = JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8'));
  assert.strictEqual(brief.minVerified, 15);
  assert.strictEqual(brief.decisionType, 'other');
  assert.ok(brief.dimensions.length >= 1);
});

// ---------- content hash ----------

test('contentHash stable for same bytes, different for different bytes', () => {
  const dir = tmpDir('hash');
  const a = path.join(dir, 'a.bin');
  const b = path.join(dir, 'b.bin');
  const c = path.join(dir, 'c.bin');
  fs.writeFileSync(a, Buffer.from([1, 2, 3, 4, 5]));
  fs.writeFileSync(b, Buffer.from([1, 2, 3, 4, 5]));
  fs.writeFileSync(c, Buffer.from([1, 2, 3, 4, 6]));
  const ha = contentHash(a);
  const hb = contentHash(b);
  const hc = contentHash(c);
  assert.ok(ha && ha.length === 64, 'hash is hex sha256');
  assert.strictEqual(ha, hb, 'same bytes -> same hash');
  assert.notStrictEqual(ha, hc, 'different bytes -> different hash');
  assert.strictEqual(contentHash('/does/not/exist'), null);
});

// ---------- build-mockup ----------

const VALID_CONCEPT = {
  title: 'Anchor yearly savings to tier title',
  hypothesis: 'We believe placing the yearly-savings badge adjacent to the tier name because 78% of tested pricing pages do this; if we ship this we expect higher Pro+ -> Ultra conversion.',
  feasibility: 'Low effort. CSS + one component change. Two-day shipping.',
  state_before: '<div style="padding:16px" data-annotation-number="1"><h3>Pro+</h3><p>$29/mo</p></div>',
  state_after: '<div style="padding:16px" data-annotation-number="1"><h3>Pro+ <span>Save 33%</span></h3><p>$29/mo</p></div>',
  annotations: [
    {
      number: 1,
      element_anchor: '[data-annotation-number="1"]',
      what: 'Attach the save-X% badge to the tier title row, not the price row.',
      source_entities: ['stripe', 'notion'],
      why_it_works: '7 of 9 pricing pages do this (78%).',
      why_it_fits_here: 'Users scan tier names first in the current Investing.com pricing layout.',
    },
  ],
};

test('validateConcept accepts a complete concept', () => {
  const v = validateConcept(VALID_CONCEPT);
  assert.strictEqual(v.ok, true, 'complete concept validates: ' + v.errors.join('; '));
});

test('validateConcept rejects missing state_after', () => {
  const bad = Object.assign({}, VALID_CONCEPT, { state_after: '' });
  const v = validateConcept(bad);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.join(' ').includes('state_after'));
});

test('validateConcept rejects annotation missing source_entities', () => {
  const bad = Object.assign({}, VALID_CONCEPT, {
    annotations: [Object.assign({}, VALID_CONCEPT.annotations[0], { source_entities: [] })],
  });
  const v = validateConcept(bad);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.join(' ').includes('source_entities'));
});

test('validateConcept rejects annotation missing why_it_fits_here', () => {
  const bad = Object.assign({}, VALID_CONCEPT, {
    annotations: [Object.assign({}, VALID_CONCEPT.annotations[0], { why_it_fits_here: '' })],
  });
  const v = validateConcept(bad);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.join(' ').includes('why_it_fits_here'));
});

test('renderMockup writes a standalone HTML with expected content', () => {
  const dir = tmpDir('mockup');
  const res = renderMockup(VALID_CONCEPT, { outputDir: dir, index: 1, backHref: '../research-report.html' });
  assert.ok(fs.existsSync(res.path));
  const html = fs.readFileSync(res.path, 'utf8');
  assert.ok(html.includes(VALID_CONCEPT.title));
  assert.ok(html.includes('Design Decisions'));
  assert.ok(html.includes('Before'));
  assert.ok(html.includes('After'));
  assert.ok(html.includes('panel-before'));
  assert.ok(html.includes('panel-after'));
  // Annotation content
  assert.ok(html.includes('Attach the save-X%'));
  assert.ok(html.includes('stripe'));
});

// ---------- seed-discovery rounds ----------

test('seed-discovery round param + alreadySeenDomains dedupe works', () => {
  const { seeds, stats } = discoverSeeds({
    webSearchResults: [
      { url: 'https://stripe.com/pricing' },
      { url: 'https://fresh.io/pricing' },
    ],
    alreadySeenDomains: ['stripe.com'],
    round: 2,
    maxSeeds: 20,
  });
  assert.strictEqual(seeds.length, 1, 'stripe excluded because already seen');
  assert.strictEqual(seeds[0].url, 'https://fresh.io/pricing');
  assert.strictEqual(stats.round, 2);
  assert.strictEqual(stats.alreadySeenCount, 1);
});

test('seed-discovery default round=1 and empty alreadySeenDomains is non-breaking', () => {
  const { seeds, stats } = discoverSeeds({
    webSearchResults: [{ url: 'https://stripe.com' }],
  });
  assert.strictEqual(seeds.length, 1);
  assert.strictEqual(stats.round, 1);
});

// ---------- finalize ----------

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll scout-v3 tests passed.');
