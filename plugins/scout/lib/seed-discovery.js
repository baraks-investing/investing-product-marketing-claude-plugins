#!/usr/bin/env node
/**
 * lib/seed-discovery.js — Layer 1 orchestrator for scout.
 *
 * v4 change: merges seed candidates coming from up to 6 independent streams,
 * tags each with a `source_trust` tier, and dedupes by hostname while
 * preserving the highest-trust metadata.
 *
 * Streams (all caller-provided; this module does no networking):
 *   1. webSearchResults      — [{url, query?, primaryDomain?}] — Claude WebSearch.
 *                              A candidate is tagged `high` when its hostname
 *                              matches the result's `primaryDomain` (meaning the
 *                              candidate is the company's own site, not a
 *                              listicle linking to it).
 *   2. listicleResults       — [{url, extractedCompanies:[{name,url}]}] —
 *                              `low` trust (blog-style curation, often stale).
 *   3. llmProposals          — [{id?,label?,url,category?,rationale?}] — Claude
 *                              LLM memory. `low` on its own.
 *   4. codexLlmProposals     — [{id?,label?,url,category?,rationale?}] — Codex
 *                              LLM subagent output. `low` on its own. If the
 *                              same hostname shows up in BOTH llmProposals and
 *                              codexLlmProposals, trust is promoted to `medium`
 *                              (two-LLM consensus).
 *   5. productHuntMentions   — [{url, context?, rank?}] — `medium`.
 *   6. hackerNewsMentions    — [{url, context?, rank?}] — `medium`.
 *   7. g2CapterraCatalog     — [{url, context?, rank?}] — `medium`.
 *
 * Triangulation promotion: if the same hostname appears in any LLM stream AND
 * in one of {websearch-high, PH, HN, G2}, final trust is promoted to `high`.
 *
 * Output shape (written to .agents/scout/.seeds.json):
 *   [
 *     {
 *       id, label, url,
 *       source: "websearch" | "listicle" | "llm" | "codex_llm"
 *             | "product_hunt" | "hacker_news" | "g2_capterra",
 *       source_stream: <same as source>,
 *       source_trust: "high" | "medium" | "low",
 *       sourceContext, category?,
 *       contributingStreams: [ ...all streams that proposed this hostname... ]
 *     },
 *     ...
 *   ]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { slugify } = require('./util');

function safeHost(u) {
  try {
    const parsed = new URL(u);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return null;
  }
}

function deriveLabelFromHost(host) {
  if (!host) return 'unknown';
  const core = host.split('.')[0];
  return core.charAt(0).toUpperCase() + core.slice(1);
}

// Per-stream base trust (before consensus / triangulation logic runs).
// Note: websearch starts at 'low' here and gets promoted to 'high' below when
// the candidate hostname matches the result's primaryDomain — otherwise the
// websearch hit is really just "Google's SERP mentioned this URL somewhere",
// which is listicle-grade evidence.
const BASE_TRUST = {
  websearch: 'low',
  listicle: 'low',
  llm: 'low',
  codex_llm: 'low',
  product_hunt: 'medium',
  hacker_news: 'medium',
  g2_capterra: 'medium',
};

function normalizeSeed(entry, source, sourceContext, opts) {
  if (!entry || !entry.url) return null;
  const host = safeHost(entry.url);
  if (!host) return null;
  const label = entry.label || entry.name || deriveLabelFromHost(host);
  const id = entry.id || slugify(label + '-' + host);
  let trust = BASE_TRUST[source] || 'low';
  // WebSearch promotion: own-domain hits are high-trust.
  if (source === 'websearch' && opts && opts.primaryDomain) {
    const pd = String(opts.primaryDomain).replace(/^www\./, '').toLowerCase();
    if (pd && (host === pd || host.endsWith('.' + pd))) trust = 'high';
  }
  return {
    id,
    label,
    url: entry.url,
    source,
    source_stream: source,
    source_trust: trust,
    sourceContext: sourceContext || entry.sourceContext || '',
    category: entry.category || null,
    contributingStreams: [source],
  };
}

// Trust ranking used for "keep the winner on a hostname collision" resolution.
const TRUST_RANK = { high: 3, medium: 2, low: 1 };

function trustMax(a, b) {
  return (TRUST_RANK[b] || 0) > (TRUST_RANK[a] || 0) ? b : a;
}

/**
 * Main entrypoint.
 *
 * @param {object} opts
 * @param {string} [opts.researchQuestion]  — for logging only
 * @param {Array<{url:string, primaryDomain?:string, query?:string}>} [opts.webSearchResults]
 * @param {Array<{url:string, extractedCompanies:Array<{name,url}>}>} [opts.listicleResults]
 * @param {Array<{id,label,url,category}>} [opts.llmProposals]
 * @param {Array<{id,label,url,category}>} [opts.codexLlmProposals]
 * @param {Array<{url,context?,rank?}>} [opts.productHuntMentions]
 * @param {Array<{url,context?,rank?}>} [opts.hackerNewsMentions]
 * @param {Array<{url,context?,rank?}>} [opts.g2CapterraCatalog]
 * @param {number} [opts.maxSeeds=50]
 * @param {string} [opts.outputPath]   — optional path to write JSON output
 * @returns {{seeds: Array, stats: object}}
 */
function discoverSeeds(opts) {
  const {
    webSearchResults = [],
    listicleResults = [],
    llmProposals = [],
    codexLlmProposals = [],
    productHuntMentions = [],
    hackerNewsMentions = [],
    g2CapterraCatalog = [],
    maxSeeds = 50,
    outputPath = null,
    round = 1,
    alreadySeenDomains = [],
  } = opts || {};

  const seenSet = new Set(
    (alreadySeenDomains || [])
      .map((d) => String(d || '').replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase().split('/')[0])
      .filter(Boolean)
  );

  const collected = [];

  // Stream 1: websearch
  (webSearchResults || []).forEach((r) => {
    const seed = normalizeSeed(
      r, 'websearch',
      r && r.query ? `query: ${r.query}` : 'websearch',
      { primaryDomain: r && r.primaryDomain ? r.primaryDomain : null }
    );
    if (seed) collected.push(seed);
  });

  // Stream 2: listicles
  (listicleResults || []).forEach((article) => {
    if (!article) return;
    const articleUrl = article.url || '(unknown article)';
    (article.extractedCompanies || []).forEach((c) => {
      const seed = normalizeSeed(c, 'listicle', `from: ${articleUrl}`);
      if (seed) collected.push(seed);
    });
  });

  // Stream 3: LLM (Claude)
  (llmProposals || []).forEach((p) => {
    const seed = normalizeSeed(p, 'llm', p && p.rationale ? p.rationale : 'claude-llm-proposed');
    if (seed) collected.push(seed);
  });

  // Stream 4: LLM (Codex)
  (codexLlmProposals || []).forEach((p) => {
    const seed = normalizeSeed(p, 'codex_llm', p && p.rationale ? p.rationale : 'codex-llm-proposed');
    if (seed) collected.push(seed);
  });

  // Stream 5: Product Hunt
  (productHuntMentions || []).forEach((p) => {
    const seed = normalizeSeed(p, 'product_hunt', p && p.context ? p.context : 'product-hunt');
    if (seed) collected.push(seed);
  });

  // Stream 6: Hacker News
  (hackerNewsMentions || []).forEach((p) => {
    const seed = normalizeSeed(p, 'hacker_news', p && p.context ? p.context : 'hacker-news');
    if (seed) collected.push(seed);
  });

  // Stream 7: G2 / Capterra
  (g2CapterraCatalog || []).forEach((p) => {
    const seed = normalizeSeed(p, 'g2_capterra', p && p.context ? p.context : 'g2-capterra');
    if (seed) collected.push(seed);
  });

  // Dedupe by hostname. On collision:
  //   - Keep the record with the highest base trust as the primary.
  //   - Union all contributingStreams.
  //   - Apply consensus + triangulation rules to compute final trust.
  const byHost = new Map();
  for (const seed of collected) {
    const host = safeHost(seed.url);
    if (!host) continue;
    const existing = byHost.get(host);
    if (!existing) {
      byHost.set(host, seed);
    } else {
      // Union contributing streams.
      const merged = Object.assign({}, existing);
      merged.contributingStreams = Array.from(new Set(
        [].concat(existing.contributingStreams || [], seed.contributingStreams || [])
      ));
      // Primary source stays at the higher-trust record; swap if seed wins.
      if ((TRUST_RANK[seed.source_trust] || 0) > (TRUST_RANK[existing.source_trust] || 0)) {
        merged.source = seed.source;
        merged.source_stream = seed.source_stream;
        merged.source_trust = seed.source_trust;
        merged.sourceContext = seed.sourceContext || existing.sourceContext;
        merged.category = seed.category || existing.category;
        merged.label = seed.label || existing.label;
        merged.id = existing.id; // keep stable id
      }
      byHost.set(host, merged);
    }
  }

  // Consensus + triangulation promotion pass.
  for (const [host, seed] of byHost.entries()) {
    const streams = new Set(seed.contributingStreams || []);
    const hasClaude = streams.has('llm');
    const hasCodex = streams.has('codex_llm');
    const hasHighSocial = streams.has('product_hunt')
      || streams.has('hacker_news')
      || streams.has('g2_capterra');

    // Did we see a HIGH-trust websearch hit on this host? The per-record trust
    // already captures that, but we need to know the fact independently of
    // whether that record "won" the primary slot.
    const hasHighWebsearch = (collected || []).some((c) =>
      safeHost(c.url) === host && c.source === 'websearch' && c.source_trust === 'high'
    );

    // Two-LLM consensus: Claude + Codex both proposed this host → bump to medium.
    if (hasClaude && hasCodex && seed.source_trust === 'low') {
      seed.source_trust = 'medium';
      seed.trust_reason = 'two-LLM consensus (Claude + Codex)';
    }

    // Triangulation: any LLM stream AND a high/medium non-LLM stream → high.
    const hasAnyLlm = hasClaude || hasCodex;
    if (hasAnyLlm && (hasHighWebsearch || hasHighSocial)) {
      if (seed.source_trust !== 'high') {
        seed.source_trust = 'high';
        seed.trust_reason = 'triangulated (LLM + non-LLM evidence)';
      }
    }
  }

  let seeds = Array.from(byHost.values()).filter((s) => {
    const host = safeHost(s.url);
    return host && !seenSet.has(host);
  });

  // Sort: trust desc, then source rank, then label asc (deterministic).
  const sourceRank = {
    websearch: 7, product_hunt: 6, hacker_news: 5, g2_capterra: 4,
    listicle: 3, codex_llm: 2, llm: 1,
  };
  seeds.sort((a, b) => {
    const t = (TRUST_RANK[b.source_trust] || 0) - (TRUST_RANK[a.source_trust] || 0);
    if (t !== 0) return t;
    const s = (sourceRank[b.source] || 0) - (sourceRank[a.source] || 0);
    if (s !== 0) return s;
    return String(a.label || '').localeCompare(String(b.label || ''));
  });

  if (seeds.length > maxSeeds) seeds = seeds.slice(0, maxSeeds);

  const byTrust = seeds.reduce((acc, s) => {
    acc[s.source_trust] = (acc[s.source_trust] || 0) + 1;
    return acc;
  }, { high: 0, medium: 0, low: 0 });

  const stats = {
    collectedRaw: collected.length,
    afterDedup: byHost.size,
    final: seeds.length,
    round,
    alreadySeenCount: seenSet.size,
    bySource: seeds.reduce((acc, s) => {
      acc[s.source] = (acc[s.source] || 0) + 1;
      return acc;
    }, {}),
    byTrust,
  };

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(seeds, null, 2), 'utf8');
  }

  return { seeds, stats };
}

/**
 * T05: sort seeds/verdicts/survivors array by source_trust (high → medium → low)
 * with stable ordering inside each tier. Records without a source_trust are
 * treated as 'low'.
 */
function sortByTrust(candidates) {
  if (!Array.isArray(candidates)) return [];
  // Decorate with original index to keep ordering stable inside each tier.
  const decorated = candidates.map((c, i) => ({ c, i }));
  decorated.sort((a, b) => {
    const at = TRUST_RANK[a.c && a.c.source_trust] || TRUST_RANK.low;
    const bt = TRUST_RANK[b.c && b.c.source_trust] || TRUST_RANK.low;
    if (bt !== at) return bt - at;
    return a.i - b.i;
  });
  return decorated.map((d) => d.c);
}

// CLI: node lib/seed-discovery.js --merge input.json --out output.json
function runCli() {
  const args = process.argv.slice(2);
  function getArg(n) { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; }
  const inputPath = getArg('--merge');
  const outPath = getArg('--out');
  if (!inputPath) {
    console.error('Usage: node seed-discovery.js --merge input.json [--out output.json]');
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const result = discoverSeeds(Object.assign({}, input, { outputPath: outPath || null }));
  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  discoverSeeds,
  safeHost,
  normalizeSeed,
  sortByTrust,
  BASE_TRUST,
  TRUST_RANK,
};

if (require.main === module) {
  try { runCli(); }
  catch (e) { console.error(e.stack || e.message); process.exit(1); }
}
