#!/usr/bin/env node
/**
 * lib/__tests__/parse-paste-back.test.js
 *
 * No test framework — plain Node assertions. Exits non-zero on failure.
 *
 * Run: node lib/__tests__/parse-paste-back.test.js
 */

const assert = require('assert');
const path = require('path');
const { parse } = require('../parse-paste-back');

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

const CANONICAL = [
  '=== SCOUT DECISION MAP v1 ===',
  'project_id: sc_test123',
  'schema: v1',
  'generated_at: 2026-04-21T00:00:00Z',
  '',
  '--- Q1: Research question ---',
  'choice: custom',
  'note: How do SaaS pricing pages frame value?',
  '',
  '--- Q2: Inclusion criteria ---',
  'choice: strict',
  'note: English only',
  '  B2B SaaS',
  '  Public pricing page',
  '',
  '--- Q3: Exclusion criteria ---',
  'choice: default',
  'note: ',
  '',
  '--- Q4: Target entity count ---',
  'choice: 10-15',
  'note: ',
  '',
  '--- Q5: Dimensions of analysis ---',
  'choice: default',
  'note: ',
  '',
  '--- Q6: Visual evidence ---',
  'choice: thumbnail',
  'note: ',
  '',
  '--- Q7: Mockups ---',
  'choice: 0',
  'note: ',
  '',
  '--- Q8: Second-opinion model ---',
  'choice: gpt-4',
  'note: ',
  '',
  '--- Approved candidates ---',
  '- id=notion | label=Notion | url=https://notion.so/pricing | category=productivity',
  '- id=stripe | label=Stripe | url=https://stripe.com/pricing | category=devtools',
  '',
  '--- Custom candidates ---',
  '(none)',
  '=== END SCOUT DECISION MAP v1 ===',
].join('\n');

// Slack/Teams-style paste: indentation normalized to a single tab or mixed spaces.
const SLACK_NORMALIZED = CANONICAL
  .replace('  B2B SaaS', '\tB2B SaaS')
  .replace('  Public pricing page', '   Public pricing page');

// Legacy output with the old '(empty)' sentinel instead of blank notes.
const LEGACY_EMPTY = CANONICAL.replace(/^note: $/gm, 'note: (empty)');

test('canonical paste parses and multi-line Q2 note preserves newlines', () => {
  const parsed = parse(CANONICAL);
  assert.strictEqual(parsed.projectId, 'sc_test123');
  assert.strictEqual(parsed.schemaVersion, 'v1');
  assert.strictEqual(
    parsed.answers.research_question.note,
    'How do SaaS pricing pages frame value?'
  );
  const q2 = parsed.answers.inclusion_criteria.note;
  assert.ok(q2.includes('English only'), 'Q2 keeps first line');
  assert.ok(q2.includes('B2B SaaS'), 'Q2 keeps second line');
  assert.ok(q2.includes('Public pricing page'), 'Q2 keeps third line');
  assert.ok(q2.includes('\n'), 'Q2 preserves newline between indented lines');
  assert.strictEqual(parsed.approvedCandidates.length, 2);
  assert.strictEqual(parsed.customCandidates.length, 0);
});

test('Slack-normalized paste (tab + variable-space indent) still parses multi-line notes', () => {
  const parsed = parse(SLACK_NORMALIZED);
  const q2 = parsed.answers.inclusion_criteria.note;
  assert.ok(q2.includes('English only'));
  assert.ok(q2.includes('B2B SaaS'), 'tab-indented line survives un-indent');
  assert.ok(q2.includes('Public pricing page'), '3-space indent survives un-indent');
  assert.ok(q2.includes('\n'), 'newlines preserved across Slack-normalized indentation');
});

test('legacy (empty) sentinel collapses to empty string', () => {
  const parsed = parse(LEGACY_EMPTY);
  assert.strictEqual(parsed.answers.exclusion_criteria.note, '');
  assert.strictEqual(parsed.answers.dimensions.note, '');
  assert.strictEqual(parsed.answers.target_count.note, '');
});

test('blank-note canonical parse yields empty strings, not "(empty)"', () => {
  const parsed = parse(CANONICAL);
  assert.strictEqual(parsed.answers.dimensions.note, '');
  assert.strictEqual(parsed.answers.exclusion_criteria.note, '');
});

test('writeBrief falls through to default dimensions when Q5 note blank or sentinel', () => {
  const { writeBrief } = require('../parse-paste-back');
  const fs = require('fs');
  const os = require('os');

  for (const [label, src] of [['blank', CANONICAL], ['legacy-empty', LEGACY_EMPTY]]) {
    const parsed = parse(src);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `scout-test-${label}-`));
    writeBrief(parsed, tmp);
    const briefJson = JSON.parse(fs.readFileSync(path.join(tmp, 'brief.json'), 'utf8'));
    assert.ok(Array.isArray(briefJson.dimensions), `${label}: dimensions is array`);
    assert.ok(briefJson.dimensions.length >= 2, `${label}: default dimensions present`);
    assert.ok(
      !briefJson.dimensions.includes('(empty)'),
      `${label}: dimensions must not contain "(empty)" literal`
    );
    assert.notStrictEqual(
      briefJson.dimensions.length, 1,
      `${label}: must not be the bogus one-item ["(empty)"] array`
    );
    assert.ok(
      briefJson.dimensions.includes('positioning_headline'),
      `${label}: default dimension "positioning_headline" present`
    );
    const briefMd = fs.readFileSync(path.join(tmp, 'brief.md'), 'utf8');
    assert.ok(!briefMd.includes('(empty)'), `${label}: brief.md must not render "(empty)"`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll tests passed.');
