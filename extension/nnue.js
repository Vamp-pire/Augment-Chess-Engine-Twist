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
//
// 2026-09-30: per-model input dimensions. Every model up to "squall/
// hurricane/gale" was trained on the same 5509-wide ("legacy") input.
// nnue/encode.js has since grown an opt-in FULL_PIECE_STATE (per-piece
// status planes) and STAR_TOTAL_FEATURES (deck star-total scalars) layer
// that together produce a 15239-wide ("fullstate") input -- see that
// file's own comments for exactly what those add and why they're opt-in
// there. MODELS entries now declare which layout they were trained with
// via `dims` ("legacy" | "fullstate"), and encodeFromState/parseWeights
// key off that per model instead of assuming one global INPUT_SIZE, so
// both widths can be loaded side by side. `INPUT_SIZE` (the plain export)
// stays the legacy 5509 for backward compatibility with anything that
// read it as a constant before this change (nnue-parity.js's global
// sanity check in particular).
(function () {
  "use strict";

  // `self` (not `window`) so this loads correctly both as a normal content
  // script (where self === window) and via importScripts() inside a Worker
  // (searchWorker.js -- window doesn't exist there at all).
  const engine = self.AugmentEngine;

  // 2026-09-19: mirrors nnue/encode.js ALL_TYPES exactly (40 planes).
  const ALL_TYPES = [
    "pawn", "knight", "bishop", "rook", "queen", "king", "amazon", "cardinal", "pegasus", "assassin",
    "dragon", "cannon", "grasshopper", "hook", "herald", "camel", "alfil", "ferz", "eagle", "berserker",
    "magicGirl", "windmill", "trickster", "merchant", "knightmaster", "standardBearer", "idol", "siren",
    "reaper", "recruiter", "guard", "colossus", "bigRook", "hedgehog", "princess", "campfire", "paladin",
    "octopus", "clockwork", "parrot"
  ];
  const PIECE_INDEX = {};
  ALL_TYPES.forEach((type, i) => { PIECE_INDEX[type] = i; });
  const PLANE_COUNT = ALL_TYPES.length; // 40

  // Per-piece STATE fields (2026-09-30 port, opt-in per model via `dims:
  // "fullstate"`) -- mirrors nnue/encode.js's BOOL_FIELDS/NUMERIC_FIELDS/
  // ENUM_FIELD_VALUES exactly (see that file's comments for what each one
  // means and why it's there). `p` here is the extension's own live Piece
  // object, which already uses these real field names directly (no t/c-style
  // aliasing to undo, unlike encode.js's compacted self-play records).
  const BOOL_FIELDS = [
    "defected", "evasion", "explosive", "fileSurgeSecondMove", "frenzyExtraMove",
    "frozen", "ghost", "ironMonarchExtraMove", "locustUsed", "madHorseSecondMove",
    "noPromotion", "platformExtraMove", "promotedFromPawn", "protected",
    "queensGambitProtection", "queensGambitPreviousProtected",
    "queuedBackwardKnightTurn", "rookLiftSecondMove", "shielded",
    "specialPromotionUsed", "thiefSecondMove", "twinSwapPending",
    "undergroundBunker", "crownBearer", "crownRoyal", "regencyHeir",
    "heraldJumpUnlocked", "bribed", "coolGuyCapturedLast",
    "quantumFirstObservationFails", "checkerChainCapture", "moved",
    "bloodCurse", "callingCard", "quantum", "lastResistance",
    "coronationProtection", "frozenByCard", "logDir",
    "repositionSecondMoveUsed",
    "tricksterMoveType"
  ];
  const BOOL_FIELD_INDEX = {};
  BOOL_FIELDS.forEach((f, i) => { BOOL_FIELD_INDEX[f] = i; });

  const NUMERIC_FIELDS = [
    "hp", "maxHp", "ammo", "maxAmmo", "mana", "maxMana", "poisonStunTurns",
    "bearRetaliationsRemaining", "capturesMade", "reaperCaptures",
    "necromancyRemaining", "bribedRemaining", "cardNoCaptureUntil",
    "freshNoCaptureUntil", "heraldJumpLockTurn", "quantumNoCaptureUntil",
    "coronationProtectionRemaining", "frozenByCardRemaining",
    "logDirDr", "logDirDc",
    "crownTokenCount", "imperialMoveCount", "queuedKnightExtraMoveCount"
  ];
  const NUMERIC_FIELD_INDEX = {};
  NUMERIC_FIELDS.forEach((f, i) => { NUMERIC_FIELD_INDEX[f] = i; });
  const NUMERIC_NORMALIZER = 20;

  const ENUM_FIELD_VALUES = {
    monoShade: ["light", "dark"],
    timePhase: ["past", "future"],
    windmillMode: ["rook", "bishop"],
    spyOwner: ["white", "black"],
    poisonStunColor: ["white", "black"],
    hiddenFrom: ["white", "black"]
  };
  const ENUM_FIELDS = Object.keys(ENUM_FIELD_VALUES);
  const ENUM_BIT_INDEX = {};
  let enumBitCursor = 0;
  ENUM_FIELDS.forEach((field) => {
    ENUM_FIELD_VALUES[field].forEach((value) => {
      ENUM_BIT_INDEX[`${field}:${value}`] = enumBitCursor;
      enumBitCursor += 1;
    });
  });
  const ENUM_BIT_COUNT = enumBitCursor; // 12

  const ATTR_BIT_COUNT = BOOL_FIELDS.length + NUMERIC_FIELDS.length + ENUM_BIT_COUNT; // 76

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
    "alekhineMachineGun", "amazon", "apprenticeKnights", "armistice", "babyBear", "basicTraining", "bigRook",
    "binaMate", "bishopSnipe", "blackBox", "blackMagic", "blueJeans", "breakthroughOrder", "callingCard",
    "canceling", "chain", "chameleonMutation", "charge", "checker", "chimera", "cleanupPieces",
    "cleanupSacrifice", "clonePassive", "conversion", "cornerKick", "coronation", "deathSquad", "democracy",
    "desperado", "dice", "disarm", "dutch", "eagle", "emergencyEvacuation", "emptyLunchbox", "enPassantBang",
    "encouragement", "evasion", "exhaustion", "exile", "fanaticalRitual", "feudalContract", "fianchetto",
    "fieldPromotion", "fileSurge", "finalWeapon", "fleetingDream", "freeCastling", "freeMove", "freeze",
    "frenzy", "frontlineResponse", "gale", "genevaConvention", "ghost", "gomoku", "guard", "hallucination",
    "holdout", "homecoming", "hook", "horde", "horseRiding", "hypocrisy", "icbm", "iceSheet", "idol",
    "imperialStudies", "inertia", "injury", "insight", "ironMonarch", "joker", "judgment", "kingOfTheHill",
    "knightmate", "lastResistance", "lobster", "localConscription", "loyalist", "madHorse", "martyrdom",
    "merchantGuild", "missionary", "mistakeCard", "mongolianGambit", "moving", "ordination", "othello",
    "otherworld", "overwhelm", "palace", "panic", "parry", "pawnConversion", "pawnStorm", "poisonedPawn",
    "portalGun", "promotionRush", "prophecy", "quantumMechanics", "queenAfterimage", "queenCavalry",
    "queensGambit", "racingKing", "randomRoulette", "reaper", "reformation", "relay", "religiousVictory",
    "replayMove", "reposition", "retreat", "reversePawns", "rookLift", "royalCommand", "royalShield",
    "ruleTicket", "sacrifice", "severance", "shotgunKing", "socialism", "spy", "stake", "submerge",
    "substitution", "suicideBomber", "summonColossus", "suspiciousPotion", "switcheroo", "taunt",
    "timeClumsyAttack", "timeIsMine", "timePhaseShift", "traitor", "trickster", "trojanHorse", "trolley",
    "twins", "ultimatum", "undergroundBunker", "underpromotion", "vanish", "vip", "vortex", "whiteBox",
    "windmill", "witchTrial", "wizard", "zugzwang", "qxe1", "nullification", "recurrence", "outpost",
    "killerKing", "majesty", "overtake", "leap", "vanguard", "infiltration", "reversal", "lastStand",
    "fastGrowth", "earlyPromotion", "bribe", "conscription", "barricade", "collapse", "highlander", "thief",
    "disassembly", "falseStart", "proficiency", "locustSwarm", "longEnPassant", "extinction", "symmetry",
    "brutus", "clockwork", "mutation", "parrot", "paladin", "octopus", "metal"
  ];
  const CARD_POOL_INDEX = {};
  CARD_POOL_TYPES.forEach((effect, i) => { CARD_POOL_INDEX[effect] = i; });
  const CARD_ONEHOT_COUNT = CARD_POOL_TYPES.length * 2; // own + enemy

  // Layout: [board planes][attr planes, fullstate only][card one-hot]
  // [star totals, fullstate only][21 named features] -- named features stay
  // LAST, attr planes go right after the board planes: exactly nnue/
  // encode.js's ordering (see that file's INPUT_SIZE comment), so a model
  // trained there with FULL_PIECE_STATE=1 [+ STAR_TOTAL_FEATURES=1] lines up
  // with what's computed here bit-for-bit.
  const BOARD_SIZE = PLANE_COUNT * 2 * 64;
  const STAR_NORMALIZER = 20;

  // "legacy" = every model shipped before 2026-09-30 (squall/hurricane/gale),
  // trained on encode.js's default (no opt-ins) 5509-wide input.
  // "fullstate" = encode.js with FULL_PIECE_STATE=1 and STAR_TOTAL_FEATURES=1
  // (matches the "확장 15,239차원 포팅" TODO item: 5120 board + 9728 attr +
  // 368 card + 2 star + 21 extra = 15239). PLY_FEATURE has no shipped model
  // yet, so it isn't wired here -- add it the same way if that changes.
  const LAYOUT_PRESETS = {
    legacy: { fullState: false, star: false },
    fullstate: { fullState: true, star: true }
  };
  function computeLayout(dims) {
    const flags = LAYOUT_PRESETS[dims] || LAYOUT_PRESETS.legacy;
    const attrBoardSize = flags.fullState ? ATTR_BIT_COUNT * 2 * 64 : 0;
    const cardOffset = BOARD_SIZE + attrBoardSize;
    const starOffset = cardOffset + CARD_ONEHOT_COUNT;
    const starCount = flags.star ? 2 : 0;
    const extraBase = starOffset + starCount;
    return { flags, attrBoardSize, cardOffset, starOffset, starCount, extraBase, inputSize: extraBase + EXTRA_FEATURE_COUNT };
  }
  // Legacy default, exported as the plain `INPUT_SIZE` constant below for
  // backward compatibility (tools/ci/nnue-parity.js's global sanity check
  // compares this against nnue/encode.js's own default-env INPUT_SIZE).
  const INPUT_SIZE = computeLayout("legacy").inputSize; // 5509

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

  // Star feature support data (tools/site-rules/card-catalog.json, bundled
  // as extension/site-rules/card-catalog.json) -- mirrors encode.js's
  // deckStarTotal() exactly, including its `?? 3` fallback for an unlisted
  // card. Loaded once, eagerly, regardless of which model is active (cheap,
  // ~5KB) so a later switch to a "fullstate" model never has to wait on it
  // mid-game. While it's still loading, encodeFromState() for a "fullstate"
  // model returns null (same "not ready yet, fall back to evaluateState()"
  // contract evaluate() already uses for weights-still-loading).
  let cardStars = null;
  let cardStarsState = "loading";
  fetch(extBase() + "site-rules/card-catalog.json")
    .then((r) => r.json())
    .then((data) => { cardStars = data; cardStarsState = "ready"; })
    .catch((err) => {
      cardStarsState = "error";
      console.warn("[증강체스엔진] card-catalog.json 로드 실패, fullstate 모델의 star 특징이 빠집니다:", err);
    });
  function deckStarTotal(deckSlots, color) {
    const deck = deckSlots?.[color] || [];
    return deck.reduce((sum, card) => sum + (card ? (cardStars?.[card.effect]?.stars ?? 3) : 0), 0);
  }

  // boardState here is the engine's OWN live state object (already has
  // .board, .mode, etc. set up by the caller's ongoing game/search) --
  // unlike nnue/encode.js's Node-side version, this doesn't need to
  // reconstruct a state from a bare board array, since callers in the
  // extension always already have a real boardState in hand.
  function encodeFromState(boardState, mover, dims = "legacy") {
    const c = engine.evaluateStateComponents(boardState, mover);
    if (c.terminal !== null) return null;
    const layout = computeLayout(dims);
    if (layout.flags.star && cardStarsState !== "ready") return null;

    const input = new Float32Array(layout.inputSize);
    const board = boardState.board;
    for (let r = 0; r < board.length; r++) {
      for (let col = 0; col < board[r].length; col++) {
        const p = board[r][col];
        if (!p) continue;
        const square = r * 8 + col;
        const isMoverPiece = p.color === mover;
        const typeIdx = PIECE_INDEX[p.type];
        if (typeIdx !== undefined) {
          const colorOffset = isMoverPiece ? 0 : PLANE_COUNT;
          input[(typeIdx + colorOffset) * 64 + square] = 1;
        }
        if (layout.flags.fullState) {
          const attrColorOffset = isMoverPiece ? 0 : ATTR_BIT_COUNT;
          const attrBase = BOARD_SIZE + attrColorOffset * 64;
          BOOL_FIELDS.forEach((field) => {
            if (p[field]) input[attrBase + BOOL_FIELD_INDEX[field] * 64 + square] = 1;
          });
          const numericBase = attrBase + BOOL_FIELDS.length * 64;
          NUMERIC_FIELDS.forEach((field) => {
            const v = p[field];
            if (typeof v === "number" && Number.isFinite(v)) {
              input[numericBase + NUMERIC_FIELD_INDEX[field] * 64 + square] = v / NUMERIC_NORMALIZER;
            }
          });
          const enumBase = numericBase + NUMERIC_FIELDS.length * 64;
          ENUM_FIELDS.forEach((field) => {
            const v = p[field];
            if (v === undefined || v === null) return;
            const bitIdx = ENUM_BIT_INDEX[`${field}:${v}`];
            if (bitIdx !== undefined) input[enumBase + bitIdx * 64 + square] = 1;
          });
        }
      }
    }
    const enemy = mover === "white" ? "black" : "white";
    writeCardOneHot(input, layout.cardOffset, boardState.deckSlots, mover);
    writeCardOneHot(input, layout.cardOffset + CARD_POOL_TYPES.length, boardState.deckSlots, enemy);

    if (layout.flags.star) {
      input[layout.starOffset] = deckStarTotal(boardState.deckSlots, mover) / STAR_NORMALIZER;
      input[layout.starOffset + 1] = deckStarTotal(boardState.deckSlots, enemy) / STAR_NORMALIZER;
    }

    const base = layout.inputSize - EXTRA_FEATURE_COUNT;
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
  // kernels. `expectedInputSize` is the caller's (ensureLoaded's) per-model
  // layout size -- a weights file trained at a different width (stale file,
  // or a "legacy" file loaded for a model declared "fullstate" or vice
  // versa) is refused here rather than silently running a nonsense forward
  // pass against mismatched weights.
  function parseWeights(raw, expectedInputSize) {
    if (raw.length !== 6 || raw[5].shape.length !== 2 || raw[5].shape[0] !== expectedInputSize) {
      throw new Error("nnue.js: weights.json doesn't match the expected wide & deep shape (stale/incompatible file? expected input size " + expectedInputSize + ", got " + raw?.[5]?.shape?.[0] + ")");
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

  // Selectable models. "squall/hurricane/gale" (2026-09-19/20, `dims:
  // "legacy"`, implicit) were trained on the 5509-wide input this file
  // encoded before 2026-09-30. `map` says how the tanh output becomes a
  // search score (same specs as nnue/match-two-models.js): "atanh<K>" =
  // K * atanh(out), "hybrid<K>" = engine.evaluateState + K * out (residual
  // net). No map = out * SCORE_SCALE.
  //   hurricane = depth-weighted labels (first "win" vs the hand-coded evaluator in the lab, re-check pending)
  //   gale     = residual net (search score minus hand-coded score)
  //
  // `dims: "fullstate"` models (15239-wide, per-piece state + deck star
  // totals -- see the LAYOUT_PRESETS comment above): "tempest" below is the
  // first one shipped (2026-09-30, fullstate-w64-l2s off the data branch).
  // NONE of the width-16/64/128/bootstrap experiments run so far have
  // "확실히" beaten the hand-coded depth-3 baseline in a real match yet
  // (all landed at Elo ~0, see TODO.md), so "tempest" stays a selectable
  // experiment like hurricane/gale, never DEFAULT_MODEL -- the
  // pre-approved rule for a fullstate model becoming the default is a
  // real match win first. To add another fullstate model: swap in its
  // trained weights.json under model/, add its own MODELS entry with
  // `dims: "fullstate"`, and add its filename to manifest.json's
  // web_accessible_resources.
  const MODELS = {
    squall: {
      label: "Squall", file: "model/nnue-squall.json",
      desc: "기본 모델입니다. 대국의 승패를 위주로 학습했고, 무난하고 안정적입니다."
    },
    hurricane: {
      label: "Hurricane (실험)", file: "model/nnue-hurricane.json", map: "atanh400",
      desc: "깊이 읽은 대국일수록 더 믿고 학습한 실험 모델입니다. 처음 테스트에서는 기본 평가보다 앞섰지만 재확인에서는 차이가 없었습니다."
    },
    gale: {
      label: "Gale (실험)", file: "model/nnue-gale.json", map: "hybrid300",
      desc: "기본 평가가 틀리는 부분만 보정하도록 학습한 실험 모델입니다. 아직 차이가 확인되지 않았습니다."
    },
    tempest: {
      label: "Tempest (실험, 15239차원)", file: "model/nnue-tempest.json",
      dims: "fullstate",
      desc: "기물 상태(HP/보호막/빙결 등)와 카드 star 총합까지 넣은 실험 모델입니다(fullstate-w64-l2s, 폭 64 + L2 0.00025). 검증 방향 일치율은 94.5%로 다른 모델보다 높지만, 실전 대국(핸드코딩 깊이 3, 200판)에서는 Elo +7 [-21, +35]로 통계적으로 구분되지 않습니다 -- 확실히 이기지 못했으므로 기본값이 아닌 선택 옵션입니다."
    }
  };
  const DEFAULT_MODEL = "squall";
  const MODEL_STORAGE_KEY = "augEngineNnueModel";

  function dimsFor(name) { return (MODELS[name] && MODELS[name].dims) || "legacy"; }
  function inputSizeFor(name) { return computeLayout(dimsFor(name)).inputSize; }

  // Base URL of the extension's files. In a page context that's the
  // data-attribute ext-bridge.js sets (chrome.runtime unavailable in this
  // file's MAIN-world context -- see ext-bridge.js/content.js's comments).
  // A Worker has no `document`, so derive it from the worker script's own
  // URL instead (searchWorker.js sits next to model/).
  function extBase() {
    if (typeof document !== "undefined") return document.documentElement.dataset.augExtBase || "";
    return self.location.href.replace(/[^/]*$/, "");
  }

  function readStoredModel() {
    try {
      const v = typeof localStorage !== "undefined" ? localStorage.getItem(MODEL_STORAGE_KEY) : null;
      if (v && MODELS[v]) return v;
    } catch (e) { /* storage blocked -- fall through to default */ }
    return DEFAULT_MODEL;
  }

  let currentModel = readStoredModel();
  const weightsPromises = {};
  function ensureLoaded(name = currentModel) {
    if (!MODELS[name]) return Promise.reject(new Error("nnue.js: unknown model " + name));
    if (!weightsPromises[name]) {
      const expected = inputSizeFor(name);
      weightsPromises[name] = fetch(extBase() + MODELS[name].file)
        .then((r) => r.json())
        .then((raw) => parseWeights(raw, expected));
    }
    return weightsPromises[name];
  }

  const loadedWeights = {};
  // "loading" | "ready" | "error" per model, so the UI can show it.
  const loadState = {};
  function notifyStatus() {
    try { if (typeof self.dispatchEvent === "function" && typeof CustomEvent === "function") self.dispatchEvent(new CustomEvent("aug-nnue-status")); } catch (e) { /* UI hint only */ }
  }
  function loadModel(name) {
    loadState[name] = "loading";
    notifyStatus();
    return ensureLoaded(name).then((w) => { loadedWeights[name] = w; loadState[name] = "ready"; }).catch((err) => {
      loadState[name] = "error";
      console.warn("[증강체스엔진] NNUE weights (" + name + ") failed to load, evaluate() will fall back to evaluateState() until fixed:", err);
    }).then(notifyStatus);
  }
  loadModel(currentModel);

  // Switch the active model. Unknown names are ignored. Persisted (page
  // context only) so the choice survives reloads; the previous model keeps
  // answering until the new one finishes loading, so a switch never leaves
  // evaluate() returning null mid-game.
  function setModel(name, { persist = true } = {}) {
    if (!MODELS[name]) return currentModel;
    currentModel = name;
    if (persist) { try { localStorage.setItem(MODEL_STORAGE_KEY, name); } catch (e) { /* ignore */ } }
    if (!loadedWeights[name]) loadModel(name);
    return currentModel;
  }
  function getModel() { return currentModel; }
  // { model, state } -- state is "loading" | "ready" | "error"; while a newly
  // chosen model is still loading, the previous one keeps answering.
  function getStatus() { return { model: currentModel, state: loadState[currentModel] || "loading" }; }
  function activeWeights() { return loadedWeights[currentModel] || null; }

  // Returns a tanh-squashed score in [-1, 1] from `mover`'s perspective
  // (positive = good for mover), or null if weights aren't loaded yet or
  // the position is terminal (callers should fall back to
  // engine.evaluateState()'s own terminal handling in that case -- this
  // never tries to score a checkmate/no-survivor position itself).
  function evaluate(boardState, mover) {
    const weights = activeWeights();
    if (!weights) return null;
    const input = encodeFromState(boardState, mover, dimsFor(currentModel));
    if (input === null) return null;
    return forward(weights, input);
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
  function scoreFromOutput(out, boardState, aiColor) {
    const spec = MODELS[currentModel] && MODELS[currentModel].map;
    if (!spec) return out * SCORE_SCALE;
    let m = /^atanh([0-9]+)$/.exec(spec);
    if (m) return Number(m[1]) * Math.atanh(Math.max(-0.995, Math.min(0.995, out)));
    m = /^hybrid([0-9]+)$/.exec(spec);
    if (m) return engine.evaluateState(boardState, aiColor) + Number(m[1]) * out;
    return out * SCORE_SCALE;
  }
  function evaluateForSearch(boardState, aiColor) {
    const nnueScore = evaluate(boardState, aiColor);
    if (nnueScore === null) return engine.evaluateState(boardState, aiColor);
    return scoreFromOutput(nnueScore, boardState, aiColor);
  }

  self.__augNNUE = {
    ensureLoaded, evaluate, evaluateForSearch, INPUT_SIZE, inputSizeFor, FEATURE_NAMES, MODELS,
    setModel, getModel, getStatus, forwardWith: forward, parseWeights, encodeFromState
  };
})();
