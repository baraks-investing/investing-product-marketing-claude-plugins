#!/usr/bin/env node
/**
 * lib/parse-paste-back.js
 *
 * Strict parser for the decision-map paste-back block.
 *
 * v3 change: schema v2 is the canonical shape. v1 remains parseable for
 * backward compat with briefs that were emitted by scout v2's HTML. A
 * deprecation line is logged when v1 is parsed; no error.
 *
 * v2 block shape:
 *   === SCOUT DECISION MAP v2 ===
 *   project_id: sc_xxxx
 *   schema: v2
 *   generated_at: <iso>
 *
 *   --- Research question ---
 *   value: <one-line text>
 *
 *   --- Decision type ---
 *   value: positioning | pricing | feature_roadmap | launch_messaging | ux_pattern | gtm | battlecard | other
 *
 *   --- Inclusion criteria ---
 *   selected: [value1, value2, ...]
 *   custom_added: [...]
 *
 *   --- Exclusion criteria ---
 *   selected: [...]
 *   custom_added: [...]
 *
 *   --- Dimensions ---
 *   selected: [...]
 *   custom_added: [...]
 *
 *   --- Visual evidence ---
 *   selected: [desktop, mobile]      # v3+ canonical shape — one or more of: desktop, mobile, none
 *   # Legacy tolerance: `value: desktop-atf | desktop-full | mobile | none` still parses.
 *   # `desktop-atf` / `desktop-full` both map to ['desktop'] (scout always captures full page now
 *   # and crops the relevant region for the report).
 *
 *   --- Target entity count ---
 *   value: 15 | 20 | 30 | 40
 *
 *   --- Minimum verified ---
 *   value: <integer>
 *
 *   --- Mockup count ---
 *   value: none | 1 | 3-5 | 5-7
 *
 *   --- Mockup kind ---
 *   selected: [...]
 *   custom_added: [...]
 *
 *   --- Second-opinion model ---
 *   value: sonnet | opus | haiku | none
 *
 *   --- Notes ---
 *   value: |
 *     multi-line free-form notes
 *
 *   --- Framework lens override ---         # v4 (optional)
 *   value: auto | jtbd | kano | price_anchor | descriptive
 *   # Default 'auto': inferred from decision_type.
 *   #   pricing → price_anchor
 *   #   feature_roadmap → kano
 *   #   positioning | launch_messaging → jtbd
 *   #   everything else → descriptive
 *
 *   --- Battlecards override ---            # v4 (optional)
 *   value: auto | yes | no
 *   # Default 'auto': generate for {pricing, positioning, launch_messaging, gtm, battlecard};
 *   # skip for {ux_pattern, feature_roadmap, other}.
 *
 *   --- Approved candidates ---
 *   - id=... | label=... | url=... | category=...
 *
 *   --- Custom candidates ---
 *   - url=...
 *   === END SCOUT DECISION MAP v2 ===
 *
 * Also: writeBrief(parsed, stateRoot) emits brief.md, brief.json,
 * rubric.json, tasks/*.json.
 *
 * v4 additions (comments only — runtime wiring lives in the relevant lib):
 *   - Seeds/verdicts schemas gain a `source_trust: 'high' | 'medium' | 'low'`
 *     field computed at Layer 1 time (see lib/seed-discovery.js). Used to
 *     order Layer 2 + Layer 3 processing and to color the report source chip.
 *   - brief.json gains:
 *       framework_lens:         'jtbd' | 'kano' | 'price_anchor' | 'descriptive'
 *       framework_lens_source:  'inferred' | 'explicit'
 *       battlecard_enabled:     boolean
 *       battlecard_source:      'inferred' | 'explicit'
 */

const fs = require('fs');
const path = require('path');
const { slugify } = require('./util');

const V2_START = '=== SCOUT DECISION MAP v2 ===';
const V2_END = '=== END SCOUT DECISION MAP v2 ===';
const V1_START = '=== SCOUT DECISION MAP v1 ===';
const V1_END = '=== END SCOUT DECISION MAP v1 ===';

const V2_REQUIRED_BLOCKS = [
  'Research question',
  'Decision type',
  'Inclusion criteria',
  'Exclusion criteria',
  'Dimensions',
  'Visual evidence',
  'Target entity count',
  'Minimum verified',
  'Mockup count',
  'Second-opinion model',
  'Approved candidates',
  'Custom candidates',
];

const VALID_DECISION_TYPES = new Set([
  'positioning', 'pricing', 'feature_roadmap', 'launch_messaging',
  'ux_pattern', 'gtm', 'battlecard', 'other',
]);

// v4: framework lens + battlecard override vocabularies.
const VALID_FRAMEWORK_LENSES = new Set([
  'auto', 'jtbd', 'kano', 'price_anchor', 'descriptive',
]);
const VALID_BATTLECARD_OVERRIDES = new Set(['auto', 'yes', 'no']);

// decision_type → inferred framework lens (applied when override is 'auto').
const LENS_MAPPING = {
  pricing: 'price_anchor',
  feature_roadmap: 'kano',
  positioning: 'jtbd',
  launch_messaging: 'jtbd',
  ux_pattern: 'descriptive',
  gtm: 'descriptive',
  battlecard: 'descriptive',
  other: 'descriptive',
};

// decision_type → battlecard auto-generation default (applied when override is 'auto').
const BATTLECARD_MAPPING = {
  pricing: true,
  positioning: true,
  launch_messaging: true,
  gtm: true,
  battlecard: true,
  ux_pattern: false,
  feature_roadmap: false,
  other: false,
};

function inferFrameworkLens(decisionType) {
  return LENS_MAPPING[decisionType] || 'descriptive';
}

function inferBattlecardEnabled(decisionType) {
  return !!BATTLECARD_MAPPING[decisionType];
}

class PasteBackError extends Error {
  constructor(message, blockName) {
    super(message);
    this.name = 'PasteBackError';
    this.blockName = blockName || null;
  }
}

function splitBlocks(body, endMarker) {
  const blockRegex = /^---\s+(.+?)\s+---\s*$/gm;
  const blocks = {};
  let m;
  let lastName = null;
  let lastStart = -1;
  const spans = [];
  while ((m = blockRegex.exec(body)) !== null) {
    if (lastName !== null) spans.push({ name: lastName, start: lastStart, end: m.index });
    lastName = m[1].trim();
    lastStart = m.index + m[0].length;
  }
  if (lastName !== null) spans.push({ name: lastName, start: lastStart, end: body.indexOf(endMarker) });
  spans.forEach((s) => { blocks[s.name] = body.slice(s.start, s.end).trim(); });
  return blocks;
}

// Parse a `selected: [a, b, c]` line into array of strings.
function parseListLine(raw, key) {
  const re = new RegExp('^' + key + ':\\s*(.*)$', 'm');
  const match = raw.match(re);
  if (!match) return [];
  let val = match[1].trim();
  if (!val || val === '[]' || val === '(none)') return [];
  // Strip surrounding brackets
  if (val.startsWith('[') && val.endsWith(']')) val = val.slice(1, -1);
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseValueLine(raw) {
  // Support "value: foo" and "value: |\n  multi-line"
  const pipe = raw.match(/^value:\s*\|\s*\n([\s\S]*)$/m);
  if (pipe) {
    return pipe[1].replace(/\n[ \t]{1,4}/g, '\n').trim();
  }
  const m = raw.match(/^value:\s*(.*)$/m);
  return m ? m[1].trim() : '';
}

// Normalize Visual evidence block into string[] of viewport keys.
// Accepts either `selected: [desktop, mobile]` or legacy `value: desktop-atf`/`desktop-full`/`mobile`/`none`.
// Empty/missing → ['desktop']. `['none']` is preserved as-is so downstream can skip captures.
function parseVisualEvidence(raw) {
  if (!raw || !raw.trim()) return ['desktop'];
  // Prefer `selected:` if present.
  if (/^selected:/m.test(raw)) {
    const list = parseListLine(raw, 'selected');
    const mapped = list.map((v) => {
      const s = String(v).trim().toLowerCase();
      if (s === 'desktop' || s === 'desktop-atf' || s === 'desktop-full') return 'desktop';
      if (s === 'mobile') return 'mobile';
      if (s === 'none') return 'none';
      return null;
    }).filter(Boolean);
    // Dedupe, preserving order.
    const seen = new Set();
    const out = [];
    mapped.forEach((v) => { if (!seen.has(v)) { seen.add(v); out.push(v); } });
    if (!out.length) return ['desktop'];
    // `none` is exclusive — if ticked with anything else, the "none" wins (user intent: skip capture).
    if (out.includes('none')) return ['none'];
    return out;
  }
  // Legacy `value:` form.
  const legacy = parseValueLine(raw) || '';
  const s = legacy.trim().toLowerCase();
  if (!s || s === '(none)') return ['desktop'];
  if (s === 'none') return ['none'];
  if (s === 'mobile') return ['mobile'];
  // desktop-atf / desktop-full / desktop → desktop (full-page + crop is the only behavior now)
  if (s.startsWith('desktop')) return ['desktop'];
  return ['desktop'];
}

function parseCandidates(raw) {
  const out = [];
  raw.split('\n').forEach((line) => {
    const t = line.trim();
    if (!t || t === '(none)' || !t.startsWith('- ')) return;
    const pairs = t.slice(2).split('|').map((s) => s.trim());
    const obj = {};
    pairs.forEach((p) => {
      const eq = p.indexOf('=');
      if (eq > 0) obj[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    });
    if (obj.url) out.push(obj);
  });
  return out;
}

// ---------- v1 legacy parser (kept for backward compat) ----------

const V1_REQUIRED_BLOCKS = [
  'Q1: Research question',
  'Q2: Inclusion criteria',
  'Q3: Exclusion criteria',
  'Q4: Target entity count',
  'Q5: Dimensions of analysis',
  'Q6: Visual evidence',
  'Q7: Mockups',
  'Q8: Second-opinion model',
  'Approved candidates',
  'Custom candidates',
];

function parseV1(body, expectedProjectId) {
  const projectMatch = body.match(/^project_id:\s*(\S+)\s*$/m);
  if (!projectMatch) throw new PasteBackError('Missing project_id line. Regenerate the block from the HTML.');
  const projectId = projectMatch[1];
  if (expectedProjectId && expectedProjectId !== projectId) {
    throw new PasteBackError(
      `project_id mismatch. Paste-back says "${projectId}" but the current run expects "${expectedProjectId}". Close the old HTML, re-run /scout:plan, and paste the new block.`
    );
  }
  const blocks = splitBlocks(body, V1_END);
  for (const req of V1_REQUIRED_BLOCKS) {
    if (!(req in blocks)) {
      throw new PasteBackError(
        `Block "${req}" missing. Paste the full output block from the HTML without edits.`,
        req
      );
    }
  }
  function parseQ(name) {
    const raw = blocks[name];
    const choiceMatch = raw.match(/^choice:\s*(.*)$/m);
    const noteMatch = raw.match(/^note:\s*([\s\S]*)$/m);
    let note = noteMatch ? noteMatch[1].replace(/\n[ \t]{1,4}/g, '\n').trim() : '';
    if (note === '(empty)') note = '';
    return { choice: choiceMatch ? choiceMatch[1].trim() : '', note };
  }
  // Translate v1 answers into v2-shape structured values
  const v1Answers = {
    research_question: parseQ('Q1: Research question'),
    inclusion_criteria: parseQ('Q2: Inclusion criteria'),
    exclusion_criteria: parseQ('Q3: Exclusion criteria'),
    target_count: parseQ('Q4: Target entity count'),
    dimensions: parseQ('Q5: Dimensions of analysis'),
    visual_evidence: parseQ('Q6: Visual evidence'),
    mockups: parseQ('Q7: Mockups'),
    second_opinion_model: parseQ('Q8: Second-opinion model'),
  };

  function toList(note) {
    if (!note) return [];
    return note.split(/[\n,]/).map((s) => s.replace(/^[-\d.\s]+/, '').trim()).filter(Boolean);
  }

  const structured = {
    researchQuestion: v1Answers.research_question.note || v1Answers.research_question.choice || '',
    decisionType: 'other', // v1 had no decision_type field
    inclusionSelected: toList(v1Answers.inclusion_criteria.note),
    inclusionCustom: [],
    exclusionSelected: toList(v1Answers.exclusion_criteria.note),
    exclusionCustom: [],
    dimensionsSelected: toList(v1Answers.dimensions.note),
    dimensionsCustom: [],
    visualEvidence: (function () {
      const v = String(v1Answers.visual_evidence.choice || '').toLowerCase();
      if (v === 'none') return ['none'];
      if (v === 'mobile') return ['mobile'];
      return ['desktop']; // desktop-atf | desktop-full | anything else → desktop
    })(),
    targetCount: (v1Answers.target_count.choice || '25-40').match(/\d+/)
      ? parseInt(v1Answers.target_count.choice.match(/\d+/)[0], 10) : 20,
    minVerified: 15,
    mockupCount: v1Answers.mockups.choice || 'none',
    secondOpinionModel: v1Answers.second_opinion_model.choice || 'sonnet',
    notes: '',
  };

  return {
    projectId,
    schemaVersion: 'v1',
    structured,
    approvedCandidates: parseCandidates(blocks['Approved candidates']),
    customCandidates: parseCandidates(blocks['Custom candidates']),
    // Keep v1-shape answers for anything downstream that still reads them
    answers: v1Answers,
  };
}

// ---------- v2 parser ----------

function parseV2(body, expectedProjectId) {
  const projectMatch = body.match(/^project_id:\s*(\S+)\s*$/m);
  if (!projectMatch) throw new PasteBackError('Missing project_id line. Regenerate the block from the HTML.');
  const projectId = projectMatch[1];
  if (expectedProjectId && expectedProjectId !== projectId) {
    throw new PasteBackError(
      `project_id mismatch. Paste-back says "${projectId}" but the current run expects "${expectedProjectId}". Close the old HTML, re-run /scout:plan, and paste the new block.`
    );
  }
  const schemaMatch = body.match(/^schema:\s*(\S+)\s*$/m);
  if (!schemaMatch || schemaMatch[1] !== 'v2') {
    throw new PasteBackError('schema line missing or not v2. Regenerate the block from the HTML.');
  }

  const blocks = splitBlocks(body, V2_END);
  for (const req of V2_REQUIRED_BLOCKS) {
    if (!(req in blocks)) {
      throw new PasteBackError(
        `Block "${req}" missing. Paste the full output block from the HTML without edits.`,
        req
      );
    }
  }

  const researchQuestion = parseValueLine(blocks['Research question']);
  let decisionType = parseValueLine(blocks['Decision type']) || 'other';
  if (!VALID_DECISION_TYPES.has(decisionType)) decisionType = 'other';

  const inclusionSelected = parseListLine(blocks['Inclusion criteria'], 'selected');
  const inclusionCustom = parseListLine(blocks['Inclusion criteria'], 'custom_added');
  const exclusionSelected = parseListLine(blocks['Exclusion criteria'], 'selected');
  const exclusionCustom = parseListLine(blocks['Exclusion criteria'], 'custom_added');
  const dimensionsSelected = parseListLine(blocks['Dimensions'], 'selected');
  const dimensionsCustom = parseListLine(blocks['Dimensions'], 'custom_added');

  // Visual evidence — v3+: selected: [desktop, mobile, ...]. Legacy v2 shape: value: desktop-atf.
  // Normalize both to a string[] of viewport keys drawn from: 'desktop' | 'mobile' | 'none'.
  const visualEvidence = parseVisualEvidence(blocks['Visual evidence']);
  const targetCountRaw = parseValueLine(blocks['Target entity count']);
  const targetCount = Number.parseInt(targetCountRaw, 10) || 20;
  const minVerifiedRaw = parseValueLine(blocks['Minimum verified']);
  const minVerified = Number.parseInt(minVerifiedRaw, 10) || 15;
  const mockupCount = parseValueLine(blocks['Mockup count']) || 'none';
  // Legacy v2 paste-backs may still include a "Mockup kind" block — read and discard tolerantly.
  // Field was removed post-v3-pass-1 to avoid biasing the mockup-designer agent.
  if ('Mockup kind' in blocks) {
    // intentionally ignored
  }
  const secondOpinionModel = parseValueLine(blocks['Second-opinion model']) || 'sonnet';

  // Reference screenshot: optional base64-embedded file uploaded in the HTML.
  // When present, extract and save to .agents/scout/reference/seed.<ext>.
  let referenceScreenshotPath = null;
  let referenceScreenshotFilename = null;
  if (blocks['Reference screenshot']) {
    const refBlock = blocks['Reference screenshot'];
    const filenameMatch = refBlock.match(/^\s*filename:\s*(.+)$/m);
    const mimeMatch = refBlock.match(/^\s*mime:\s*(\S+)/m);
    const dataMatch = refBlock.match(/^\s*data_base64:\s*([A-Za-z0-9+/=]+)\s*$/m);
    if (filenameMatch && dataMatch) {
      try {
        const filename = filenameMatch[1].trim();
        const mime = (mimeMatch && mimeMatch[1]) ? mimeMatch[1].trim() : 'image/png';
        const extFromMime = mime.split('/')[1] || 'png';
        const buf = Buffer.from(dataMatch[1], 'base64');
        referenceScreenshotFilename = filename;
        // Path is emitted so writeBrief can actually persist the bytes (brief-writer handles fs write)
        referenceScreenshotPath = { filename, mime, ext: extFromMime, buffer: buf };
      } catch (_) { /* silently drop; bad upload */ }
    }
  }

  const notes = blocks['Notes'] ? parseValueLine(blocks['Notes']) : '';

  // v4: optional Advanced research settings blocks. Missing → 'auto' default.
  let frameworkLensOverride = 'auto';
  if (blocks['Framework lens override']) {
    const v = parseValueLine(blocks['Framework lens override']).trim().toLowerCase();
    if (VALID_FRAMEWORK_LENSES.has(v)) frameworkLensOverride = v;
  }
  let battlecardOverride = 'auto';
  if (blocks['Battlecards override']) {
    const v = parseValueLine(blocks['Battlecards override']).trim().toLowerCase();
    if (VALID_BATTLECARD_OVERRIDES.has(v)) battlecardOverride = v;
  }

  const structured = {
    researchQuestion,
    decisionType,
    inclusionSelected,
    inclusionCustom,
    exclusionSelected,
    exclusionCustom,
    dimensionsSelected,
    dimensionsCustom,
    visualEvidence,
    targetCount,
    minVerified,
    mockupCount,
    secondOpinionModel,
    notes,
    referenceScreenshot: referenceScreenshotPath, // {filename, mime, ext, buffer} or null
    referenceScreenshotFilename,
    frameworkLensOverride,   // 'auto' | 'jtbd' | 'kano' | 'price_anchor' | 'descriptive'
    battlecardOverride,      // 'auto' | 'yes' | 'no'
  };

  return {
    projectId,
    schemaVersion: 'v2',
    structured,
    approvedCandidates: parseCandidates(blocks['Approved candidates']),
    customCandidates: parseCandidates(blocks['Custom candidates']),
    // For downstream v1-compat readers: synthesize answers-shape
    answers: {
      research_question: { choice: 'custom', note: researchQuestion },
      inclusion_criteria: { choice: 'strict', note: [...inclusionSelected, ...inclusionCustom].join('\n') },
      exclusion_criteria: { choice: 'list', note: [...exclusionSelected, ...exclusionCustom].join('\n') },
      target_count: { choice: String(targetCount), note: '' },
      dimensions: { choice: 'custom', note: [...dimensionsSelected, ...dimensionsCustom].join('\n') },
      visual_evidence: { choice: Array.isArray(visualEvidence) ? visualEvidence.join(',') : visualEvidence, note: '' },
      mockups: { choice: mockupCount, note: '' },
      second_opinion_model: { choice: secondOpinionModel, note: notes },
    },
  };
}

function parse(text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new PasteBackError('Paste-back text is empty. Paste the full output block from the decision-map HTML.');
  }

  const hasV2 = text.indexOf(V2_START) >= 0 && text.indexOf(V2_END) > text.indexOf(V2_START);
  const hasV1 = text.indexOf(V1_START) >= 0 && text.indexOf(V1_END) > text.indexOf(V1_START);

  if (!hasV2 && !hasV1) {
    throw new PasteBackError(
      'Missing schema envelope. The paste-back must start with `=== SCOUT DECISION MAP v2 ===` and end with `=== END SCOUT DECISION MAP v2 ===`. Paste the full block exactly as it came out of the HTML.'
    );
  }

  if (hasV2) {
    const s = text.indexOf(V2_START);
    const e = text.indexOf(V2_END);
    const body = text.slice(s, e + V2_END.length);
    return parseV2(body, opts.expectedProjectId);
  }

  // Legacy v1 — parse with deprecation notice
  const s = text.indexOf(V1_START);
  const e = text.indexOf(V1_END);
  const body = text.slice(s, e + V1_END.length);
  // eslint-disable-next-line no-console
  console.error('[scout] notice: parsing legacy v1 paste-back block. v2 is now the canonical schema — regenerate from /scout:plan for full v3 features.');
  return parseV1(body, opts.expectedProjectId);
}

function deriveLabelFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch (_) { return url; }
}

/**
 * Writes brief.md, brief.json, rubric.json, tasks/*.json into .agents/scout/ under stateRoot.
 */
function writeBrief(parsed, stateRoot) {
  if (!stateRoot) throw new Error('writeBrief: stateRoot required');
  const s = parsed.structured || {};

  // Persist an uploaded reference screenshot from the HTML (base64 → disk).
  let persistedRefPath = null;
  if (s.referenceScreenshot && s.referenceScreenshot.buffer) {
    try {
      const refDir = path.resolve(stateRoot, 'reference');
      fs.mkdirSync(refDir, { recursive: true });
      const ext = String(s.referenceScreenshot.ext || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'png';
      const outPath = path.join(refDir, 'seed.' + ext);
      fs.writeFileSync(outPath, s.referenceScreenshot.buffer);
      persistedRefPath = outPath;
    } catch (_) { /* non-fatal */ }
  }
  // Back-compat: downstream reads these fields; accept either the fresh upload or a prior chat-saved path.
  if (persistedRefPath) {
    parsed.referenceScreenshotPath = persistedRefPath;
    s.referenceScreenshotPath = persistedRefPath;
    s.referenceScreenshotFilename = s.referenceScreenshot.filename;
  }

  const allCandidates = [
    ...parsed.approvedCandidates,
    ...parsed.customCandidates.map((c) => ({
      id: slugify(deriveLabelFromUrl(c.url)),
      label: deriveLabelFromUrl(c.url),
      url: c.url,
      category: 'user-added',
    })),
  ];

  // Dimensions — merge selected + custom; fall back to defaults
  const DEFAULT_DIMENSIONS = [
    'positioning_headline', 'primary_cta', 'visual_hierarchy', 'proof_elements',
  ];
  let dimensions = [
    ...(s.dimensionsSelected || []),
    ...(s.dimensionsCustom || []),
  ].map((x) => String(x).trim()).filter(Boolean);
  if (!dimensions.length) dimensions = DEFAULT_DIMENSIONS.slice();

  const inclusionCriteria = [
    ...(s.inclusionSelected || []),
    ...(s.inclusionCustom || []),
  ].filter(Boolean);

  const exclusionCriteria = [
    ...(s.exclusionSelected || []),
    ...(s.exclusionCustom || []),
  ].filter(Boolean);

  const briefMd = [
    `# Scout research brief`,
    ``,
    `**Project ID:** \`${parsed.projectId}\``,
    `**Schema version:** ${parsed.schemaVersion}`,
    `**Decision type:** ${s.decisionType || 'other'}`,
    `**Generated:** ${new Date().toISOString()}`,
    ``,
    `## Research question`,
    ``,
    s.researchQuestion || '(not provided)',
    ``,
    `## Inclusion criteria (bias check)`,
    ``,
    inclusionCriteria.length ? inclusionCriteria.map((c) => `- ${c}`).join('\n') : '(none listed)',
    ``,
    `## Exclusion criteria`,
    ``,
    exclusionCriteria.length ? exclusionCriteria.map((c) => `- ${c}`).join('\n') : '(none)',
    ``,
    `## Target entity count`,
    ``,
    `Target: **${s.targetCount || 20}** · Minimum verified: **${s.minVerified || 15}**`,
    ``,
    `## Dimensions of analysis`,
    ``,
    dimensions.map((d) => `- ${d}`).join('\n'),
    ``,
    `## Visual evidence`,
    ``,
    `Viewports: **${(Array.isArray(s.visualEvidence) ? s.visualEvidence : [s.visualEvidence || 'desktop']).join(', ')}**`,
    ``,
    `## Mockups`,
    ``,
    `Count: **${s.mockupCount || 'none'}**`,
    ``,
    `## Second-opinion model`,
    ``,
    `Model: **${s.secondOpinionModel || 'sonnet'}**`,
    ``,
    s.notes ? `## Notes\n\n${s.notes}\n` : '',
    `## Approved entities (${allCandidates.length})`,
    ``,
    allCandidates.map((c) => `- **${c.label}** — ${c.url} _(${c.category || 'uncategorized'})_`).join('\n'),
    ``,
    `---`,
    `_Auto-generated from the decision-map paste-back._`,
  ].filter((x) => x !== '').join('\n');

  const rubric = {
    criteria: {
      functionality: { threshold: 7, description: 'All approved entities captured at requested viewport; analysis fields populated per schema; patterns quantified with denominators.' },
      product_depth: { threshold: 7, description: 'Patterns section actually answers the research question. Recommendations are specific, not generic.' },
      visual_design: { threshold: 7, description: 'Research HTML is self-contained, <30MB, gallery filterable, per-entity cards legible. Matches reference style.' },
      code_quality:  { threshold: 7, description: 'entity-data.json and patterns.json are well-formed; state.progress resumability intact.' },
    },
    max_repair_passes: 2,
  };

  const tasks = [
    { id: 'E01', title: 'Full-fidelity screenshot capture',
      description: `Capture all ${allCandidates.length} approved entities at the viewport specified in the brief. Resume-safe via state.progress[].`,
      verification: ['All entities appear in analysis/capture-metadata.json', 'Failed captures flagged, not silently dropped'] },
    { id: 'E02', title: 'Per-entity analysis against brief schema',
      description: `Run generator subagent per entity, populating dimensions: ${dimensions.join(', ')}. Write analysis/entity-data.json.`,
      verification: ['Every entity has every dimension', 'Per-entity JSON shape matches brief schema'] },
    { id: 'E03', title: 'Cross-entity pattern aggregation',
      description: 'Compute frequency tables and quantified patterns across entities. Write analysis/patterns.json with denominators.',
      verification: ['patterns.json has counts and percentages with total N', 'Patterns tie back to the research question'] },
    { id: 'E04', title: 'Build research HTML deliverable',
      description: 'Render self-contained HTML with gallery, per-entity cards, patterns, recommendations. Link mockups as standalone files if opted in.',
      verification: ['HTML under 30MB', 'No external asset references', 'Mockup card grid links to standalone files iff mockups != none'] },
  ];

  const scoutRoot = path.resolve(stateRoot);
  fs.mkdirSync(scoutRoot, { recursive: true });
  fs.mkdirSync(path.join(scoutRoot, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(scoutRoot, 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(scoutRoot, 'reviews'), { recursive: true });
  fs.mkdirSync(path.join(scoutRoot, 'evaluations'), { recursive: true });

  fs.writeFileSync(path.join(scoutRoot, 'brief.md'), briefMd, 'utf8');
  fs.writeFileSync(path.join(scoutRoot, 'rubric.json'), JSON.stringify(rubric, null, 2), 'utf8');
  tasks.forEach((t) => fs.writeFileSync(path.join(scoutRoot, 'tasks', `${t.id}.json`), JSON.stringify(t, null, 2), 'utf8'));

  // v4: resolve framework lens + battlecard enablement from override + decision type.
  const decisionType = s.decisionType || 'other';
  const lensOverride = s.frameworkLensOverride || 'auto';
  let framework_lens;
  let framework_lens_source;
  if (lensOverride === 'auto' || !VALID_FRAMEWORK_LENSES.has(lensOverride)) {
    framework_lens = inferFrameworkLens(decisionType);
    framework_lens_source = 'inferred';
  } else {
    framework_lens = lensOverride;
    framework_lens_source = 'explicit';
  }

  const bcOverride = s.battlecardOverride || 'auto';
  let battlecard_enabled;
  let battlecard_source;
  if (bcOverride === 'auto' || !VALID_BATTLECARD_OVERRIDES.has(bcOverride)) {
    battlecard_enabled = inferBattlecardEnabled(decisionType);
    battlecard_source = 'inferred';
  } else {
    battlecard_enabled = (bcOverride === 'yes');
    battlecard_source = 'explicit';
  }

  const briefJson = {
    projectId: parsed.projectId,
    schemaVersion: parsed.schemaVersion || 'v2',
    decisionType: s.decisionType || 'other',
    framework_lens,
    framework_lens_source,
    battlecard_enabled,
    battlecard_source,
    researchQuestion: s.researchQuestion || '',
    inclusionCriteria,
    exclusionCriteria,
    targetCount: s.targetCount || 20,
    minVerified: s.minVerified != null ? s.minVerified : 15,
    reseedRounds: 1,
    dimensions,
    visualEvidence: Array.isArray(s.visualEvidence)
      ? s.visualEvidence.slice()
      : (s.visualEvidence ? [String(s.visualEvidence)] : ['desktop']),
    mockups: {
      count: s.mockupCount || 'none',
    },
    secondOpinionModel: s.secondOpinionModel || 'sonnet',
    notes: s.notes || '',
    reference_screenshot_path: parsed.referenceScreenshotPath || s.referenceScreenshotPath || null,
    entities: allCandidates,
  };
  fs.writeFileSync(path.join(scoutRoot, 'brief.json'), JSON.stringify(briefJson, null, 2), 'utf8');

  return {
    briefMdPath: path.join(scoutRoot, 'brief.md'),
    briefJsonPath: path.join(scoutRoot, 'brief.json'),
    rubricPath: path.join(scoutRoot, 'rubric.json'),
    tasks,
  };
}

async function runCli() {
  const args = process.argv.slice(2);
  function getArg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
  const inputPath = getArg('--input');
  const expectedProjectId = getArg('--project-id');
  const stateRoot = getArg('--state-root') || path.resolve(process.cwd(), '.agents/scout');
  const doWrite = args.includes('--write');

  if (!inputPath) {
    console.log('Usage: node parse-paste-back.js --input paste.txt [--project-id sc_xxx] [--state-root .agents/scout] [--write]');
    process.exit(1);
  }
  const text = fs.readFileSync(path.resolve(inputPath), 'utf8');
  try {
    const parsed = parse(text, { expectedProjectId });
    if (doWrite) {
      const res = writeBrief(parsed, stateRoot);
      console.log(JSON.stringify({ ok: true, parsed, written: res }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: true, parsed }, null, 2));
    }
  } catch (err) {
    if (err instanceof PasteBackError) {
      console.error(JSON.stringify({ ok: false, error: err.message, blockName: err.blockName }, null, 2));
      process.exit(2);
    }
    throw err;
  }
}

module.exports = {
  parse,
  writeBrief,
  PasteBackError,
  VALID_DECISION_TYPES,
  VALID_FRAMEWORK_LENSES,
  VALID_BATTLECARD_OVERRIDES,
  LENS_MAPPING,
  BATTLECARD_MAPPING,
  inferFrameworkLens,
  inferBattlecardEnabled,
};

if (require.main === module) {
  runCli().catch((e) => { console.error(e); process.exit(1); });
}
