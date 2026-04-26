#!/usr/bin/env node
/**
 * lib/gallery-composer.js
 *
 * Compose a small JPEG gallery preview from N entity screenshots arranged in
 * a grid. Used by the report builder to produce a one-image visual summary
 * suitable for dragging into Slack / email alongside the share-text payload.
 *
 * Public API:
 *
 *   const { composeGallery } = require('./gallery-composer');
 *   const result = await composeGallery({
 *     tiles: [
 *       { path: '/abs/path/to/stripe.jpg', cropTop: 60, cropHeight: 600 },
 *       { path: '/abs/path/to/figma.jpg' },                  // defaults: cropTop=0, cropHeight=600
 *       ...
 *     ],
 *     outputPath: '/abs/path/to/research-report-gallery.jpg',
 *     cols: 3, rows: 3,                                      // defaults
 *     cellWidth: 400, cellHeight: 250,                       // defaults
 *     gutter: 12,                                            // defaults
 *     background: '#FFFFFF',                                 // default white
 *     jpegQuality: 80,                                       // default
 *   });
 *   // result = { outputPath, bytes, usedPaths: [...], skipped: [{path, reason}, ...] }
 *
 * Behavior:
 *   - For each tile, sharp.extract({ left:0, top:cropTop, width:imgW, height:cropHeight })
 *     then resize to cellWidth × cellHeight, then composite onto the canvas.
 *   - Missing/errored tiles are skipped (tracked in `skipped`); cells stay white.
 *   - More tiles than cells (cols × rows) are ignored beyond the cap.
 *   - Output is JPEG (smaller than PNG; adequate for a preview thumbnail).
 *   - This module never throws on per-tile errors — it logs them and continues.
 *     The caller is responsible for catching a hard failure (canvas creation,
 *     output write) and degrading gracefully.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let _sharp = null;
function getSharp() {
  if (_sharp !== null) return _sharp;
  try { _sharp = require('sharp'); } catch (_) { _sharp = false; }
  return _sharp;
}

function clampInt(v, lo, hi, fallback) {
  // Treat null/undefined/'' as "use the fallback" — Number(null) === 0 would
  // otherwise silently coerce to a 0 or 1 here and mask caller intent.
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

async function composeGallery(opts) {
  const {
    tiles = [],
    outputPath,
    cols = 3,
    rows = 3,
    cellWidth = 400,
    cellHeight = 250,
    gutter = 12,
    background = '#FFFFFF',
    jpegQuality = 80,
  } = opts || {};

  if (!outputPath) throw new Error('composeGallery: outputPath required');
  const sharp = getSharp();
  if (!sharp) throw new Error('composeGallery: sharp not installed');

  const totalCells = cols * rows;
  const canvasWidth = cols * cellWidth + (cols - 1) * gutter;
  const canvasHeight = rows * cellHeight + (rows - 1) * gutter;

  const tilesToUse = tiles.slice(0, totalCells);
  const usedPaths = [];
  const skipped = [];
  const composites = [];

  for (let i = 0; i < tilesToUse.length; i++) {
    const tile = tilesToUse[i] || {};
    const tilePath = tile.path;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const left = col * (cellWidth + gutter);
    const top = row * (cellHeight + gutter);

    if (!tilePath) {
      skipped.push({ path: null, reason: 'no path' });
      continue;
    }
    if (!fs.existsSync(tilePath)) {
      skipped.push({ path: tilePath, reason: 'missing' });
      continue;
    }

    try {
      const buf = fs.readFileSync(tilePath);
      const img = sharp(buf);
      const meta = await img.metadata();
      const imgW = meta.width || 0;
      const imgH = meta.height || 0;
      if (!imgW || !imgH) {
        skipped.push({ path: tilePath, reason: 'no metadata' });
        continue;
      }

      // Determine crop region: caller-supplied cropTop/cropHeight (from vision
      // judge coords) take priority; otherwise default to top-600.
      const requestedTop = clampInt(tile.cropTop, 0, imgH - 1, 0);
      const defaultHeight = Math.min(600, imgH - requestedTop);
      const requestedHeight = clampInt(tile.cropHeight, 1, imgH - requestedTop, defaultHeight);

      // Resize after extract so the crop region maps to the cell.
      const cellBuf = await sharp(buf)
        .extract({ left: 0, top: requestedTop, width: imgW, height: requestedHeight })
        .resize(cellWidth, cellHeight, { fit: 'cover', position: 'top' })
        .jpeg({ quality: jpegQuality, mozjpeg: true })
        .toBuffer();

      composites.push({ input: cellBuf, left, top });
      usedPaths.push(tilePath);
    } catch (err) {
      skipped.push({ path: tilePath, reason: 'process error: ' + (err && err.message ? err.message : String(err)) });
    }
  }

  // Build the canvas and composite all successful cells onto it.
  const canvas = sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background,
    },
  });

  const outBuf = await canvas
    .composite(composites)
    .jpeg({ quality: jpegQuality, mozjpeg: true })
    .toBuffer();

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outBuf);

  return {
    outputPath,
    bytes: outBuf.length,
    usedPaths,
    skipped,
    canvasWidth,
    canvasHeight,
  };
}

module.exports = { composeGallery };
