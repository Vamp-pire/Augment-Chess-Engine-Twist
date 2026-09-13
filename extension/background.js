// Background service worker (2026-09-13): hosts the Stockfish bridge via
// chrome.offscreen instead of the old hidden-iframe-in-the-page approach.
//
// Why the switch: the iframe approach (an extension-origin
// stockfish-bridge.html embedded via a content-script-created <iframe>,
// talking to the page over window.postMessage) turned out fragile in ways
// never fully root-caused after a full day of live debugging --
// - once the surrounding content scripts moved to "world": "MAIN" (needed
//   so window.Worker/window.AugmentEngine etc. are actually visible to the
//   real page -- see ext-bridge.js's older comments for that saga), the
//   bridge iframe's OWN internal "ready" postMessage handshake to its
//   parent stopped arriving, despite the iframe script provably running
//   fine (confirmed by opening it standalone) and postMessage/
//   addEventListener working fine on the page in general.
// - separately, appending the iframe to <html> got it silently pruned by
//   something on the live page within seconds-to-minutes (moving it under
//   <body> avoided that specific issue, but the underlying fragility --
//   "a chrome-extension:// document embedded in someone else's DOM" -- is
//   structural, not something either fix actually addresses).
// chrome.offscreen is the official MV3-supported mechanism for exactly this
// use case (DOM/Worker access a service worker itself doesn't have) --  the
// resulting document isn't part of any page's DOM at all, so page cleanup
// logic can't touch it, and communication goes over chrome.runtime message
// passing instead of window.postMessage, sidestepping the handshake mystery
// entirely rather than working around one specific symptom of it.
// Guards against a real race: two concurrent callers (e.g. a live move
// request and a review-panel query firing close together) could otherwise
// both see "no offscreen document yet" and both call createDocument(),
// which throws on the second call ("Only a single offscreen document is
// allowed"). Setting this promise SYNCHRONOUSLY, before any `await` yields
// control, means any call arriving while creation is in flight sees it
// already set and awaits the same promise instead of racing.
let ensureOffscreenPromise = null;

function ensureOffscreenDocument() {
  if (!ensureOffscreenPromise) {
    ensureOffscreenPromise = (async () => {
      const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (existing.length > 0) return;
      await chrome.offscreen.createDocument({
        url: "stockfish-bridge.html",
        reasons: ["WORKERS"],
        justification: "Runs the Stockfish WASM engine in a background worker pool for move analysis."
      });
    })().catch((err) => {
      ensureOffscreenPromise = null; // let a later call retry instead of staying permanently broken
      throw err;
    });
  }
  return ensureOffscreenPromise;
}

// Relay: ext-bridge.js (the one ISOLATED-world content script with
// chrome.runtime access -- MAIN-world scripts don't have it, same reason
// ext-bridge.js already exists) sends { target: "stockfish-bridge-request",
// payload } here for every stockfishClient.js call. This ensures the
// offscreen document exists, forwards the payload to it, and relays its
// response back via sendResponse.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "stockfish-bridge-request") return false;
  (async () => {
    try {
      await ensureOffscreenDocument();
      const response = await chrome.runtime.sendMessage({ target: "stockfish-bridge-exec", payload: message.payload });
      sendResponse(response);
    } catch (err) {
      sendResponse({ error: String(err?.message || err) });
    }
  })();
  return true; // keep the message channel open for the async sendResponse above
});
