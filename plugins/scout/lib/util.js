#!/usr/bin/env node
/**
 * lib/util.js
 *
 * Shared helpers for the scout plugin.
 */

const fs = require('fs');
const crypto = require('crypto');

/**
 * Convert an arbitrary string into a filesystem/URL-safe slug.
 * Standardized at 60 chars so entity IDs produced at brief-write time
 * match paths generated at capture time.
 */
function slugify(str, maxLen = 60) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

/**
 * Synchronous sha256 content hash of a file as hex digest.
 * Returns null if the file can't be read.
 */
function contentHash(filePath) {
  if (!filePath) return null;
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (_) {
    return null;
  }
}

module.exports = { slugify, contentHash };
