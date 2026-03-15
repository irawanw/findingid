'use strict';
const cache = require('./cache');

const REDIS_KEY   = 'fid:affiliate:session';
const GQL_URL     = 'https://affiliate.shopee.co.id/api/v3/gql?q=productOfferLinks';
const BATCH_SIZE  = 50;

const GQL_QUERY = `
  query batchGetProductOfferLink (
    $sourceCaller: SourceCaller!
    $productOfferLinkParams: [ProductOfferLinkParam!]!
    $advancedLinkParams: AdvancedLinkParams
  ){
    productOfferLinks(
      productOfferLinkParams: $productOfferLinkParams,
      sourceCaller: $sourceCaller,
      advancedLinkParams: $advancedLinkParams
    ) {
      itemId
      shopId
      productOfferLink
    }
  }
`;

// ── Session storage ───────────────────────────────────────────────

async function saveSession(cookie, csrfToken) {
  // Store raw string without TTL — session is valid until user clears it
  const val = JSON.stringify({ cookie, csrfToken, updatedAt: new Date().toISOString() });
  await cache.getClient().set(REDIS_KEY, val);
}

async function loadSession() {
  const raw = await cache.getClient().get(REDIS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function clearSession() {
  await cache.getClient().del(REDIS_KEY);
}

// ── Core API call ─────────────────────────────────────────────────

// items: [{ itemId: string, shopId: number }]
// Returns: [{ itemId, shopId, productOfferLink }]
async function fetchAffiliateLinks(items, session) {
  const body = JSON.stringify({
    operationName: 'batchGetProductOfferLink',
    query: GQL_QUERY,
    variables: {
      productOfferLinkParams: items.map(({ itemId, shopId }) => ({
        itemId: String(itemId),
        shopId: Number(shopId),
        trace: '',
      })),
      sourceCaller: 'WEB_SITE_CALLER',
      advancedLinkParams: { subId1: '', subId2: '', subId3: '', subId4: '', subId5: '' },
    },
  });

  const headers = {
    'content-type':           'application/json; charset=UTF-8',
    'affiliate-program-type': '1',
    'cookie':                 session.cookie,
  };
  if (session.csrfToken) headers['csrf-token'] = session.csrfToken;

  const resp = await fetch(GQL_URL, { method: 'POST', headers, body });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Affiliate API HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = await resp.json();
  const links = json?.data?.productOfferLinks;
  if (!Array.isArray(links)) {
    throw new Error(`Unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return links;
}

// ── Batch generate for DB products ───────────────────────────────

// Parses shopId from product link: https://shopee.co.id/product/{shopId}/{itemId}
function parseShopId(link) {
  if (!link) return null;
  const m = link.match(/\/product\/(\d+)\/\d+/);
  return m ? Number(m[1]) : null;
}

// products: [{ id, source_item_id, link }]
// Returns: { updated, failed, sessionExpired }
async function generateForProducts(products, session) {
  // Filter to Shopee products with itemId + parseable shopId
  const eligible = products
    .map(p => ({ dbId: p.id, itemId: p.source_item_id, shopId: parseShopId(p.link) }))
    .filter(p => p.itemId && p.shopId);

  const results = { updated: 0, failed: 0, sessionExpired: false };
  if (!eligible.length) return results;

  // Process in batches
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    try {
      const links = await fetchAffiliateLinks(batch, session);
      const linkMap = new Map(links.map(l => [String(l.itemId), l.productOfferLink]));

      for (const item of batch) {
        const affLink = linkMap.get(String(item.itemId));
        if (affLink) {
          results.updated++;
          // Return the mapping for the caller to persist
          item.affiliateLink = affLink;
        } else {
          results.failed++;
        }
      }
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized')) {
        results.sessionExpired = true;
        results.failed += batch.length;
        break;
      }
      console.error('[affiliate] batch error:', msg);
      results.failed += batch.length;
    }
  }

  // Attach affiliateLink back onto original products array for caller
  const byDbId = new Map(eligible.map(e => [e.dbId, e]));
  for (const p of products) {
    const e = byDbId.get(p.id);
    if (e?.affiliateLink) p.affiliateLink = e.affiliateLink;
  }

  return results;
}

module.exports = { saveSession, loadSession, clearSession, fetchAffiliateLinks, generateForProducts };
