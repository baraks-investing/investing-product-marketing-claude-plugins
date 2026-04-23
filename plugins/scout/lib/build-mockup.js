#!/usr/bin/env node
/**
 * lib/build-mockup.js
 *
 * Renders one standalone mockup HTML from a concept object produced by the
 * mockup-designer subagent. The concept shape is validated — missing
 * before/after states or annotations with empty required fields raise an
 * error so the evaluator catches malformed outputs.
 *
 * Input:
 *   {
 *     title, hypothesis, feasibility,
 *     state_before, state_after,
 *     annotations: [{ number, element_anchor, what, source_entities, why_it_works, why_it_fits_here }]
 *   }
 *
 * Output: writes mockups/concept-{n}-{slug}.html relative to the target root.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { slugify } = require('./util');

const REQUIRED_ANNOTATION_FIELDS = ['what', 'why_it_works', 'why_it_fits_here'];

function validateConcept(concept) {
  const errors = [];
  if (!concept || typeof concept !== 'object') {
    return { ok: false, errors: ['concept is not an object'] };
  }
  if (!concept.title) errors.push('missing title');
  if (!concept.state_before || !String(concept.state_before).trim()) errors.push('missing state_before');
  if (!concept.state_after || !String(concept.state_after).trim()) errors.push('missing state_after');
  const anns = Array.isArray(concept.annotations) ? concept.annotations : [];
  anns.forEach((a, i) => {
    REQUIRED_ANNOTATION_FIELDS.forEach((f) => {
      if (!a || !a[f] || !String(a[f]).trim()) errors.push(`annotation[${i}] missing ${f}`);
    });
    if (!Array.isArray(a.source_entities) || !a.source_entities.length) {
      errors.push(`annotation[${i}] missing source_entities`);
    }
    if (typeof a.number !== 'number') errors.push(`annotation[${i}] missing numeric number`);
  });
  return { ok: errors.length === 0, errors };
}

function renderMockup(concept, opts = {}) {
  const {
    outputDir = path.resolve(process.cwd(), 'mockups'),
    index = 1,
    backHref = '../research-report.html',
    strict = true,
  } = opts;

  const validation = validateConcept(concept);
  if (!validation.ok && strict) {
    throw new Error('renderMockup: invalid concept — ' + validation.errors.join('; '));
  }

  const templatePath = path.resolve(__dirname, '..', 'templates', 'mockup-concept.html.ejs');
  const tpl = fs.readFileSync(templatePath, 'utf8');

  const slug = slugify(concept.title || `concept-${index}`, 40) || `concept-${index}`;
  const fileName = `concept-${index}-${slug}.html`;
  const outPath = path.resolve(outputDir, fileName);

  fs.mkdirSync(outputDir, { recursive: true });

  const html = ejs.render(tpl, {
    concept: {
      title: concept.title || `Concept ${index}`,
      hypothesis: concept.hypothesis || '',
      feasibility: concept.feasibility || '',
      state_before: concept.state_before || '',
      state_after: concept.state_after || '',
      annotations: (concept.annotations || []).map((a) => ({
        number: a.number,
        element_anchor: a.element_anchor || null,
        what: a.what || '',
        source_entities: Array.isArray(a.source_entities) ? a.source_entities : [],
        why_it_works: a.why_it_works || '',
        why_it_fits_here: a.why_it_fits_here || '',
      })),
    },
    backHref,
    generatedAt: new Date().toISOString(),
  }, { filename: templatePath });

  fs.writeFileSync(outPath, html, 'utf8');

  return {
    path: outPath,
    fileName,
    bytes: fs.statSync(outPath).size,
    valid: validation.ok,
    errors: validation.errors,
  };
}

function runCli() {
  const args = process.argv.slice(2);
  function getArg(n) { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; }
  const inputPath = getArg('--input');
  const outDir = getArg('--out-dir');
  const backHref = getArg('--back-href');
  const index = Number.parseInt(getArg('--index') || '1', 10);
  if (!inputPath) {
    console.log('Usage: node build-mockup.js --input concept.json [--out-dir mockups] [--back-href ../research-report.html] [--index 1]');
    process.exit(1);
  }
  const concept = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const result = renderMockup(concept, {
    outputDir: outDir ? path.resolve(outDir) : undefined,
    backHref: backHref || undefined,
    index,
  });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { renderMockup, validateConcept };

if (require.main === module) {
  try { runCli(); } catch (e) { console.error(e.message || e); process.exit(1); }
}
