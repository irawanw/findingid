'use strict';
/**
 * Per-variant discount utility.
 * Rule: only compare a variant's price_before vs its own price.
 *       NEVER compare variant A's price_before vs variant B's price.
 */

/**
 * Parse variants_json safely.
 */
function parseVariants(variants_json) {
  if (!variants_json) return [];
  try {
    const v = typeof variants_json === 'string' ? JSON.parse(variants_json) : variants_json;
    return Array.isArray(v) ? v : [];
  } catch (_) { return []; }
}

/**
 * Find the variant with the biggest (price_before → price) drop.
 * Returns { pct, price, price_before, name } or null if no valid discount.
 */
function bestVariantDiscount(variants_json) {
  const variants = parseVariants(variants_json);
  let best = null;
  for (const v of variants) {
    const price  = Number(v.price);
    const before = Number(v.price_before);
    if (!price || !before || before <= price) continue;
    const pct = Math.round((1 - price / before) * 100);
    if (pct < 1) continue;
    if (!best || pct > best.pct) {
      best = { pct, price, price_before: before, name: v.name || '' };
    }
  }
  return best; // null if no variant has a valid price_before > price
}

module.exports = { bestVariantDiscount, parseVariants };
