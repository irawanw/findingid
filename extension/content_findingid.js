'use strict';
// Runs on finding.id pages only.
// Two responsibilities:
//   1. Keep the background service worker alive via an open port (open port = no idle kill).
//   2. When the user submits a search, relay the event so the service worker starts
//      polling for priority jobs immediately instead of waiting for the 1-minute alarm.

let port = null;

function connect() {
  try {
    port = chrome.runtime.connect({ name: 'findingid-page' });
    port.onDisconnect.addListener(() => {
      port = null;
      // Service worker was killed — reconnect so it wakes back up
      setTimeout(connect, 1500);
    });
  } catch (e) {
    setTimeout(connect, 2000);
  }
}

connect();

// Relay search events from the finding.id page to the service worker
window.addEventListener('message', (evt) => {
  if (evt.source !== window) return;
  if (!evt.data?.__fid_search) return;
  port?.postMessage({ type: 'SEARCH_TRIGGERED', query: evt.data.query || '' });
});
