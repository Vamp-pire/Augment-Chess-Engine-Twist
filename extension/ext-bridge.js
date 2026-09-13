// Tiny ISOLATED-world bridge (2026-09-12): the rest of this extension's
// content scripts were just discovered to have been running in the
// ISOLATED world this whole time (Manifest V3's default when no "world" is
// specified) -- confirmed live: window.Worker in the page's own MAIN world
// was still the untouched native constructor even with ai-override.js's
// `window.Worker = new Proxy(...)` supposedly in place, because isolated
// and main worlds have completely separate `window` objects (only the DOM
// is shared, not JS object references). That means the AI-override feature
// likely never actually intercepted the site's aiWorker.js at all, in any
// game, ever -- everything downstream (Stockfish hybrid routing, NNUE
// eval, our own engine) was unreachable dead code from the page's
// perspective. Fixed by moving every content script to "world": "MAIN" in
// manifest.json so they share the page's real `window`.
//
// The one thing MAIN-world scripts lose access to is chrome.runtime (and
// therefore chrome.runtime.getURL, used by content.js/nnue.js/
// stockfishClient.js/analysis.js to build chrome-extension:// URLs for
// icons, the NNUE weights file, the Stockfish bridge iframe, and the search
// worker script). This file stays in the ISOLATED world (no "world" key,
// document_start, runs before anything needs it) purely to stash the
// extension's own base URL somewhere the MAIN-world scripts CAN still read
// it -- a DOM dataset attribute, since the DOM tree (unlike `window`) is
// shared across both worlds.
document.documentElement.dataset.augExtBase = chrome.runtime.getURL("");

// Stockfish bridge relay (rewritten 2026-09-13, replacing a hidden iframe --
// see background.js's comment for the full history of why the iframe
// approach needed replacing: an unexplained postMessage handshake failure
// plus a separate DOM-pruning issue, both structural consequences of
// embedding a chrome-extension:// document inside someone else's page).
// The bridge now lives in a chrome.offscreen document owned by background.js,
// reachable only via chrome.runtime messaging -- which MAIN-world
// stockfishClient.js can't use directly (chrome.runtime is unavailable
// there, same reason this file exists at all -- see the comment above). This
// file is the relay: it listens for a same-page window.postMessage from the
// MAIN world (window.postMessage IS delivered across isolated/main worlds of
// the same page, unlike direct JS object access) and forwards it over
// chrome.runtime.sendMessage to background.js, then relays the reply back
// the same way.
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || event.data.target !== "aug-stockfish-relay-request") return;
  const { reqId, payload } = event.data;
  chrome.runtime.sendMessage({ target: "stockfish-bridge-request", payload }, (response) => {
    window.postMessage({ target: "aug-stockfish-relay-response", reqId, response }, window.location.origin);
  });
});
