// Thin relay to stockfish-bridge.html/js, now running as a chrome.offscreen
// document owned by background.js (2026-09-13 rewrite). See background.js's
// comment for the full history: this used to be a hidden iframe embedded
// directly in the page, which had an unexplained postMessage handshake
// failure plus a separate DOM-pruning issue -- both structural consequences
// of embedding a chrome-extension:// document inside someone else's page.
// The bridge itself (worker pool + UCI protocol) is unchanged and still
// lives in stockfish-bridge.js -- only the transport changed: this file
// can't call chrome.runtime directly (unavailable in this file's MAIN-world
// context -- see ext-bridge.js's comment), so it relays through ext-bridge.js
// via a same-page window.postMessage (delivered across isolated/main worlds
// of the same page, unlike direct JS object access), which then forwards
// over chrome.runtime.sendMessage to background.js and the offscreen
// document.
(function () {
  "use strict";

  let nextReqId = 1;
  const pending = new Map(); // reqId -> resolve

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.target !== "aug-stockfish-relay-response") return;
    const { reqId, response } = event.data;
    if (pending.has(reqId)) {
      pending.get(reqId)(response);
      pending.delete(reqId);
    }
  });

  function sendToBridge(payload) {
    const reqId = nextReqId++;
    return new Promise((resolve) => {
      pending.set(reqId, resolve);
      window.postMessage({ target: "aug-stockfish-relay-request", reqId, payload }, window.location.origin);
    });
  }

  // searchmoves (optional): restrict the search to one specific UCI move, to
  // get *that* move's evaluated score directly instead of just the overall
  // best move -- used to score a move that was actually played but wasn't
  // Stockfish's own top choice.
  // movetimeMs (optional, added 2026-09-13): player-adjustable think-time
  // cap for live play (see content.js's settings block) -- 0/undefined means
  // no cap, depth alone decides when the search stops.
  async function queryStockfish(fen, depth, searchmoves, movetimeMs) {
    const response = await sendToBridge({ cmd: "query", fen, depth, searchmoves, movetimeMs });
    if (response?.error) throw new Error(response.error);
    return response?.result ?? null;
  }

  let lastKnownInstanceCount = 1;
  async function setInstanceCount(n) {
    const response = await sendToBridge({ cmd: "setInstanceCount", n });
    if (response?.error) throw new Error(response.error);
    lastKnownInstanceCount = response?.result ?? lastKnownInstanceCount;
    return lastKnownInstanceCount;
  }

  function getInstanceCount() {
    return lastKnownInstanceCount;
  }

  window.__augStockfish = { queryStockfish, setInstanceCount, getInstanceCount };
})();
