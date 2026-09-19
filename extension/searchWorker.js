// Runs in its own thread. Loads the same engine.js used everywhere else and
// searches a SUBSET of the root candidate actions handed to it -- splitting
// root moves across N of these workers and taking the best result across all
// of them gives (roughly) an N-times speedup with no change to the search
// algorithm itself, since alpha-beta over a subset of moves is still valid
// (just without benefiting from cross-subset pruning).
importScripts("engine.js", "nnue.js");

const engine = self.AugmentEngine;

// useNnue (2026-09-09): review's own opt-in toggle for NNUE vs the
// hand-coded evaluateState(), separate from ai-override.js's toggle for
// live bot play. self.__augNNUE comes from nnue.js (importScripts above --
// works here the same as in a normal content script since nnue.js reads
// `self.AugmentEngine`/sets `self.__augNNUE`, not `window.*`, specifically
// so it works in both places). evaluateForSearch() already falls back to
// evaluateState() on its own (weights not loaded yet, or a terminal
// position), so passing it as evalFn is always safe even before NNUE
// finishes loading.
self.onmessage = (event) => {
  const { requestId, state, actionSubset, color, depth, timeMs, useNnue, nnueModel, limits } = event.data;
  try {
    // Model choice lives in the page (localStorage); the page tells each
    // worker which one to use per request, since workers can't read it.
    if (nnueModel && self.__augNNUE) self.__augNNUE.setModel(nnueModel, { persist: false });
    engine.setWorkerBoardDimensions(state);
    const options = useNnue && self.__augNNUE ? { evalFn: self.__augNNUE.evaluateForSearch } : {};
    if (limits) options.limits = limits;
    const result = engine.searchBestAction(state, actionSubset, color, depth, timeMs, options);
    self.postMessage({ requestId, ok: true, result });
  } catch (err) {
    self.postMessage({ requestId, ok: false, error: String(err && err.message || err) });
  }
};
