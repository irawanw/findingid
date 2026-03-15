// ================================================================
// finding.id — Interceptor (MAIN world) v1.4
// ================================================================

(function () {
  'use strict';

  // Guard: manifest content_script runs at document_start; background.js also
  // injects dynamically on tab load. Prevent double-hooking fetch/XHR.
  if (window.__fid_hooked) {
    console.log('[fid:interceptor] already hooked, skipping re-inject');
    return;
  }
  window.__fid_hooked = true;

  // ilog not ready yet at this point — use raw postMessage after DOM is ready
  console.log('[fid:interceptor] ✅ MAIN world script loaded on', location.href);
  window.postMessage({ __fid_log: true, msg: '[interceptor] ✅ MAIN world loaded on ' + location.href }, '*');

  const PATTERNS = [
    /shopee\.co\.id\/api\/v4\/search\/search_items/i,
    /shopee\.co\.id\/api\/v2\/search_items/i,
    // pdp/get_pc and get_ratings are injected as relative URLs — match with or without domain
    /(?:shopee\.co\.id)?\/api\/v4\/pdp\/get_pc/i,
    /(?:shopee\.co\.id)?\/api\/v2\/item\/get_ratings/i,
    /gql\.tokopedia\.com\/graphql\/SearchProductV5Query/i,
    /gql\.tokopedia\.com\/graphql\/AceSearchProductV4Query/i,
    /rumah123\.com\/api/i,
    /olx\.co\.id\/api/i,
  ];

  function shouldCapture(url) {
    if (!url) return false;
    return PATTERNS.some(re => re.test(url));
  }

  function resolveUrl(input) {
    if (typeof input === 'string')  return input;
    if (input instanceof Request)   return input.url;
    if (input instanceof URL)       return input.href;
    return String(input || '');
  }

  function ilog(msg) {
    console.log('[fid:interceptor]', msg);
    window.postMessage({ __fid_log: true, msg: '[interceptor] ' + msg }, '*');
  }

  function relay(url, data) {
    ilog('📤 postMessage relay → ' + url);
    window.postMessage({ __fid: true, url, data }, '*');
  }

  // ── Hook fetch ──────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = resolveUrl(args[0]);
    const hit = shouldCapture(url);

    if (!hit) return origFetch.apply(this, args);

    ilog('fetch ✅ MATCH ' + url.slice(0, 120));

    // Tokopedia uses AbortController and cancels requests aggressively.
    // Chrome propagates the abort to response.clone()'s body stream, causing
    // "The user aborted a request." errors. Fix: strip the AbortSignal from
    // requests we capture so Chrome can't cancel the body read.
    // The network request still completes — only our copy is signal-free.
    let captureArgs = args;
    try {
      if (args[0] instanceof Request && args[0].signal) {
        captureArgs = [new Request(args[0], { signal: undefined }), ...args.slice(1)];
      } else if (args[1] && args[1].signal) {
        captureArgs = [args[0], { ...args[1], signal: undefined }];
      }
    } catch (e) {
      captureArgs = args; // fallback: use original args
    }

    const response = await origFetch.apply(this, captureArgs);
    ilog('fetch response status=' + response.status + ' url=' + url.slice(0, 80));

    response.clone().json()
      .then(data => {
        ilog('fetch JSON ok, top-level keys: ' + Object.keys(data).join(', '));
        relay(url, data);
      })
      .catch(err => {
        ilog('❌ fetch JSON parse failed: ' + err.message + ' url=' + url.slice(0, 80));
      });

    return response;
  };

  ilog('✅ fetch hooked');

  // ── Hook XHR ────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._fidUrl = String(url || '');
    origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this._fidUrl;
    const hit = shouldCapture(url);

    if (hit) {
      ilog('XHR ✅ MATCH ' + url.slice(0, 120));
      this.addEventListener('load', function () {
        ilog('XHR load status=' + this.status + ' bodyLen=' + this.responseText?.length);
        try {
          const data = JSON.parse(this.responseText);
          ilog('XHR JSON ok, top-level keys: ' + Object.keys(data).join(', '));
          relay(url, data);
        } catch (err) {
          ilog('❌ XHR JSON parse failed: ' + err.message);
        }
      });
    }
    origSend.apply(this, arguments);
  };

  ilog('✅ XHR hooked');

})();
