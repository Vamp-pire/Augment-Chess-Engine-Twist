// Pure-JS NNUE inference for the extension -- the scaffold that lets bot
// play (or anything else in the extension) use the trained NNUE evaluator
// instead of/alongside engine.js's hand-coded evaluateState(). This does
// NOT wire NNUE into the live bot by default -- it only exposes
// window.__augNNUE.evaluate(...) as a pluggable evaluator, and engine.js's
// searchBestAction() accepts an optional options.evalFn to use it (see
// engine.js's "context.evalFn" comment). Something else has to actually
// pass that option for NNUE to affect play; until then this sits unused,
// same as flexibleBudget did before it had a caller.
//
// Mirrors nnue/encode.js (feature layout) and nnue/forward.js (the
// wide & deep forward pass -- see train.js's buildModel comment for why:
// direct linear path from raw input to output, summed with the 2-hidden-
// layer path, before the final tanh) exactly, since this MUST match
// whatever weights.json was trained with bit-for-bit or the loaded weights
// are meaningless. If either of those files' architecture changes, this
// has to change with it -- there is no shared source between the Node
// training pipeline and this browser copy.
(function () {
  "use strict";

  // `self` (not `window`) so this loads correctly both as a normal content
  // script (where self === window) and via importScripts() inside a Worker
  // (searchWorker.js -- window doesn't exist there at all).
  const engine = self.AugmentEngine;

  const STANDARD_TYPES = ["pawn", "knight", "bishop", "rook", "queen", "king"];
  const SPECIAL_TYPES = [
    "amazon", "cardinal", "pegasus", "assassin", "dragon",
    "cannon", "grasshopper", "hook", "herald", "camel", "alfil", "ferz", "eagle",
    "berserker", "magicGirl", "windmill", "trickster", "merchant",
    "knightmaster", "standardBearer", "idol", "siren", "reaper", "recruiter",
    "guard", "colossus", "bigRook"
  ];
  const ALL_TYPES = [...STANDARD_TYPES, ...SPECIAL_TYPES];
  const PIECE_INDEX = {};
  ALL_TYPES.forEach((type, i) => { PIECE_INDEX[type] = i; });
  const PLANE_COUNT = ALL_TYPES.length; // 33

  const FEATURE_NAMES = [
    "material", "exchange",
    "positionSelf", "positionEnemy",
    "kingSafetySelf", "kingSafetyEnemy",
    "pressureSelf", "pressureEnemy",
    "specialSelf", "specialEnemy",
    "bloodMoonSelf", "bloodMoonEnemy",
    "cardsSelf", "cardsEnemy",
    "campaignSelf", "campaignEnemy",
    "ultimatum",
    "persistentObjectivesSelf", "persistentObjectivesEnemy",
    "bonus", "tacticalSafety"
  ];
  const EXTRA_FEATURE_COUNT = FEATURE_NAMES.length; // 21

  // Card pool one-hot (added 2026-09-12) -- mirrors nnue/encode.js exactly,
  // see that file's comment for the full rationale (cardsSelf/cardsEnemy
  // above collapse a whole hand into one aggregate number; this gives the
  // network per-card signal instead). MUST match encode.js's
  // CARD_POOL_TYPES (and selfplay-worker.js's SELFPLAY_CARD_POOL) exactly.
  const CARD_POOL_TYPES = [
    "witchTrial", "vip", "disarm", "freeze", "poisonStun", "royalShield",
    "portalGun", "desperado", "encouragement", "severance", "inertia",
    "substitution", "switcheroo", "promotionRush", "charge", "bishopSnipe",
    "enPassantBang", "freeCastling"
  ];
  const CARD_POOL_INDEX = {};
  CARD_POOL_TYPES.forEach((effect, i) => { CARD_POOL_INDEX[effect] = i; });
  const CARD_ONEHOT_COUNT = CARD_POOL_TYPES.length * 2; // own + enemy

  // Layout: [board planes][card one-hot][21 named features] -- named
  // features stay LAST so a fixed-offset-from-the-end read (if anything ever
  // needs one) keeps working regardless of what's inserted before them.
  const BOARD_SIZE = PLANE_COUNT * 2 * 64;
  const INPUT_SIZE = BOARD_SIZE + CARD_ONEHOT_COUNT + EXTRA_FEATURE_COUNT;

  // Real boardState.deckSlots[color] entries here (not encode.js's compact
  // {effect,used,recovering} replay of them) -- same field names either way.
  function writeCardOneHot(input, offset, deckSlots, color) {
    const deck = deckSlots?.[color] || [];
    deck.forEach((card) => {
      if (!card || card.used || card.recovering) return;
      const idx = CARD_POOL_INDEX[card.effect];
      if (idx === undefined) return;
      input[offset + idx] = 1;
    });
  }

  // boardState here is the engine's OWN live state object (already has
  // .board, .mode, etc. set up by the caller's ongoing game/search) --
  // unlike nnue/encode.js's Node-side version, this doesn't need to
  // reconstruct a state from a bare board array, since callers in the
  // extension always already have a real boardState in hand.
  function encodeFromState(boardState, mover) {
    const c = engine.evaluateStateComponents(boardState, mover);
    if (c.terminal !== null) return null;
    const input = new Float32Array(INPUT_SIZE);
    const board = boardState.board;
    for (let r = 0; r < board.length; r++) {
      for (let col = 0; col < board[r].length; col++) {
        const p = board[r][col];
        if (!p) continue;
        const typeIdx = PIECE_INDEX[p.type];
        if (typeIdx === undefined) continue;
        const colorOffset = p.color === mover ? 0 : PLANE_COUNT;
        const square = r * 8 + col;
        input[(typeIdx + colorOffset) * 64 + square] = 1;
      }
    }
    const enemy = mover === "white" ? "black" : "white";
    writeCardOneHot(input, BOARD_SIZE, boardState.deckSlots, mover);
    writeCardOneHot(input, BOARD_SIZE + CARD_POOL_TYPES.length, boardState.deckSlots, enemy);

    const base = INPUT_SIZE - EXTRA_FEATURE_COUNT;
    FEATURE_NAMES.forEach((name, i) => { input[base + i] = c[name]; });
    return input;
  }

  function relu(x) { return x > 0 ? x : 0; }

  // kernel: {shape:[inDim,outDim], data:[...]}, bias: same shape as outDim or null
  function denseLayer(x, kernel, bias, activation) {
    const [inDim, outDim] = kernel.shape;
    const out = new Array(outDim).fill(0);
    for (let o = 0; o < outDim; o++) {
      let sum = bias ? bias.data[o] : 0;
      for (let i = 0; i < inDim; i++) sum += x[i] * kernel.data[i * outDim + o];
      out[o] = activation ? activation(sum) : sum;
    }
    return out;
  }

  // Raw tensor array as saved by train.js's model.getWeights() -- order is
  // [deep1_k, deep1_b, deep2_k, deep2_b, deepOut_k, wideOut_k]. deepOut/
  // wideOut use useBias:false (no additive constant, matching
  // evaluateState()'s own formula), so unlike a plain 3-Dense stack this is
  // 6 tensors that are NOT three kernel+bias pairs -- the last two are both
  // kernels. A weights file saved by the OLD (pre-2026-09-08) architecture
  // will have a [1]-shaped tensor 5 (a bias) instead of [4245,1] (wideOut's
  // kernel) -- loadWeights() checks for that and refuses rather than
  // silently running a nonsense forward pass against mismatched weights.
  function parseWeights(raw) {
    if (raw.length !== 6 || raw[5].shape.length !== 2 || raw[5].shape[0] !== INPUT_SIZE) {
      throw new Error("nnue.js: weights.json doesn't match the expected wide & deep shape (stale/incompatible file? expected input size " + INPUT_SIZE + ", got " + raw?.[5]?.shape?.[0] + ")");
    }
    return { k1: raw[0], b1: raw[1], k2: raw[2], b2: raw[3], kDeepOut: raw[4], kWideOut: raw[5] };
  }

  function forward(weights, input) {
    const h1 = denseLayer(input, weights.k1, weights.b1, relu);
    const h2 = denseLayer(h1, weights.k2, weights.b2, relu);
    const deepOut = denseLayer(h2, weights.kDeepOut, null, null)[0];
    const wideOut = denseLayer(input, weights.kWideOut, null, null)[0];
    return Math.tanh(deepOut + wideOut);
  }

  let weightsPromise = null;
  function ensureLoaded() {
    if (!weightsPromise) {
      // chrome.runtime unavailable in this file's MAIN-world context -- see
      // ext-bridge.js/content.js's comments on the isolated/main world fix.
      weightsPromise = fetch((document.documentElement.dataset.augExtBase || "") + "model/nnue-weights.json")
        .then((r) => r.json())
        .then(parseWeights);
    }
    return weightsPromise;
  }

  let cachedWeights = null;
  ensureLoaded().then((w) => { cachedWeights = w; }).catch((err) => {
    console.warn("[증강체스엔진] NNUE weights failed to load, evaluate() will return null until fixed:", err);
  });

  // Returns a tanh-squashed score in [-1, 1] from `mover`'s perspective
  // (positive = good for mover), or null if weights aren't loaded yet or
  // the position is terminal (callers should fall back to
  // engine.evaluateState()'s own terminal handling in that case -- this
  // never tries to score a checkmate/no-survivor position itself).
  function evaluate(boardState, mover) {
    if (!cachedWeights) return null;
    const input = encodeFromState(boardState, mover);
    if (input === null) return null;
    return forward(cachedWeights, input);
  }

  // Rough, unvalidated calibration constant to bring evaluate()'s tanh
  // output ([-1, 1]) into roughly the same ballpark as evaluateState()'s
  // own scale (its terminal/forced-move bonuses are in the low thousands,
  // e.g. the 2500 in engine.js's stalemate-adjacent scoring, and ordinary
  // midgame material-driven scores are typically tens to low hundreds).
  // This has NOT been tuned against real game outcomes -- it only needs to
  // be "close enough" for minimax's relative move-ordering to make sense,
  // not exact, but it should be revisited (e.g. by comparing move choices
  // against evaluateState() on the same positions) before this is actually
  // relied on for real play strength.
  const SCORE_SCALE = 100;

  // Ready-to-pass options.evalFn adapter for searchBestAction: falls back
  // to engine.evaluateState() whenever NNUE can't answer (weights still
  // loading, or a terminal position -- evaluate() deliberately punts on
  // both rather than guessing), so this is always safe to plug in even
  // before ensureLoaded() resolves.
  function evaluateForSearch(boardState, aiColor) {
    const nnueScore = evaluate(boardState, aiColor);
    if (nnueScore === null) return engine.evaluateState(boardState, aiColor);
    return nnueScore * SCORE_SCALE;
  }

  self.__augNNUE = { ensureLoaded, evaluate, evaluateForSearch, INPUT_SIZE, FEATURE_NAMES };
})();
