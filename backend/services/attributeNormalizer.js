'use strict';

// ================================================================
// Attribute Normalizer
//
// Converts raw attributes_json [{name, value}] from Shopee/Tokopedia
// into standardized [{key, value}] with canonical key names and
// normalized value formats.
//
// Rule-based only — attribute keys from marketplaces are predictable
// enough that LLM is unnecessary overhead here.
// ================================================================

const { normalizeAttrKey, normalizeAttrValue } = require('./taxonomy');

/**
 * Normalize a raw attributes array.
 *
 * @param {string|Array} attrsJson  — raw attributes_json
 * @returns {Array<{key: string, value: string}>}
 *   - Only includes attrs with recognized canonical keys
 *   - Deduplicates by key (keeps first occurrence)
 *   - Values are normalized (units, capitalization, etc.)
 */
function normalizeAttributes(attrsJson) {
  let attrs = [];
  try {
    attrs = typeof attrsJson === 'string'
      ? JSON.parse(attrsJson)
      : (attrsJson || []);
  } catch (_) { return []; }

  if (!Array.isArray(attrs) || !attrs.length) return [];

  const seen   = new Set();
  const result = [];

  for (const a of attrs) {
    const rawKey = a.name || a.key || '';
    const rawVal = String(a.value || a.val || '').trim();
    if (!rawKey || !rawVal || rawVal === '-' || rawVal === 'N/A') continue;

    const canonKey = normalizeAttrKey(rawKey);

    // Unknown key — keep raw but only if it looks meaningful
    // (not too long, not a full sentence)
    const key = canonKey || (rawKey.length <= 40 ? rawKey : null);
    if (!key) continue;

    // Dedup by canonical key (keeps first, which is usually the most specific)
    if (seen.has(key)) continue;
    seen.add(key);

    const value = canonKey
      ? normalizeAttrValue(canonKey, rawVal)
      : rawVal;

    result.push({ key, value });
  }

  return result;
}

/**
 * Extract a specific attribute by canonical key name.
 * Returns the value string or null.
 *
 * @param {Array<{key, value}>} normalized  — output of normalizeAttributes()
 * @param {string}              key         — canonical key e.g. "RAM", "Baterai"
 */
function getAttr(normalized, key) {
  const found = normalized.find(a => a.key === key);
  return found?.value || null;
}

/**
 * Merge normalized attributes with normalized variant attrs.
 * Variant attrs (per-SKU) take precedence over product-level attrs
 * only for dimension-type keys (Warna, Ukuran, Penyimpanan, RAM).
 *
 * Use this to build a complete spec set for a variant's product page.
 *
 * @param {Array<{key,value}>}  productAttrs  — from normalizeAttributes()
 * @param {Object}              variantAttrs  — from normalizeVariants()[i].attrs
 * @returns {Array<{key,value}>}
 */
function mergeAttrs(productAttrs, variantAttrs) {
  const result = [];
  const seen   = new Set();

  // Variant attrs first (higher priority for dimension keys)
  for (const [k, v] of Object.entries(variantAttrs || {})) {
    if (!seen.has(k)) {
      seen.add(k);
      result.push({ key: k, value: v });
    }
  }

  // Product-level attrs — skip if variant already set same dimension
  for (const a of (productAttrs || [])) {
    if (!seen.has(a.key)) {
      seen.add(a.key);
      result.push(a);
    }
  }

  return result;
}

module.exports = { normalizeAttributes, getAttr, mergeAttrs };
