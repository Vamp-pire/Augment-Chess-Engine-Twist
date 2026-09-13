// Runs inside stockfish-bridge.html, now loaded as a chrome.offscreen
// document (created by background.js) instead of a hidden iframe embedded in
// the page (2026-09-13 rewrite -- see background.js's comment for the full
// why: the iframe-in-the-page approach had an unexplained postMessage
// handshake failure plus a separate DOM-pruning issue, both structural
// consequences of embedding a chrome-extension:// document inside someone
// else's page). An offscreen document is still just an extension-origin page
// (same reason a Worker pointing at chrome-extension://... can only be
// constructed from one of these, not a content script -- re-confirmed live
// 2026-09-08 -- and a Blob-URL worker inherits the PAGE's own CSP, blocking
// WASM compilation on this site's CSP), but now communicates over
// chrome.runtime message passing instead of window.postMessage -- background
// error/logging goes to this document's own devtools console, inspectable
// via chrome://extensions' (or edge://extensions') "service worker"/inspect
// views link, no forwarding hack needed.
//
// This file owns the actual worker pool and UCI protocol; the content-script
// side (stockfishClient.js, relayed through ext-bridge.js and background.js)
// just calls queryStockfish/setInstanceCount and awaits the reply.
(function () {
  "use strict";

  const DEFAULT_INSTANCE_COUNT = 1;
  const MAX_INSTANCES = 4;
  let instanceCount = DEFAULT_INSTANCE_COUNT;
  let workers = [];
  let queue = [];

  function spawnWorker() {
    const scriptUrl = chrome.runtime.getURL("stockfish/stockfish-18-lite-single.js");
    const wasmUrl = chrome.runtime.getURL("stockfish/stockfish-18-lite-single.wasm");
    // Same hash-fragment protocol this build's worker code path actually
    // reads its wasm URL from (see stockfishClient.js's history/comments).
    return new Worker(scriptUrl + "#" + encodeURIComponent(wasmUrl));
  }

  function ensurePoolSize() {
    while (workers.length < instanceCount) {
      workers.push({ worker: spawnWorker(), busy: false });
    }
    while (workers.length > instanceCount) {
      const idleIndex = workers.findIndex((w) => !w.busy);
      if (idleIndex === -1) break;
      workers[idleIndex].worker.terminate();
      workers.splice(idleIndex, 1);
    }
  }

  function setInstanceCount(n) {
    instanceCount = Math.max(1, Math.min(MAX_INSTANCES, Math.round(Number(n)) || 1));
    ensurePoolSize();
    pump();
    return instanceCount;
  }

  function parseScore(infoLine) {
    if (!infoLine) return null;
    const mateMatch = infoLine.match(/score mate (-?\d+)/);
    if (mateMatch) return Number(mateMatch[1]) > 0 ? 100000 - Number(mateMatch[1]) : -100000 - Number(mateMatch[1]);
    const cpMatch = infoLine.match(/score cp (-?\d+)/);
    return cpMatch ? Number(cpMatch[1]) : null;
  }

  function runTask(entry, task) {
    entry.busy = true;
    const worker = entry.worker;
    let lastInfo = null;
    function messageHandler(event) {
      const line = typeof event.data === "string" ? event.data : "";
      if (line.startsWith("info") && line.includes(" pv ")) lastInfo = line;
      if (line.startsWith("bestmove")) {
        cleanup();
        const parts = line.split(" ");
        task.resolve({ move: parts[1] === "(none)" ? null : parts[1], info: lastInfo, score: parseScore(lastInfo) });
      }
    }
    function errorHandler(err) {
      cleanup();
      task.resolve({ move: null, info: null, score: null, error: String(err?.message || err) });
    }
    function cleanup() {
      worker.removeEventListener("message", messageHandler);
      worker.removeEventListener("error", errorHandler);
      entry.busy = false;
      pump();
    }
    worker.addEventListener("message", messageHandler);
    worker.addEventListener("error", errorHandler);
    worker.postMessage("position fen " + task.fen);
    // movetime (2026-09-13, player-adjustable via content.js's live-settings
    // block): UCI accepts depth and movetime together -- the engine stops at
    // whichever limit it hits first, so this just gives an upper bound on
    // wall-clock time without needing to drop the depth target.
    worker.postMessage(
      "go depth " + (task.depth || 14)
      + (task.movetimeMs ? " movetime " + task.movetimeMs : "")
      + (task.searchmoves ? " searchmoves " + task.searchmoves : "")
    );
  }

  function pump() {
    ensurePoolSize();
    for (const entry of workers) {
      if (entry.busy) continue;
      const task = queue.shift();
      if (!task) break;
      runTask(entry, task);
    }
  }

  function queryStockfish(fen, depth, searchmoves, movetimeMs) {
    return new Promise((resolve) => {
      queue.push({ fen, depth, searchmoves, movetimeMs, resolve });
      pump();
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== "stockfish-bridge-exec") return false;
    const msg = message.payload;
    if (!msg || typeof msg !== "object") return false;
    if (msg.cmd === "query") {
      queryStockfish(msg.fen, msg.depth, msg.searchmoves, msg.movetimeMs).then((result) => sendResponse({ result }));
      return true; // async sendResponse
    }
    if (msg.cmd === "setInstanceCount") {
      sendResponse({ result: setInstanceCount(msg.n) });
      return false;
    }
    return false;
  });

  console.log("[증강체스엔진][stockfish-bridge] offscreen document ready");
})();
