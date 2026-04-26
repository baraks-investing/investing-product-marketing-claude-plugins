#!/usr/bin/env node
/**
 * lib/build-report.js
 *
 * Renders the self-contained research-report.html from:
 *   - brief.json                            (research question, dimensions, entity list)
 *   - analysis/entity-data.json             (per-entity analysis keyed by entity id)
 *   - analysis/patterns.json                (quantified cross-entity patterns + recommendations + observations)
 *   - analysis/capture-metadata.json        (which entities failed capture)
 *   - .agents/scout/.layer3-verdicts.json   (v2 — verdict bucket + rationale + source per entity)
 *   - analysis/failed-candidates.json       (v2 — candidates dropped by vision)
 *   - (optional) mockups array passed in config.mockups
 *
 * Embeds all JPEGs as base64 to keep the file self-contained.
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

// sharp is used to crop full-page screenshots to the vision-judge-reported
// bbox before embedding in the report. Imported lazily so the module doesn't
// fail to load on environments without sharp (report still renders with
// uncropped images as a fallback).
let _sharp = null;
function getSharp() {
  if (_sharp !== null) return _sharp;
  try { _sharp = require('sharp'); } catch (_) { _sharp = false; }
  return _sharp;
}

function safeReadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return fallback; }
}

// Idempotent normalizer that maps the aggregator's drift-shape patterns.json
// into the template-expected shape. Accepts hybrid inputs (some items already
// in template shape, others in drift shape). Template-shape inputs round-trip
// unchanged (shallow-equal key set). Kept internal — only wired through the
// patternsDoc read in buildReport.
function normalizePatterns(doc) {
  if (!doc || typeof doc !== 'object') {
    return { execStats: [], bestPractices: [], patterns: [], recommendations: [], observations: [] };
  }

  function prettify(str) {
    if (str == null) return '';
    return String(str)
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  const execStatsIn = Array.isArray(doc.execStats) ? doc.execStats : [];
  const execStats = execStatsIn.map((it) => {
    if (!it || typeof it !== 'object') return it;
    if ('main' in it || 'sub' in it) return it; // already template shape
    // Canonical template keys are {label, main, sub}. Translate common variants:
    //   label ← label | name
    //   main  ← main | (value + optional percent) | percent
    //   sub   ← sub | detail | description | note
    const label = it.label != null ? it.label : (it.name != null ? it.name : undefined);
    let main = it.main;
    if (main == null) {
      // `value` may be the empty string on a drifted input — treat "" as absent
      // so we don't emit a dangling " · 53%" with a leading separator.
      const hasValue = it.value != null && String(it.value).trim() !== '';
      const hasPercent = it.percent != null;
      if (hasValue && hasPercent) main = `${it.value} · ${it.percent}%`;
      else if (hasValue) main = String(it.value);
      else if (hasPercent) main = `${it.percent}%`;
    }
    const sub = it.sub != null ? it.sub
      : (it.detail != null ? it.detail
      : (it.description != null ? it.description
      : (it.note != null ? it.note : undefined)));
    return { ...it, label, main, sub };
  });

  const bestPracticesIn = Array.isArray(doc.bestPractices) ? doc.bestPractices : [];
  const bestPractices = bestPracticesIn.map((it) => {
    if (!it || typeof it !== 'object') return it;
    // Canonical template keys are {rule, detail}. Translate common variants:
    //   rule   ← rule | title | practice
    //   detail ← detail | description | rationale
    let rule = it.rule;
    if (rule == null && it.title != null) rule = it.title;
    if (rule == null && it.practice != null) rule = it.practice;
    let detail = it.detail;
    if (detail == null && it.description != null) detail = it.description;
    if (detail == null && it.rationale != null) detail = it.rationale;
    if (Array.isArray(it.evidence_entities) && it.evidence_entities.length) {
      const joined = it.evidence_entities.join(', ');
      const body = typeof detail === 'string' ? detail : '';
      if (!body.includes('Evidence:')) {
        detail = (body ? body.replace(/\s*$/, '') + ' ' : '') + `Evidence: ${joined}.`;
      }
    }
    return { ...it, rule, detail };
  });

  const patternsIn = Array.isArray(doc.patterns) ? doc.patterns : [];
  const patterns = [];
  patternsIn.forEach((it) => {
    if (!it || typeof it !== 'object') { patterns.push(it); return; }
    // Common variant: evidence_count is a string like "16 / 30" — parse into
    // numeric percent/count/denominator so the template's bar renders.
    if (it.evidence_count && typeof it.evidence_count === 'string'
        && it.percent == null && it.count == null) {
      const m = it.evidence_count.match(/(\d+)\s*\/\s*(\d+)/);
      if (m) {
        const count = parseInt(m[1], 10);
        const denom = parseInt(m[2], 10);
        // Clamp to [0, 100] so malformed inputs like "30 / 24" don't blow past 100%.
        const rawPct = denom > 0 ? Math.round((count / denom) * 100) : 0;
        const percent = Math.max(0, Math.min(100, rawPct));
        it = { ...it, count, denominator: denom, percent };
      }
    }
    // Common variant: generator returned `entities` but template reads `examples`.
    if (!Array.isArray(it.examples) && Array.isArray(it.entities)) {
      it = { ...it, examples: it.entities };
    }
    // Template shape — pass through.
    if ('title' in it && ('percent' in it || 'count' in it || 'denominator' in it || 'examples' in it || 'description' in it)) {
      patterns.push(it);
      return;
    }
    // Drift shape — dimension with value_frequency.
    if ('dimension' in it && it.value_frequency && typeof it.value_frequency === 'object') {
      const vf = it.value_frequency;
      const nTotal = Number.isFinite(it.n_total)
        ? it.n_total
        : Object.values(vf).reduce((s, v) => s + (Number(v) || 0), 0);
      let dom = it.dominant_value;
      if (dom == null) {
        // Pick highest-frequency key as dominant fallback.
        let bestK = null, bestV = -Infinity;
        Object.keys(vf).forEach((k) => { const v = Number(vf[k]) || 0; if (v > bestV) { bestV = v; bestK = k; } });
        dom = bestK;
      }
      const count = Number(vf[dom]) || 0;
      const percent = nTotal > 0 ? Math.round((count / nTotal) * 100) : 0;
      patterns.push({
        title: `${prettify(dom)} (${it.dimension})`,
        percent,
        count,
        denominator: nTotal,
        description: it.interpretation || '',
        examples: [],
      });
      return;
    }
    patterns.push(it);
  });

  const recommendationsIn = Array.isArray(doc.recommendations) ? doc.recommendations : [];
  const recommendations = recommendationsIn.map((it) => {
    if (!it || typeof it !== 'object') return it;
    // Canonical template key is `body`. Accept `rationale` as alias; default to
    // empty string so the template never renders literal "undefined".
    if ('body' in it && it.body != null) return it;
    if (it.rationale != null) return { ...it, body: it.rationale };
    return { ...it, body: '' };
  });

  const observations = Array.isArray(doc.observations)
    ? doc.observations
    : (Array.isArray(doc.top_level_observations) ? doc.top_level_observations : []);

  // Preserve any extra keys (jobs, feature_classification, price_clusters, etc.).
  return { ...doc, execStats, bestPractices, patterns, recommendations, observations };
}

function fileToDataUri(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * buildShareText — assemble a plain-text summary suitable for pasting into
 * Slack or email. Includes a 4-line headline block, top 3-5 bullet findings,
 * a one-line list of researched companies (capped at 30 in source order with
 * "…" overflow marker), and a closing attachment hint.
 *
 * Returns the assembled string. Caller embeds it via JSON.stringify so the
 * template's hidden script tag carries it untouched.
 */
function buildShareText(opts) {
  const {
    title,
    researchQuestion,
    totalEntities,
    patternsCount,
    bestPracticesCount,
    topFindings = [],
    companyNames = [],
    attachmentNote = 'Full report (HTML) and gallery preview attached.',
    companyCap = 30,
  } = opts || {};

  const lines = [];
  lines.push(researchQuestion || title || 'Scout research report');
  lines.push('');
  const stats = [];
  if (totalEntities != null) stats.push(`${totalEntities} entities analyzed`);
  if (patternsCount != null) stats.push(`${patternsCount} patterns`);
  if (bestPracticesCount != null) stats.push(`${bestPracticesCount} best practices`);
  if (stats.length) lines.push(stats.join(' · '));

  if (Array.isArray(topFindings) && topFindings.length) {
    lines.push('');
    lines.push('Key findings:');
    topFindings.slice(0, 5).forEach((f) => {
      const text = typeof f === 'string' ? f : (f && (f.title || f.label || f.description) ? (f.title || f.label || f.description) : '');
      if (text) lines.push('• ' + text);
    });
  }

  if (Array.isArray(companyNames) && companyNames.length) {
    lines.push('');
    const truncated = companyNames.length > companyCap;
    const list = companyNames.slice(0, companyCap).join(', ');
    lines.push('Researched: ' + list + (truncated ? ', …' : '.'));
  }

  if (attachmentNote) {
    lines.push('');
    lines.push(attachmentNote);
  }

  return lines.join('\n');
}

// Crop a full-page screenshot to the y-range the vision judge reported and
// return a data URI of the cropped JPEG. If sharp isn't available, or the
// crop coords are missing/invalid, returns null — the caller falls back to
// the uncropped image.
async function cropToPattern(fullPath, yStart, yHeight) {
  if (!fullPath || !fs.existsSync(fullPath)) return null;
  if (!Number.isFinite(yStart) || !Number.isFinite(yHeight)) return null;
  if (yHeight <= 0) return null;
  const sharp = getSharp();
  if (!sharp) return null;
  try {
    const img = sharp(fullPath);
    const meta = await img.metadata();
    const imgH = meta.height || 0;
    const imgW = meta.width || 0;
    if (!imgH || !imgW) return null;
    // Clamp crop region to image bounds.
    const top = Math.max(0, Math.min(imgH - 1, Math.floor(yStart)));
    const height = Math.max(1, Math.min(imgH - top, Math.floor(yHeight)));
    const buf = await sharp(fullPath).extract({ left: 0, top, width: imgW, height }).jpeg({ quality: 82 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (_) {
    return null;
  }
}

async function buildReport(config) {
  const {
    briefPath,
    entityDataPath,
    patternsPath,
    captureMetadataPath,
    verdictsPath,
    failedCandidatesPath,
    outputPath,
    mockups = [],
    battlecards = [],
    reportTitle,
  } = config;

  const brief = safeReadJson(briefPath, null);
  if (!brief) throw new Error('brief.json not readable at ' + briefPath);
  const entityData = safeReadJson(entityDataPath, {});
  const patternsDoc = normalizePatterns(safeReadJson(patternsPath, { patterns: [], recommendations: [], observations: [] }));
  const capMeta = safeReadJson(captureMetadataPath, { results: [] });
  const verdictsList = verdictsPath ? safeReadJson(verdictsPath, []) : [];
  const failedList = failedCandidatesPath ? safeReadJson(failedCandidatesPath, []) : [];

  // Index helpers
  const captureById = {};
  (capMeta.results || []).forEach((r) => { captureById[r.id] = r; });
  const verdictById = {};
  (verdictsList || []).forEach((v) => { if (v && v.id) verdictById[v.id] = v; });

  const categories = new Set();
  const entityPromises = (brief.entities || []).map(async (e) => {
    const cap = captureById[e.id] || {};
    const verdict = verdictById[e.id] || {};
    const screenshotFile = verdict.screenshotPath || (cap.status === 'success' ? cap.file : null);
    // v3: prefer cropped image (vision-judge pattern bbox) for the detail
    // section; fall back to the full screenshot when coords are missing.
    let screenshot = null;
    let croppedScreenshot = null;
    if (screenshotFile) {
      croppedScreenshot = await cropToPattern(
        screenshotFile,
        verdict.pattern_y_start != null ? verdict.pattern_y_start : null,
        verdict.pattern_y_height != null ? verdict.pattern_y_height : null
      );
      screenshot = croppedScreenshot || fileToDataUri(screenshotFile);
    }
    const analysis = entityData[e.id] || entityData[e.label] || {};
    const category = e.category || 'uncategorized';
    categories.add(category);
    // Evidence binding (v3): thread captured_at + content_hash through the
    // template with graceful defaults for legacy metadata files.
    const capturedAtRaw = cap.captured_at || cap.timestamp || null;
    const contentHashRaw = cap.content_hash || null;
    let capturedAtDisplay = '(capture date unknown)';
    let capturedAtShort = '';
    if (capturedAtRaw) {
      try {
        const d = new Date(capturedAtRaw);
        if (!isNaN(d.getTime())) {
          capturedAtDisplay = d.toISOString().replace('T', ' ').replace(/:\d{2}\.\d+Z$/, ' UTC');
          capturedAtShort = d.toISOString().slice(0, 10);
        }
      } catch (_) { /* keep defaults */ }
    }
    const contentHashShort = contentHashRaw ? contentHashRaw.slice(0, 8) : '';
    return {
      id: e.id,
      label: e.label,
      url: e.url,
      category,
      captureStatus: cap.status || (screenshot ? 'success' : 'unknown'),
      captureError: cap.error || null,
      screenshot,
      analysis,
      verdict: verdict.verdict || null,
      rationale: verdict.rationale || null,
      source: verdict.source || e.source || null,
      source_trust: verdict.source_trust || e.source_trust || 'low',
      options_count: verdict.options_count != null ? verdict.options_count : null,
      picker_placement: verdict.picker_placement || null,
      captured_at: capturedAtRaw,
      captured_at_display: capturedAtDisplay,
      captured_at_short: capturedAtShort || '(unknown)',
      content_hash: contentHashRaw,
      content_hash_short: contentHashShort,
      pattern_y_start: verdict.pattern_y_start != null ? verdict.pattern_y_start : null,
      pattern_y_height: verdict.pattern_y_height != null ? verdict.pattern_y_height : null,
      is_cropped: Boolean(croppedScreenshot),
    };
  });
  const entities = await Promise.all(entityPromises);

  const dimensions = Array.isArray(brief.dimensions) ? brief.dimensions : [];

  // Stats derivable from verdicts
  const yesCount = entities.filter((e) => e.verdict === 'yes').length;
  const partialCount = entities.filter((e) => e.verdict === 'partial').length;

  // Category counts for exec-summary chart
  const categoryCounts = Array.from(categories).map((c) => ({
    category: c,
    count: entities.filter((e) => e.category === c).length,
  })).sort((a, b) => b.count - a.count);

  const templatePath = path.resolve(__dirname, '..', 'templates', 'research-report.html.ejs');
  const tpl = fs.readFileSync(templatePath, 'utf8');

  // Mockups: resolve inline if not already passed.
  // /scout:execute writes brief.mockups as { count, items: [...] } but older
  // runs (and direct CLI callers) may pass a bare array. Accept both shapes.
  function extractMockupItems(m) {
    if (Array.isArray(m)) return m;
    if (m && typeof m === 'object' && Array.isArray(m.items)) return m.items;
    return [];
  }
  const resolvedMockups = Array.isArray(mockups) && mockups.length ? mockups
    : extractMockupItems(brief.mockups);

  // Battlecards: resolve inline if not already passed. Caller (execute skill)
  // typically threads a {id,label,category,filePath} array; falls back to
  // whatever the brief persisted. Enrich each card with {label, category,
  // screenshot (cropped), one_line} by looking up the matching entity + the
  // battlecard concept JSON — the grid template needs these for readable cards.
  const rawBattlecards = Array.isArray(battlecards) && battlecards.length ? battlecards
    : (Array.isArray(brief.battlecards) ? brief.battlecards : []);
  const entityById = {};
  entities.forEach((e) => { entityById[e.id] = e; });
  const resolvedBattlecards = rawBattlecards.map((bc) => {
    const entityId = bc.entity_id || bc.id;
    const ent = entityId ? entityById[entityId] : null;
    // v4 repair (Codex must-fix): validate that the battlecard file actually
    // exists on disk before we render a link to it. Dead links are worse than
    // a quietly-missing card.
    const bcPath = bc.filePath || bc.href;
    const bcAbsolute = bcPath ? path.resolve(path.dirname(outputPath || path.resolve(process.cwd(), 'research-report.html')), bcPath) : null;
    const bcExists = bcAbsolute ? fs.existsSync(bcAbsolute) : false;
    if (bcPath && !bcExists) {
      console.warn('[build-report] Battlecard file missing, skipping card:', bcPath);
      return null;
    }
    // Try to load one_line from the matching battlecard concept JSON so the
    // grid card can display the competitor's one-line description.
    let oneLine = bc.one_line || null;
    if (!oneLine) {
      // Look in typical locations — the execute skill writes concepts to
      // .agents/scout/battlecards-input/<id>.json or mockups/<id>.json depending
      // on the flow version.
      const candidatePaths = [
        path.resolve(process.cwd(), '.agents/scout/battlecards-input', (entityId || '') + '.json'),
        path.resolve(process.cwd(), '.agents/scout/battlecards', (entityId || '') + '.json'),
      ];
      for (const p of candidatePaths) {
        if (p && fs.existsSync(p)) {
          try {
            const concept = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (concept && concept.one_line) { oneLine = concept.one_line; break; }
          } catch (_) { /* ignore */ }
        }
      }
    }
    return {
      ...bc,
      entity_id: entityId,
      label: bc.label || (ent && ent.label) || entityId || 'Battlecard',
      category: bc.category || (ent && ent.category) || null,
      one_line: oneLine,
      screenshot: bc.screenshot || (ent && ent.screenshot) || null,
    };
  }).filter(Boolean);

  // Same validation for mockups — drop entries whose filePath is missing.
  const _mockupBaseDir = path.dirname(outputPath || path.resolve(process.cwd(), 'research-report.html'));
  const resolvedMockupsFiltered = resolvedMockups.filter((m) => {
    const p = m && (m.filePath || m.href);
    if (!p) return true; // inline-only mockups (no file path) render as before
    const abs = path.resolve(_mockupBaseDir, p);
    const ok = fs.existsSync(abs);
    if (!ok) console.warn('[build-report] Mockup file missing, skipping card:', p);
    return ok;
  });

  // v4: backward-compat defaults — v3 briefs don't carry these fields.
  if (typeof brief.framework_lens !== 'string') brief.framework_lens = 'descriptive';
  if (typeof brief.battlecard_enabled !== 'boolean') brief.battlecard_enabled = false;

  // v4 title derivation: if no explicit title passed, derive a concise H1
  // from the research question. The full researchQuestion still shows as
  // the subtitle (and is suppressed in the template if identical to H1).
  function deriveShortTitle(rq) {
    if (!rq) return 'Scout research report';
    const cleaned = String(rq).trim().replace(/\s+/g, ' ');
    // First sentence up to first period (not followed by a digit) or first 70 chars.
    const firstSentence = cleaned.split(/\.\s+(?=[A-Z])/)[0] || cleaned;
    if (firstSentence.length <= 90) return firstSentence.replace(/\.$/, '');
    // Truncate at word boundary under 80 chars.
    const truncated = firstSentence.slice(0, 80);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated).replace(/[.,;:\s]+$/, '') + '…';
  }
  const resolvedTitle = reportTitle || deriveShortTitle(brief.researchQuestion);

  // ---- Share payload (T02/T04) ----
  // Build the gallery composite BEFORE rendering so the template can reference
  // the relative filename. Wrap in try/catch so any composer failure (sharp
  // version mismatch, missing screenshots, disk error) degrades gracefully:
  // share.galleryImagePath stays null and the template hides the Download row.
  const out = outputPath || path.resolve(process.cwd(), 'research-report.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const TRUST_RANK = { high: 3, medium: 2, low: 1 };
  // Pick top 9 entities for the gallery: prefer verdict yes, sort by
  // source_trust desc, then by id asc, deterministic given identical input.
  const galleryTiles = entities
    .filter((e) => e.screenshot && (e.verdict === 'yes' || e.verdict === 'partial' || !e.verdict))
    .sort((a, b) => {
      const at = TRUST_RANK[a.source_trust] || TRUST_RANK.low;
      const bt = TRUST_RANK[b.source_trust] || TRUST_RANK.low;
      if (bt !== at) return bt - at;
      return String(a.id).localeCompare(String(b.id));
    })
    .slice(0, 9)
    .map((e) => {
      // Use the on-disk screenshot file (not the data URI) — composer needs a path.
      const cap = (capMeta.results || []).find((r) => r.id === e.id);
      const filePath = cap && cap.status === 'success' ? cap.file : null;
      const verdict = (verdictsList || []).find((v) => v && v.id === e.id) || {};
      const cropTop = Number.isFinite(verdict.pattern_y_start)
        ? Math.max(0, Math.floor(verdict.pattern_y_start) - 60)
        : null;
      const cropHeight = Number.isFinite(verdict.pattern_y_height)
        ? Math.min(800, Math.floor(verdict.pattern_y_height))
        : null;
      return { path: filePath, cropTop, cropHeight };
    })
    .filter((t) => t.path);

  let galleryRelPath = null;
  if (galleryTiles.length > 0) {
    const baseNoExt = path.basename(out, path.extname(out));
    const galleryAbsPath = path.join(path.dirname(out), baseNoExt + '-gallery.jpg');
    try {
      const { composeGallery } = require('./gallery-composer');
      const result = await composeGallery({ tiles: galleryTiles, outputPath: galleryAbsPath });
      galleryRelPath = path.basename(galleryAbsPath);
      if (result.skipped && result.skipped.length) {
        console.warn(`gallery-composer: ${result.usedPaths.length} used, ${result.skipped.length} skipped`);
      }
    } catch (err) {
      console.warn('gallery-composer failed; share button will hide the gallery row:', err && err.message ? err.message : err);
      galleryRelPath = null;
    }
  }

  // Top findings = first 5 best-practice rules (tight, action-oriented) or
  // fall back to the first 5 pattern titles. Plain strings for the share text.
  const _bp = patternsDoc.bestPractices || [];
  const _patternsTitles = (patternsDoc.patterns || []).map((p) => p.title).filter(Boolean);
  const topFindings = (_bp.length ? _bp.map((b) => b.rule).filter(Boolean) : _patternsTitles).slice(0, 5);

  const companyNames = (brief.entities || []).map((e) => e.label || e.id).filter(Boolean);
  const shareSummary = buildShareText({
    title: resolvedTitle,
    researchQuestion: brief.researchQuestion,
    totalEntities: entities.length,
    patternsCount: (patternsDoc.patterns || []).length,
    bestPracticesCount: (patternsDoc.bestPractices || []).length,
    topFindings,
    companyNames,
    attachmentNote: galleryRelPath
      ? 'Full report (HTML) and gallery preview attached.'
      : 'Full report (HTML) attached.',
  });
  const share = {
    title: resolvedTitle,
    summary: shareSummary,
    galleryImagePath: galleryRelPath,
  };
  // ---- End share payload ----

  const html = ejs.render(tpl, {
    share,
    reportTitle: resolvedTitle,
    brief,
    entities,
    patterns: patternsDoc.patterns || patternsDoc || [],
    recommendations: patternsDoc.recommendations || brief.recommendations || [],
    observations: patternsDoc.observations || patternsDoc.top_level_observations || [],
    execStats: patternsDoc.execStats || [],
    bestPractices: patternsDoc.bestPractices || [],
    dimensions,
    categories: Array.from(categories).sort(),
    categoryCounts,
    mockups: resolvedMockupsFiltered,
    battlecards: resolvedBattlecards,
    // Lens-specific blocks — forwarded from patterns.json when the aggregator
    // emitted them. Empty arrays render nothing.
    jobs: Array.isArray(patternsDoc.jobs) ? patternsDoc.jobs : [],
    featureClassification: Array.isArray(patternsDoc.feature_classification)
      ? patternsDoc.feature_classification
      : (Array.isArray(patternsDoc.featureClassification) ? patternsDoc.featureClassification : []),
    priceClusters: Array.isArray(patternsDoc.price_clusters)
      ? patternsDoc.price_clusters
      : (Array.isArray(patternsDoc.priceClusters) ? patternsDoc.priceClusters : []),
    failedCandidates: Array.isArray(failedList) ? failedList : [],
    stats: { yesCount, partialCount },
    generatedAt: new Date().toISOString(),
    capSuccesses: entities.filter((e) => e.captureStatus === 'success').length,
    capFailures: entities.filter((e) => e.captureStatus === 'error').length,
    rarityFinding: Boolean(brief.rarity_finding || brief.rarityFinding),
    rarityNote: brief.rarity_note || brief.rarityNote || '',
  }, { filename: templatePath });

  fs.writeFileSync(out, html, 'utf8');

  const stats = fs.statSync(out);
  return {
    path: out,
    bytes: stats.size,
    mb: +(stats.size / 1024 / 1024).toFixed(2),
    entityCount: entities.length,
    yesCount,
    partialCount,
    failedCount: (failedList || []).length,
    battlecards: resolvedBattlecards.map((bc) => ({
      id: bc.id || null,
      label: bc.label || null,
      category: bc.category || null,
      filePath: bc.filePath || bc.href || null,
      bytes: bc.bytes != null ? bc.bytes : null,
    })),
    framework_lens: brief.framework_lens,
    battlecard_enabled: brief.battlecard_enabled,
  };
}

async function runCli() {
  const args = process.argv.slice(2);
  function getArg(n) { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; }
  const root = getArg('--root') || process.cwd();
  const result = await buildReport({
    briefPath: getArg('--brief') || path.join(root, '.agents/scout/brief.json'),
    entityDataPath: getArg('--entity-data') || path.join(root, 'analysis/entity-data.json'),
    patternsPath: getArg('--patterns') || path.join(root, 'analysis/patterns.json'),
    captureMetadataPath: getArg('--capture-meta') || path.join(root, 'analysis/capture-metadata.json'),
    verdictsPath: getArg('--verdicts') || path.join(root, '.agents/scout/.layer3-verdicts.json'),
    failedCandidatesPath: getArg('--failed') || path.join(root, 'analysis/failed-candidates.json'),
    outputPath: getArg('--out') || path.join(root, 'research-report.html'),
    reportTitle: getArg('--title') || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { buildReport, normalizePatterns, buildShareText };

if (require.main === module) {
  runCli().catch((e) => { console.error(e); process.exit(1); });
}
