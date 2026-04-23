#!/usr/bin/env node
/**
 * lib/build-battlecard.js — scout v4
 *
 * Renders one standalone battlecard HTML from a concept produced by the
 * scout-battlecard-builder subagent.
 *
 * Concept shape (strict):
 *   {
 *     one_line:       string,
 *     strengths:      string[3],
 *     weaknesses:     string[3],
 *     how_to_beat:    string[3],
 *     when_they_win:  string,
 *     when_we_win:    string
 *   }
 *
 * Output: writes battlecards/<category>/<id>.html relative to the target
 * out-dir and returns {filePath, bytes}.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { slugify } = require('./util');

const REQUIRED_ARRAYS = ['strengths', 'weaknesses', 'how_to_beat'];
const REQUIRED_STRINGS = ['one_line', 'when_they_win', 'when_we_win'];

function validateBattlecard(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('battlecard: input is not an object');
  }
  REQUIRED_STRINGS.forEach((k) => {
    if (typeof data[k] !== 'string' || !data[k].trim()) {
      throw new Error(`battlecard: missing or empty required string field "${k}"`);
    }
  });
  REQUIRED_ARRAYS.forEach((k) => {
    if (!Array.isArray(data[k])) {
      throw new Error(`battlecard: field "${k}" must be an array`);
    }
    if (data[k].length !== 3) {
      throw new Error(`battlecard: field "${k}" must have exactly 3 items, got ${data[k].length}`);
    }
    data[k].forEach((v, i) => {
      if (typeof v !== 'string' || !v.trim()) {
        throw new Error(`battlecard: "${k}"[${i}] must be a non-empty string`);
      }
    });
  });
  return true;
}

function fileToDataUri(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Render one battlecard to disk.
 *
 * @param {Object} opts
 * @param {Object} opts.concept  — strict battlecard concept (see shape above)
 * @param {Object} opts.entity   — {id, label, url, category}
 * @param {string} [opts.backHref] — href back to the research report
 * @param {string} [opts.outDir] — root output dir (default ./battlecards)
 * @param {string} [opts.reportDir] — (unused reserved) context where report lives
 * @param {string} [opts.screenshot] — optional absolute path to a screenshot
 * @param {string} [opts.capturedAt] — capture timestamp (display string)
 * @param {string} [opts.contentHash] — short content hash for the footer
 * @returns {{ filePath: string, bytes: number }}
 */
function renderBattlecard({
  concept,
  entity,
  backHref = '../../research-report.html',
  outDir = path.resolve(process.cwd(), 'battlecards'),
  reportDir,
  screenshot = null,
  capturedAt = null,
  contentHash = null,
}) {
  validateBattlecard(concept);
  if (!entity || !entity.id) {
    throw new Error('battlecard: entity.id is required');
  }

  const category = slugify(entity.category || 'uncategorized', 40) || 'uncategorized';
  const id = slugify(entity.id, 60) || entity.id;
  const subDir = path.resolve(outDir, category);
  fs.mkdirSync(subDir, { recursive: true });
  const filePath = path.join(subDir, id + '.html');

  const templatePath = path.resolve(__dirname, '..', 'templates', 'battlecard.html.ejs');
  const tpl = fs.readFileSync(templatePath, 'utf8');

  const screenshotDataUri = screenshot && !screenshot.startsWith('data:')
    ? fileToDataUri(screenshot)
    : screenshot;

  const html = ejs.render(tpl, {
    concept,
    entity: {
      id: entity.id,
      label: entity.label || entity.id,
      url: entity.url || '',
      category: entity.category || 'uncategorized',
    },
    backHref,
    screenshot: screenshotDataUri,
    capturedAt,
    contentHash: contentHash ? String(contentHash).slice(0, 8) : null,
  }, { filename: templatePath });

  fs.writeFileSync(filePath, html, 'utf8');
  return { filePath, bytes: fs.statSync(filePath).size };
}

function runCli() {
  const args = process.argv.slice(2);
  function getArg(n) { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; }
  const inputPath = getArg('--input');
  const entityId = getArg('--entity-id');
  const outDir = getArg('--out-dir') || path.resolve(process.cwd(), 'battlecards');
  const backHref = getArg('--back-href') || undefined;
  if (!inputPath || !entityId) {
    console.log('Usage: node build-battlecard.js --input concept.json --entity-id ID [--out-dir battlecards] [--back-href ../../research-report.html]');
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  // input may be { concept, entity } or a raw concept — tolerate both.
  const concept = input.concept || input;
  const entity = input.entity || { id: entityId, label: entityId, url: '', category: 'uncategorized' };
  const result = renderBattlecard({
    concept,
    entity,
    backHref,
    outDir: path.resolve(outDir),
  });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { renderBattlecard, validateBattlecard };

if (require.main === module) {
  try { runCli(); } catch (e) { console.error(e.message || e); process.exit(1); }
}
