#!/usr/bin/env node
/**
 * lib/capture.js
 *
 * Generic Puppeteer capture module for the scout plugin.
 *
 * Ported from the April 2026 Ultra-plan capture-screenshots.js but
 * generalized to accept config and return structured metadata.
 *
 * Public API:
 *
 *   const { capture } = require('./capture');
 *   const result = await capture({
 *     urls: [{ id: 'notion', label: 'Notion', url: 'https://notion.so/pricing', category: 'productivity' }],
 *     mode: 'thumbnail' | 'full',
 *     outputDir: '/abs/path/to/screenshots',
 *     concurrency: 4,
 *     retries: 1,
 *     jpegQuality: 80,
 *     cookieSelectors: [...],   // optional; defaults merged in
 *     viewport: { width, height }, // optional override of mode preset
 *     onProgress: (result) => {},   // optional, fires after every URL
 *     timeoutMs: 30000
 *   });
 *
 * Returns: { results: [...], successes, failures, totalDurationSec, viewport, jpegQuality }
 *
 * Also runnable from CLI:
 *   node capture.js --config path/to/config.json
 *   node capture.js --smoke            # runs Notion/Stripe/Linear
 *   node capture.js --url https://x.com --out ./shots
 */

const path = require('path');
const fs = require('fs');
const { slugify, contentHash } = require('./util');

const MODE_PRESETS = {
  thumbnail: { width: 800, height: 500, renderWidth: 400, renderHeight: 250 },
  full: { width: 1440, height: 900 },
};

const DEFAULT_COOKIE_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '[data-testid="cookie-accept"]',
  'button[aria-label="Accept"]',
  'button[aria-label="Accept all"]',
  'button[aria-label="Accept All"]',
  'button[aria-label="Accept cookies"]',
  '.cookie-accept',
  '.cc-accept',
  '#accept-cookies',
  'button.accept-cookies',
  '[data-action="accept"]',
  '#gdpr-cookie-accept',
  '.js-cookie-consent-agree',
];

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function dismissCookies(page, selectors) {
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click().catch(() => {});
        await new Promise((r) => setTimeout(r, 700));
        return true;
      }
    } catch (_) {
      /* continue */
    }
  }
  return false;
}

async function captureOne(browser, entity, opts) {
  const { outputDir, jpegQuality, viewport, cookieSelectors, timeoutMs, pageLoadWaitMs, fullPage, flat } = opts;
  const start = Date.now();

  const category = entity.category || 'uncategorized';
  const id = entity.id || slugify(entity.label || entity.url);
  const targetDir = flat ? outputDir : path.join(outputDir, category);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const filePath = path.join(targetDir, `${id}.jpg`);

  const page = await browser.newPage();
  try {
    await page.setUserAgent(DEFAULT_UA);
    await page.setViewport(viewport);

    await page.goto(entity.url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    await new Promise((r) => setTimeout(r, pageLoadWaitMs));
    const cookieDismissed = await dismissCookies(page, cookieSelectors);
    if (cookieDismissed) await new Promise((r) => setTimeout(r, 400));

    await page.screenshot({
      path: filePath,
      fullPage: Boolean(fullPage),
      type: 'jpeg',
      quality: jpegQuality,
    });

    const stats = fs.statSync(filePath);
    const capturedAt = new Date().toISOString();
    const content_hash = contentHash(filePath);
    return {
      id,
      label: entity.label || id,
      category,
      url: entity.url,
      status: 'success',
      file: filePath,
      fileSize: stats.size,
      fileSizeKB: Math.round(stats.size / 1024),
      cookieDismissed,
      durationSec: +((Date.now() - start) / 1000).toFixed(2),
      timestamp: capturedAt,
      captured_at: capturedAt,
      content_hash,
    };
  } catch (err) {
    return {
      id,
      label: entity.label || id,
      category,
      url: entity.url,
      status: 'error',
      file: null,
      fileSize: 0,
      fileSizeKB: 0,
      error: err && err.message ? err.message : String(err),
      durationSec: +((Date.now() - start) / 1000).toFixed(2),
      timestamp: new Date().toISOString(),
    };
  } finally {
    try { await page.close(); } catch (_) { /* ignore */ }
  }
}

/**
 * Run capture with a simple concurrency pool.
 */
async function capture(config = {}) {
  const puppeteer = require('puppeteer');

  const mode = config.mode === 'full' ? 'full' : 'thumbnail';
  const preset = MODE_PRESETS[mode];
  const viewport = config.viewport || { width: preset.width, height: preset.height };
  const jpegQuality = Number.isFinite(config.jpegQuality) ? config.jpegQuality : 80;
  const concurrency = Math.max(1, Math.min(8, config.concurrency || (mode === 'thumbnail' ? 4 : 2)));
  const retries = Number.isFinite(config.retries) ? config.retries : 1;
  const cookieSelectors = [...(config.cookieSelectors || []), ...DEFAULT_COOKIE_SELECTORS];
  const outputDir = config.outputDir || path.resolve(process.cwd(), mode === 'thumbnail' ? '.agents/scout/thumbs' : 'screenshots');
  const timeoutMs = config.timeoutMs || 30000;
  const pageLoadWaitMs = config.pageLoadWaitMs != null ? config.pageLoadWaitMs : (mode === 'thumbnail' ? 1500 : 3000);
  // v3 behavior: default to fullPage:true for 'full' mode (always capture the whole scrollable page;
  // the relevant region is later cropped by build-report using vision-judge's pattern bbox).
  // Thumbnails still ATF (faster, used only for decision-map candidate previews).
  const fullPage = config.fullPage != null ? Boolean(config.fullPage) : (mode === 'full');
  const flat = config.flat != null ? Boolean(config.flat) : (mode === 'thumbnail');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const urls = Array.isArray(config.urls) ? config.urls : [];
  if (!urls.length) {
    return { results: [], successes: 0, failures: 0, totalDurationSec: 0, viewport, jpegQuality };
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: viewport,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const totalStart = Date.now();
  const results = new Array(urls.length);
  let cursor = 0;
  let successes = 0;
  let failures = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= urls.length) return;
      const entity = urls[i];
      let result = await captureOne(browser, entity, {
        outputDir, jpegQuality, viewport, cookieSelectors, timeoutMs, pageLoadWaitMs, fullPage, flat,
      });
      for (let attempt = 0; attempt < retries && result.status === 'error'; attempt++) {
        await new Promise((r) => setTimeout(r, 2500));
        result = await captureOne(browser, entity, {
          outputDir, jpegQuality, viewport, cookieSelectors, timeoutMs, pageLoadWaitMs, fullPage, flat,
        });
      }
      if (result.status === 'success') successes++; else failures++;
      results[i] = result;
      if (typeof config.onProgress === 'function') {
        try { config.onProgress(result, { completed: successes + failures, total: urls.length }); }
        catch (_) { /* ignore */ }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);
  await browser.close();

  const totalDurationSec = +((Date.now() - totalStart) / 1000).toFixed(2);

  const metadata = {
    capturedAt: new Date().toISOString(),
    mode,
    viewport,
    jpegQuality,
    concurrency,
    retries,
    totalEntities: urls.length,
    successes,
    failures,
    totalDurationSec,
    results,
  };

  if (config.metadataPath) {
    fs.mkdirSync(path.dirname(config.metadataPath), { recursive: true });
    fs.writeFileSync(config.metadataPath, JSON.stringify(metadata, null, 2));
  }

  return metadata;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function runCli() {
  const args = process.argv.slice(2);
  function getArg(name) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  }

  if (args.includes('--smoke')) {
    const out = path.resolve(process.cwd(), '.scout-smoke');
    const result = await capture({
      mode: 'thumbnail',
      outputDir: out,
      urls: [
        { id: 'notion', label: 'Notion', category: 'smoke', url: 'https://www.notion.com/pricing' },
        { id: 'stripe', label: 'Stripe', category: 'smoke', url: 'https://stripe.com/pricing' },
        { id: 'linear', label: 'Linear', category: 'smoke', url: 'https://linear.app/pricing' },
      ],
      metadataPath: path.join(out, 'capture-metadata.json'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const configPath = getArg('--config');
  if (configPath) {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
    const result = await capture(cfg);
    console.log(JSON.stringify({ successes: result.successes, failures: result.failures, totalDurationSec: result.totalDurationSec }, null, 2));
    return;
  }

  const oneUrl = getArg('--url');
  if (oneUrl) {
    const result = await capture({
      mode: getArg('--mode') || 'full',
      outputDir: getArg('--out') || path.resolve(process.cwd(), 'screenshots'),
      urls: [{ id: slugify(oneUrl), label: oneUrl, category: 'adhoc', url: oneUrl }],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('Usage: node capture.js --smoke');
  console.log('       node capture.js --config path/to/config.json');
  console.log('       node capture.js --url https://example.com [--out ./shots] [--mode full|thumbnail]');
  process.exit(1);
}

module.exports = { capture, slugify, DEFAULT_COOKIE_SELECTORS, MODE_PRESETS };

if (require.main === module) {
  runCli().catch((err) => { console.error(err); process.exit(1); });
}
