// Fast search engine for the board part of Augment Chess.
//
// Self-contained (no game code). The whole module is a single function so its
// source can be injected into the game's AI worker with Function#toString.
// The game is won by capturing the king, so search needs no check/mate logic:
// a move that takes the enemy king scores as a win, and a side with no move at
// all loses (Augment Chess has no stalemate draw; moving into check is legal).
// Card-specific special victories are not modelled here; the worker keeps the
// game's own terminal-win detection ahead of this engine.
//
// Board: 64 squares, index = row * 8 + col, row 0 = rank 8 (same as the game).
// Colors: 0 = white (moves toward row 0), 1 = black.
function acbFastEngineModule() {
  "use strict";

  const MATE = 1000000;
  const INF = 2000000;

  // Simplified piece-square tables, white's view, index 0 = a8.
  const PST = {
    pawn: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
    knight: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
    bishop: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
    rook: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
    queen: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
    kingMid: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
    kingEnd: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50],
    none: new Array(64).fill(0)
  };

  const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const KING = [...ORTHO, ...DIAG];

  const scale = (dirs, n) => dirs.map(([r, c]) => [r * n, c * n]);
  const upTo = (dirs, n) => Array.from({ length: n }, (_, i) => scale(dirs, i + 1)).flat();

  // Built-in piece kinds, transcribed from the game's own movement table.
  // Move spec fields: d = directions/offsets, ray = max steps (0 = leap),
  // quiet = may not capture, capOnly = only captures, rel = row offset is
  // relative to the side's forward direction, royalOnly = captures only royals.
  // teleportQuiet = may move to any empty square; hop = grasshopper (lands
  // just past the first piece in a line); cannon = moves like a rook without
  // capturing, captures the first piece beyond a screen; becomes = kind it
  // turns into after moving (windmill rook <-> bishop).
  const BUILTIN = {
    pawn: { pawn: 1, value: 100, pst: "pawn" },
    "berolina-pawn": { pawn: 2, value: 100, pst: "pawn" },
    knight: { leaps: KNIGHT, value: 310, pst: "knight" },
    bishop: { slides: DIAG, value: 320, pst: "bishop" },
    rook: { slides: ORTHO, value: 500, pst: "rook" },
    queen: { slides: KING, value: 900, pst: "queen" },
    king: { leaps: KING, value: 0, royal: true, pst: "none" },
    amazon: { slides: KING, leaps: KNIGHT, value: 1200, pst: "queen" },
    chancellor: { slides: ORTHO, leaps: KNIGHT, value: 850, pst: "rook" },
    archbishop: { slides: DIAG, leaps: KNIGHT, value: 750, pst: "bishop" },
    "king-step": { leaps: KING, value: 300 },
    ferz: { leaps: DIAG, value: 210 },
    wazir: { leaps: ORTHO, value: 200 },
    // Killer: at the end of its side's turn it automatically captures an
    // enemy king it attacks (diagonal, 1-2 squares, clear path) - game over.
    "killer": { specs: [{ d: DIAG, ray: 2 }], autoExec: true, value: 300 },
    beacon: { specs: [{ d: KING, quiet: true }], value: 500 },
    immobile: { value: 300 },
    dragon: { leaps: KNIGHT, value: 400 },
    assassin: { leaps: KNIGHT, specs: [{ d: KING, ray: 7, capOnly: true, royalOnly: true }], value: 500 },
    paladin: { specs: [{ d: KNIGHT, quiet: true }], value: 300 },
    "royal-knight": { leaps: [...KNIGHT, ...KING], value: 600 },
    // VIP: royal - capturing it wins the game ("vip_capture").
    vip: { leaps: [...KING, ...scale(DIAG, 2)], royal: true, secondary: true, value: 0 },
    camel: { leaps: [[-3, -1], [-3, 1], [-1, -3], [-1, 3], [1, -3], [1, 3], [3, -1], [3, 1]], value: 260 },
    alfil: { leaps: scale(DIAG, 2), value: 210 },
    eagle: { leaps: [...scale(DIAG, 2), ...scale(ORTHO, 2)], value: 310 },
    thief: { leaps: upTo(ORTHO, 3), value: 300 },
    grasshopper: { hop: true, value: 400 },
    "quiet-queen": { specs: [{ d: KING, ray: 7, quiet: true }], value: 300 },
    lobster: { specs: [{ d: [[1, -1], [1, 0], [1, 1]], rel: true }], value: 200 },
    fanatic: { specs: [{ d: [[1, 0]], ray: 2, rel: true }], value: 120 },
    bat: { specs: [{ d: ORTHO, ray: 2 }], value: 300 },
    slime: { leaps: scale(ORTHO, 3), value: 300 },
    "siege-ram": { leaps: upTo(ORTHO, 2), value: 350 },
    "quiet-king": { specs: [{ d: KING, quiet: true }], value: 300 },
    campfire: { specs: [{ d: ORTHO, ray: 7, quiet: true }], value: 300 },
    missionary: { specs: [{ d: DIAG, quiet: true }], value: 200 },
    // Herald: when a turn ends with a herald next to the enemy king, the
    // herald's side wins ("herald_proximity").
    herald: { specs: [{ d: upTo(ORTHO, 3), quiet: true }], proximityWin: true, value: 300 },
    pegasus: { teleportQuiet: true, leaps: KNIGHT, value: 650 },
    "prime-minister": { leaps: KING.flatMap(([a, b]) => [[a, b], ...KING.map(([c, d]) => [a + c, b + d])]).filter(([r, c]) => r || c), value: 500 },
    checker: { specs: [{ d: [[1, -1], [1, 1]], quiet: true, rel: true }], value: 240 },
    "checker-king": { specs: [{ d: DIAG, quiet: true }], value: 360 },
    "windmill-bishop": { slides: DIAG, becomes: "windmill-rook", value: 470, pst: "bishop" },
    "windmill-rook": { slides: ORTHO, becomes: "windmill-bishop", value: 470, pst: "rook" },
    cannon: { cannon: true, value: 410 },
    // Hook (game "hook"/"brutus"): slides like a rook and, at any empty
    // square on the way, may turn 90 degrees once and keep sliding; captures
    // the first piece it meets on either leg.
    hook: { hook: true, value: 950, pst: "queen" },
    // Brutus: a hook that, at the start of its owner's turn, takes its own
    // king if it can.
    brutus: { hook: true, betrays: true, value: 950, pst: "queen" },
    "berserker-strong": { slides: KING, leaps: KNIGHT, value: 600 },
    "berserker-mid": { leaps: KING, slides: ORTHO, value: 500 },
    "berserker-weak": { leaps: KING, value: 400 },
    "jester-royal": { specs: [{ d: KING, ray: 7, quiet: true }, { d: KING, ray: 7, capOnly: true, royalOnly: true }], value: 300 }
  };

  // Game piece types that move exactly like a built-in kind.
  const ALIASES = {
    squire: "pawn", "standard-bearer": "pawn",
    bear: "queen", clockwork: "queen", grappler: "queen",
    "big-rook": "rook", "revolving-door": "rook",
    "big-bishop": "bishop", pope: "bishop", cardinal: "bishop",
    offering: "ferz", knightmaster: "ferz", princess: "ferz",
    wanderer: "wazir", colossus: "wazir",
    "transmission-tower": "immobile", transmissionTower: "immobile", barrier: "immobile",
    unicorn: "knight", "don-quixote": "knight",
    "magic-girl": "king-step",
    octopus: "king-step", man: "king-step", guard: "king-step", reaper: "king-step", recruiter: "king-step",
    crown: "king-step", "dark-wizard": "king-step", undead: "king-step", hedgehog: "king-step",
    "vampire-lord": "king-step", siren: "king-step", log: "king-step", monster: "king-step",
    alibaba: "eagle", idol: "quiet-queen", jester: "quiet-queen",
    wizard: "quiet-king", "shotgun-king": "quiet-king", "time-traveler": "quiet-king"
  };
  const resolveKind = (type) => (BUILTIN[type] ? type : ALIASES[type] ?? null);

  // Transposition table, reused across searches.
  const TT_BITS = 20, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  const ttKey = new Int32Array(TT_SIZE), ttMove = new Int32Array(TT_SIZE), ttScore = new Int32Array(TT_SIZE);
  const ttDepth = new Int8Array(TT_SIZE), ttFlag = new Int8Array(TT_SIZE);
  // search generation per entry (two-way buckets: slot 0 keeps the deeper
  // entry of the current search, slot 1 is always replaced)
  const ttGen = new Uint8Array(TT_SIZE);
  let ttAge = 0;
  const EXACT = 1, LOWER = 2, UPPER = 3;

  // Deterministic Zobrist keys (two 32-bit halves).
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
  const MAX_KINDS = 128;
  const Z1 = new Int32Array(MAX_KINDS * 2 * 64), Z2 = new Int32Array(MAX_KINDS * 2 * 64);
  for (let i = 0; i < Z1.length; i++) { Z1[i] = rnd(); Z2[i] = rnd(); }
  const ZSIDE1 = rnd(), ZSIDE2 = rnd();
  const ZACT1 = rnd(), ZACT2 = rnd();
  const ZF1 = new Int32Array(64), ZF2 = new Int32Array(64);
  for (let i = 0; i < 64; i++) { ZF1[i] = rnd(); ZF2[i] = rnd(); }

  class AbortSearch extends Error {}

  // Weights from JSON arrays -> typed arrays, once per weights object.
  function prepareNnue(w) {
    if (w._ready) return w._ready;
    w._ready = { H: w.H, NK: w.NK, W1: Float32Array.from(w.W1), B1: Float32Array.from(w.B1), W2: Float32Array.from(w.W2), B2: w.B2 };
    return w._ready;
  }

  function search(input) {
    const kinds = [];
    const kindIndex = new Map();
    const addKind = (name, def) => {
      if (kindIndex.has(name)) return kindIndex.get(name);
      if (kinds.length >= MAX_KINDS - 1) throw new Error("too many piece kinds");
      const pstName = def.pst && PST[def.pst] ? def.pst : "none";
      kinds.push({
        name, pawn: def.pawn || 0, royal: !!def.royal, secondary: !!def.secondary, block: !!def.block,
        slides: def.slides || [], leaps: def.leaps || [], specs: def.specs || [],
        teleportQuiet: !!def.teleportQuiet, hop: !!def.hop, cannon: !!def.cannon, hook: !!def.hook,
        // external: moves come from input.externalMoves (the game's own
        // movement function), for piece types the engine does not model.
        external: !!def.external, typeName: def.typeName || name, autoExec: !!def.autoExec, proximityWin: !!def.proximityWin, betrays: !!def.betrays,
        becomesName: def.becomes || null, becomes: 0,
        value: def.value ?? 300, pst: PST[pstName]
      });
      kindIndex.set(name, kinds.length);
      return kinds.length;
    };
    for (const [name, def] of Object.entries(BUILTIN)) addKind(name, def);
    for (const [name, def] of Object.entries(input.kinds || {})) {
      if (kindIndex.has(name)) {
        // Allow the caller to override values / royalty of known kinds.
        const kd = kinds[kindIndex.get(name) - 1];
        if (def.value != null) kd.value = def.value;
        if (def.royal) kd.royal = true;
      } else addKind(name, def);
    }
    // Collapsed squares become walls.
    if (Number.isFinite(input.collapse?.ply)) addKind("neutral-block", { leaps: [], value: 0, pst: "none", block: true });
    for (const kd of kinds) if (kd.becomesName) kd.becomes = kindIndex.get(kd.becomesName) || 0;
    const queenKind = kindIndex.get("queen"), knightKind = kindIndex.get("knight");
    // Capture bans found by probing the game: { by, a, t } = pieces of kind a
    // of side "by" cannot capture pieces of kind t (e.g. a card that stops
    // minor pieces from taking the queen).
    const banCap = new Uint8Array(2 * MAX_KINDS * MAX_KINDS);
    let anyBan = false;
    for (const b of input.capBans ?? []) {
      const ai = kindIndex.get(b.a), ti = kindIndex.get(b.t);
      if (!ai || !ti || (b.by !== 0 && b.by !== 1)) continue;
      banCap[(b.by * MAX_KINDS + ai) * MAX_KINDS + ti] = 1; anyBan = true;
    }
    const banned = (me, fromSq, toSq) => anyBan && banCap[(me * MAX_KINDS + pk[fromSq]) * MAX_KINDS + pk[toSq]] === 1;

    // Board state. Per-piece data that travels with the piece:
    //   fl: IMMUNE (cannot be captured), NO_CAPTURE (never captures, barrier)
    //   lk: ply at which the piece may not move (game: counterattack lock,
    //       blocked when current ply === lock ply), -1 = none
    //   fu: captures blocked while current ply < fu (game: freshly
    //       transformed piece), 0 = none
    // The game's ply counter at the root is input.rootPly; ply = root + sp.
    const IMMUNE = 2, NO_CAPTURE = 4, FROZEN = 8; // FROZEN: cannot move at all
    const EAT_OWN = 1; // may capture its own side's non-royal pieces
    const eatExtra = [!!input.eatExtra?.[0], !!input.eatExtra?.[1]]; // a friendly capture gives one more move
    // TRANS_OWN: pieces of its own side slide through it (e.g. ghost pawns);
    // TRANS_FOE: pieces of the other side slide through it.
    const TRANS_OWN = 16, TRANS_FOE = 32;
    const pk = new Uint8Array(64), pc = new Uint8Array(64), pm = new Uint8Array(64), fl = new Uint8Array(64);
    const lk = new Int16Array(64).fill(-1), fu = new Int16Array(64);
    //   lb: "empty lunchbox" moves left (0 = none): after each of its owner's
    //       moves the piece is safe if next to its own king, otherwise lb-1;
    //       at 0 it dies.
    //   vd: "VIP" due ply (0 = none): a pawn alive at that ply becomes a VIP.
    const lb = new Int8Array(64), vd = new Int16Array(64);
    //   um: the piece has moved since the ultimatum was set (it survives it)
    const um = new Uint8Array(64);
    //   px: slot of this piece's learned corrections (0 = none). slotExtra
    //       holds offsets the game allows that the engine's rules miss (e.g.
    //       passing through ghost pawns), slotBan offsets the game forbids
    //       (e.g. "may not move exactly one square"). Offsets are relative,
    //       so they follow the piece as it moves.
    const px = new Uint8Array(64);
    const slotExtra = [null], slotBan = [null];
    // Timed limits per slot: until these plies the piece is frozen /
    // immune / unable to capture (frozen, stake, protection, barrier...).
    // slotTxp/slotTxk: at that ply the piece turns into kind slotTxk
    // (0 = it disappears), e.g. baby bear -> bear, revived piece expires.
    const slotTuF = [0], slotTuI = [0], slotTuN = [0], slotTxp = [0], slotTxk = [0];
    //   slotSw: sleepwalking from this ply (0 = no)
    const slotSw = [0];
    const offIdx = (dr, dc) => (dr + 7) * 15 + (dc + 7);
    const royalLost = [0, 0];
    // ---- turn structure and rule cards ----
    // Acceleration: from its start every side takes two actions per turn.
    const accelOn = !!input.accel?.on;
    // Forced extra moves at the root: { sq, left, dies, noKing } for the side
    // to move. The piece on sq must move; while moves are left the same side
    // moves it again; after the last one a desperado piece dies. A desperado
    // cannot take the king (main royal piece).
    let forcedSq = -1, forcedLeft = 0;
    let forcedDies = !!input.forced?.dies, forcedNoKing = !!input.forced?.noKing;
    if (Number.isInteger(input.forced?.sq) && input.forced.sq >= 0 && input.forced.sq < 64 && input.forced.left > 0) {
      forcedSq = input.forced.sq; forcedLeft = Math.min(8, input.forced.left);
    }
    let forcedSide = input.forced?.side === 0 || input.forced?.side === 1 ? input.forced.side : input.turn === 1 ? 1 : 0;
    let actionsLeft = accelOn ? Math.max(1, Math.min(2, input.accel.left ?? 2)) : 1;
    // Exhaustion (a side may not move the same piece 4 times in a row) and
    // moving (5 moves in a row with one piece give it an evasion).
    const exhaust = [!!input.exhaust?.[0], !!input.exhaust?.[1]];
    const movingCard = [!!input.moving?.[0], !!input.moving?.[1]];
    const lastSq = [input.streak?.[0]?.sq ?? -1, input.streak?.[1]?.sq ?? -1];
    const streak = [input.streak?.[0]?.n ?? 0, input.streak?.[1]?.n ?? 0];
    // Capture the flag: a side loses when its turn ends with an enemy piece
    // on its flag square.
    const flagSq = [input.flags?.[0] ?? -1, input.flags?.[1] ?? -1];
    // Crown: a side holding a crown square at the start of its turn counts
    // a held move; 10 held moves win.
    //   (the crown is carried: it moves with the piece holding it, and a
    //   piece that captures the holder takes it)
    const crowns = (input.crowns ?? []).filter((c) => c.sq >= 0 && c.sq < 64).map((c) => ({ sq: c.sq, held: [c.held?.[0] ?? 0, c.held?.[1] ?? 0] }));
    // Prophecy: if no capture (and, for the check-free version, no check)
    // happens for N plies, its owner wins.
    const prophecies = (input.prophecy ?? []).filter((p) => p && Number.isFinite(p.remaining));
    let prophecyBroken = 0;
    // Revelation: at this ply the side with more material wins.
    const revelationPly = Number.isFinite(input.revelation?.ply) ? input.revelation.ply : Infinity;
    // Ultimatum: at this ply every non-pawn, non-royal piece that has not
    // moved since it was set disappears.
    const ultimatumPly = Number.isFinite(input.ultimatum?.ply) ? input.ultimatum.ply : null;
    // Periodic collapse: at this ply the ring at this depth collapses.
    const collapse = Number.isFinite(input.collapse?.ply) ? input.collapse : null;
    // Evaluation squares: next to a neutral monster (danger) and a platform.
    const dangerSq = new Uint8Array(64), platformNear = new Uint8Array(64);
    for (const q of input.danger ?? []) if (q >= 0 && q < 64) dangerSq[q] = 1;
    for (const q of input.platform ?? []) if (q >= 0 && q < 64) {
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (Math.max(Math.abs(r - (q >> 3)), Math.abs(c - (q & 7))) <= 2) platformNear[r * 8 + c] = 1;
    }
    const evalSquares = (input.danger?.length ?? 0) + (input.platform?.length ?? 0) > 0;
    const rootPly = Number.isFinite(input.rootPly) ? input.rootPly : 0;
    let side = input.turn, ep = input.ep ?? -1, h1 = 0, h2 = 0, score = 0; // score: white's view
    let kingSq = [-1, -1];
    let timed = false; // any lunchbox / VIP timers on the board
    let nonPawn = [0, 0];
    const autoCnt = [0, 0]; // killers per color
    const betrayCnt = [0, 0]; // brutus pieces per color
    const proxCnt = [0, 0]; // heralds per color
    // Count-based special victories (only for sides holding the card):
    // gomoku (5 own pieces in a vertical row), religious (3+ more bishops),
    // highlander (4+ piece types, no duplicates), hope (2 or fewer pieces at
    // the start of its turn), double check (2+ pieces attack the king),
    // penta check (5 checks in total), antichess (4 enemy captures in a row).
    const vic = input.victory ?? {};
    const vGomoku = [!!vic.gomoku?.[0], !!vic.gomoku?.[1]], vRelig = [!!vic.religious?.[0], !!vic.religious?.[1]];
    const vHigh = [!!vic.highlander?.[0], !!vic.highlander?.[1]], vHope = [!!vic.hope?.[0], !!vic.hope?.[1]];
    const vBina = [!!vic.binaMate?.[0], !!vic.binaMate?.[1]];
    const pentaOn = [Number.isFinite(vic.penta?.[0]), Number.isFinite(vic.penta?.[1])];
    const pentaCnt = [vic.penta?.[0] ?? 0, vic.penta?.[1] ?? 0];
    const antiOn = [Number.isFinite(vic.antichess?.[0]), Number.isFinite(vic.antichess?.[1])];
    const antiCnt = [vic.antichess?.[0] ?? 0, vic.antichess?.[1] ?? 0];
    const anyCountVictory = vGomoku.some(Boolean) || vRelig.some(Boolean) || vHigh.some(Boolean) || vHope.some(Boolean) || vBina.some(Boolean) || pentaOn.some(Boolean) || antiOn.some(Boolean);
    // Racing king (card): a side whose king reaches the far rank wins.
    const racing = [!!input.racing?.[0], !!input.racing?.[1]];

    const pstOf = (k, color, sq) => {
      const t = kinds[k - 1].pst;
      return color === 0 ? t[sq] : t[(7 - (sq >> 3)) * 8 + (sq & 7)];
    };
    const zi = (k, color, sq) => ((k * 2 + color) << 6) + sq;
    // Incremental counts for the structure terms (see structureTerms).
    let pawnKey = 0;
    const pawnFileCnt = new Int8Array(16), rookFileCnt = new Int8Array(16), bishopCnt = [0, 0];
    function track(kd, color, sq, d, i) {
      if (kd.pawn) { pawnKey ^= Z1[i]; pawnFileCnt[color * 8 + (sq & 7)] += d; }
      else if (kd.typeName === "bishop") bishopCnt[color] += d;
      else if (kd.typeName === "rook") rookFileCnt[color * 8 + (sq & 7)] += d;
    }
    // NNUE (optional, input.nnue): two accumulators (white's and black's
    // view, board mirrored for black) over kind x color x square features of
    // the built-in kinds; other kinds count by material value only.
    const nn = input.nnue && input.nnue.H ? prepareNnue(input.nnue) : null;
    const nnH = nn ? nn.H : 0, nnK = nn ? nn.NK : 0;
    const accW = nn ? Float32Array.from(nn.B1) : null, accB = nn ? Float32Array.from(nn.B1) : null;
    let nnExtra = 0; // white's view, kinds outside the net
    function nnTrack(k, color, sq, d) {
      const kd = kinds[k - 1];
      if (kd.block) return;
      if (k - 1 >= nnK) { nnExtra += (color === 0 ? d : -d) * kd.value; return; }
      const W = nn.W1;
      let o = ((((k - 1) * 2 + color) << 6) + sq) * nnH;
      for (let j = 0; j < nnH; j++) accW[j] += d * W[o + j];
      o = ((((k - 1) * 2 + (color ^ 1)) << 6) + ((7 - (sq >> 3)) * 8 + (sq & 7))) * nnH;
      for (let j = 0; j < nnH; j++) accB[j] += d * W[o + j];
    }
    function put(sq, k, color, moved) {
      if (nn) nnTrack(k, color, sq, 1);
      pk[sq] = k; pc[sq] = color; pm[sq] = moved;
      const i = zi(k, color, sq); h1 ^= Z1[i]; h2 ^= Z2[i];
      const kd = kinds[k - 1];
      const v = kd.value + pstOf(k, color, sq);
      score += color === 0 ? v : -v;
      if (!kd.block) track(kd, color, sq, 1, i);
      if (kd.royal) { if (!kd.secondary || kingSq[color] < 0) kingSq[color] = sq; }
      else if (!kd.pawn) nonPawn[color] += kd.value;
      if (kd.autoExec) autoCnt[color]++;
      if (kd.betrays) betrayCnt[color]++;
      if (kd.proximityWin) proxCnt[color]++;
    }
    function lift(sq) {
      const k = pk[sq], color = pc[sq];
      if (nn) nnTrack(k, color, sq, -1);
      const i = zi(k, color, sq); h1 ^= Z1[i]; h2 ^= Z2[i];
      const kd = kinds[k - 1];
      const v = kd.value + pstOf(k, color, sq);
      score -= color === 0 ? v : -v;
      if (!kd.block) track(kd, color, sq, -1, i);
      if (kd.royal) { if (kingSq[color] === sq) kingSq[color] = -1; }
      else if (!kd.pawn) nonPawn[color] -= kd.value;
      if (kd.autoExec) autoCnt[color]--;
      if (kd.betrays) betrayCnt[color]--;
      if (kd.proximityWin) proxCnt[color]--;
      pk[sq] = 0;
    }
    for (let sq = 0; sq < 64; sq++) {
      const p = input.board[sq];
      if (!p) continue;
      const k = kindIndex.get(p.kind);
      if (!k) throw new Error(`unknown piece kind ${p.kind}`);
      put(sq, k, p.color, p.moved ? 1 : 0);
      fl[sq] = (p.immune ? IMMUNE : 0) | (p.noCapture ? NO_CAPTURE : 0) | (p.frozen ? FROZEN : 0) | (p.transOwn ? TRANS_OWN : 0) | (p.transFoe ? TRANS_FOE : 0) | (p.eatOwn ? EAT_OWN : 0);
      lk[sq] = Number.isFinite(p.lockPly) ? p.lockPly : -1;
      fu[sq] = Number.isFinite(p.freshUntil) ? p.freshUntil : 0;
      lb[sq] = Number.isFinite(p.lunchbox) && p.lunchbox > 0 ? p.lunchbox : 0;
      vd[sq] = Number.isFinite(p.vipDue) && p.vipDue > 0 ? p.vipDue : 0;
      const t = p.timers;
      if ((p.extra && p.extra.length) || (p.banned && p.banned.length) || t || p.sleepwalkFrom) {
        const ban = new Uint8Array(225);
        for (const [dr, dc] of p.banned ?? []) if (Math.abs(dr) <= 7 && Math.abs(dc) <= 7) ban[offIdx(dr, dc)] = 1;
        slotExtra.push((p.extra ?? []).filter(([dr, dc]) => Math.abs(dr) <= 7 && Math.abs(dc) <= 7));
        slotBan.push(ban);
        slotTuF.push(t?.frozenUntil ?? 0); slotTuI.push(t?.immuneUntil ?? 0); slotTuN.push(t?.noCaptureUntil ?? 0);
        slotSw.push(Number.isFinite(p.sleepwalkFrom) ? p.sleepwalkFrom : 0);
        const tk = t?.transformAt ? (t.transformTo ? kindIndex.get(t.transformTo) || 0 : 0) : 0;
        slotTxp.push(t?.transformAt && (tk || !t.transformTo) ? t.transformAt : 0); slotTxk.push(tk);
        if (t?.transformAt) timed = true;
        px[sq] = slotExtra.length - 1;
      }
      if (lb[sq] || vd[sq]) timed = true;
      um[sq] = p.movedSinceUltimatum ? 1 : 0;
    }
    if (ultimatumPly !== null || collapse || crowns.length) timed = true;
    if (side === 1) { h1 ^= ZSIDE1; h2 ^= ZSIDE2; }
    if (actionsLeft === 2) { h1 ^= ZACT1; h2 ^= ZACT2; }
    // The transposition table is shared by every search, but kind indices
    // are assigned per search and timers/flags are not part of the key.
    // Salt the key with this search's kind table, racing flags and timers
    // so entries from a different setup never match.
    {
      let salt = 0x811c9dc5;
      const mix = (str) => { for (let i = 0; i < str.length; i++) { salt ^= str.charCodeAt(i); salt = Math.imul(salt, 16777619); } };
      mix(kinds.map((kd) => `${kd.name}/${kd.value}/${kd.royal ? 1 : 0}/${kd.block ? 1 : 0}`).join("|"));
      // The ply only matters with ply-based timers, scheduled events or
      // side-wide counters; without them, entries stay valid on the next
      // move (the search goes on from what the last moves learned).
      let plyBased = (input.events?.length ?? 0) > 0 || [input.accel, input.exhaust, input.moving, input.streak, input.flags, input.crowns, input.prophecy, input.revelation, input.ultimatum, input.collapse, input.danger, input.platform].some((x) => x != null && !(Array.isArray(x) && x.length === 0));
      for (let sq = 0; sq < 64 && !plyBased; sq++) if (pk[sq] && (lb[sq] || vd[sq] || fu[sq] || lk[sq] >= 0 || fl[sq] || px[sq])) plyBased = true;
      mix(`r${racing[0] ? 1 : 0}${racing[1] ? 1 : 0}${plyBased ? `p${rootPly}` : ""}`);
      for (let sq = 0; sq < 64; sq++) if (pk[sq] && (lb[sq] || vd[sq] || fu[sq] || lk[sq] >= 0 || fl[sq] || px[sq])) mix(`${sq}:${lb[sq]}:${vd[sq]}:${fu[sq]}:${lk[sq]}:${fl[sq]}:${px[sq] ? JSON.stringify(slotExtra[px[sq]]) + slotBan[px[sq]].join("") + [slotTuF[px[sq]], slotTuI[px[sq]], slotTuN[px[sq]], slotTxp[px[sq]], slotTxk[px[sq]], slotSw[px[sq]]].join(",") : ""}`);
      mix(JSON.stringify(input.events ?? []) + JSON.stringify(input.victory ?? {}));
      mix(JSON.stringify(input.capBans ?? []));
      mix(JSON.stringify([input.accel, input.exhaust, input.moving, input.streak, input.flags, input.crowns, input.prophecy, input.revelation, input.ultimatum, input.collapse, input.danger, input.platform]));
      h1 ^= salt; h2 ^= Math.imul(salt, 0x9e3779b1) ^ 0x5bd1e995;
    }

    // Move encoding: from | to << 6 | promoKind << 12.
    const enc = (from, to, promo) => from | (to << 6) | (promo << 12);
    const mFrom = (m) => m & 63, mTo = (m) => (m >> 6) & 63, mPromo = (m) => m >> 12;

    // Undo stack.
    const MAXPLY = 64;
    const ROOT_BAND = 200;
    const uCap = new Int32Array(MAXPLY * 2), uCapSq = new Int32Array(MAXPLY * 2), uEp = new Int32Array(MAXPLY * 2);
    const uMoved = new Uint8Array(MAXPLY * 2), uRookFrom = new Int32Array(MAXPLY * 2), uRookTo = new Int32Array(MAXPLY * 2);
    const uKind = new Uint8Array(MAXPLY * 2), uFl = new Uint8Array(MAXPLY * 2);
    const uLk0 = new Int16Array(MAXPLY * 2), uFu0 = new Int16Array(MAXPLY * 2), uLk1 = new Int16Array(MAXPLY * 2), uFu1 = new Int16Array(MAXPLY * 2);
    const uLb0 = new Int8Array(MAXPLY * 2), uVd0 = new Int16Array(MAXPLY * 2), uLb1 = new Int8Array(MAXPLY * 2), uVd1 = new Int16Array(MAXPLY * 2);
    const uPx0 = new Uint8Array(MAXPLY * 2), uPx1 = new Uint8Array(MAXPLY * 2);
    const uPenta = new Int8Array(MAXPLY * 2), uAnti = new Int16Array(MAXPLY * 2 * 2);
    const uCrownSq = new Int8Array(MAXPLY * 2 * Math.max(1, crowns.length));
    const uFSq = new Int8Array(MAXPLY * 2), uFLeft = new Int8Array(MAXPLY * 2), uFMeta = new Uint8Array(MAXPLY * 2);
    const uUm0 = new Uint8Array(MAXPLY * 2), uUm1 = new Uint8Array(MAXPLY * 2), uRookUm = new Uint8Array(MAXPLY * 2);
    const uSwitch = new Uint8Array(MAXPLY * 2), uAct = new Uint8Array(MAXPLY * 2), moverAt = new Uint8Array(MAXPLY * 2);
    const uLast = new Int8Array(MAXPLY * 2), uStreak = new Uint8Array(MAXPLY * 2), uProph = new Uint8Array(MAXPLY * 2), uMovingFl = new Int8Array(MAXPLY * 2);
    // Log of turn-boundary changes (timers ticking, pieces dying or
    // transforming) so unmake can restore them: [sp, square, field, old].
    const LOG_MAX = 8192;
    const gSp = new Int16Array(LOG_MAX), gSq = new Int8Array(LOG_MAX), gField = new Int8Array(LOG_MAX), gOld = new Int32Array(LOG_MAX);
    let gLen = 0;
    const F_LB = 1, F_VD = 2, F_PIECE = 3, F_KIND = 4, F_SPAWN = 5, F_CROWN = 6, F_ROYAL = 7;
    const logChange = (sq, field, old) => { gSp[gLen] = sp; gSq[gLen] = sq; gField[gLen] = field; gOld[gLen] = old; gLen++; };
    const vipKind = kindIndex.get("vip") || 0;
    const blockKind = kindIndex.get("neutral-block") || 0;
    // sp: actions made in this search; tp: turns passed (the game's ply
    // counter moves with tp, which differs from sp only under acceleration)
    let sp = 0, tp = 0;

    function make(m) {
      const from = mFrom(m), to = mTo(m), promo = mPromo(m);
      const k = pk[from], color = pc[from], kd = kinds[k - 1];
      uEp[sp] = ep; uMoved[sp] = pm[from]; uKind[sp] = k; uRookFrom[sp] = -1;
      // Does this action end the turn? (Not the first of two under acceleration.)
      // forced extra moves: does the same piece move again?
      uFSq[sp] = forcedSq; uFLeft[sp] = forcedLeft;
      uFMeta[sp] = forcedSide | (forcedDies ? 2 : 0) | (forcedNoKing ? 4 : 0);
      let cont = false, dieAt = -1;
      if (forcedLeft > 0 && color === forcedSide && from === forcedSq) {
        h1 ^= ZF1[forcedSq]; h2 ^= ZF2[forcedSq];
        forcedLeft--;
        if (forcedLeft > 0) { forcedSq = to; cont = true; h1 ^= ZF1[forcedSq]; h2 ^= ZF2[forcedSq]; }
        else { forcedSq = -1; if (forcedDies) dieAt = to; }
      } else if (eatExtra[color] && pk[to] && pc[to] === color && (fl[from] & EAT_OWN)) {
        // a friendly capture: the same piece moves once more
        forcedSq = to; forcedLeft = 1; forcedSide = color; forcedDies = false; forcedNoKing = false; cont = true;
        h1 ^= ZF1[forcedSq]; h2 ^= ZF2[forcedSq];
      }
      const ends = !cont && !(accelOn && actionsLeft > 1);
      let capSq = -1, cap = 0;
      if (pk[to]) { capSq = to; cap = pk[to] | (pc[to] << 8) | (pm[to] << 9); }
      else if (kd.pawn && (from & 7) !== (to & 7) && to === ep) {
        capSq = (from & ~7) | (to & 7); // en passant victim beside the start square
        if (pk[capSq]) cap = pk[capSq] | (pc[capSq] << 8) | (pm[capSq] << 9); else capSq = -1;
      }
      uCap[sp] = cap; uCapSq[sp] = capSq;
      uFl[sp] = fl[from] | ((capSq >= 0 ? fl[capSq] : 0) << 6);
      uLk0[sp] = lk[from]; uFu0[sp] = fu[from];
      uLk1[sp] = capSq >= 0 ? lk[capSq] : -1; uFu1[sp] = capSq >= 0 ? fu[capSq] : 0;
      uLb0[sp] = lb[from]; uVd0[sp] = vd[from]; uLb1[sp] = capSq >= 0 ? lb[capSq] : 0; uVd1[sp] = capSq >= 0 ? vd[capSq] : 0;
      uUm0[sp] = um[from]; uUm1[sp] = capSq >= 0 ? um[capSq] : 0;
      if (capSq >= 0) {
        if (kinds[pk[capSq] - 1].royal) royalLost[pc[capSq]]++;
        uPx1[sp] = px[capSq]; um[capSq] = 0;
        lift(capSq); fl[capSq] = 0; lk[capSq] = -1; fu[capSq] = 0; lb[capSq] = 0; vd[capSq] = 0; px[capSq] = 0;
      }
      lift(from);
      put(to, promo || kd.becomes || k, color, 1);
      fl[to] = uFl[sp] & 63; fl[from] = 0;
      lk[to] = uLk0[sp]; fu[to] = uFu0[sp]; lk[from] = -1; fu[from] = 0;
      lb[to] = uLb0[sp]; vd[to] = uVd0[sp]; lb[from] = 0; vd[from] = 0;
      uPx0[sp] = px[from]; px[to] = px[from]; px[from] = 0;
      um[to] = 1; um[from] = 0;
      for (let i = 0; i < crowns.length; i++) {
        uCrownSq[sp * crowns.length + i] = crowns[i].sq;
        if (crowns[i].sq === from || crowns[i].sq === capSq) crowns[i].sq = to;
      }
      // same-piece streaks (exhaustion / moving)
      uLast[sp] = lastSq[color]; uStreak[sp] = streak[color]; uMovingFl[sp] = -1;
      streak[color] = lastSq[color] === from ? streak[color] + 1 : 1;
      lastSq[color] = to;
      if (movingCard[color] && streak[color] >= 5 && !(fl[to] & IMMUNE)) { uMovingFl[sp] = fl[to]; fl[to] |= IMMUNE; }
      // Castling: king moving two files moves the rook beside it.
      if (kd.name === "king" && Math.abs((to & 7) - (from & 7)) === 2 && (to >> 3) === (from >> 3)) {
        const row = from & ~7, kingSide = (to & 7) > (from & 7);
        const rf = row + (kingSide ? 7 : 0), rt = to + (kingSide ? -1 : 1);
        // Only a real castle: our own piece on the corner and an empty square
        // for it next to the king.
        if (pk[rf] && pc[rf] === color && !pk[rt]) { const rk = pk[rf], rc = pc[rf]; lift(rf); put(rt, rk, rc, 1); fl[rt] = fl[rf]; fl[rf] = 0; lk[rt] = lk[rf]; fu[rt] = fu[rf]; lk[rf] = -1; fu[rf] = 0; lb[rt] = lb[rf]; vd[rt] = vd[rf]; lb[rf] = 0; vd[rf] = 0; px[rt] = px[rf]; px[rf] = 0; uRookUm[sp] = um[rf]; um[rt] = 1; um[rf] = 0; uRookFrom[sp] = rf; uRookTo[sp] = rt; }
      }
      ep = -1;
      if (kd.pawn && Math.abs((to >> 3) - (from >> 3)) === 2) ep = ((from + to) >> 1);
      if (dieAt >= 0 && pk[dieAt]) {
        logChange(dieAt, F_PIECE, pk[dieAt] | (pc[dieAt] << 8) | (pm[dieAt] << 9) | (fl[dieAt] << 10));
        lift(dieAt); fl[dieAt] = 0;
      }
      if (timed && ends) boundary(color);
      if (anyCountVictory) {
        // penta check: did this move give check?
        uPenta[sp] = 0;
        if (pentaOn[color] && attackers(color, kingSq[color ^ 1]) > 0) { pentaCnt[color]++; uPenta[sp] = 1; }
        // antichess: consecutive enemy captures of the other side's pieces
        const victim = color ^ 1;
        uAnti[sp * 2] = antiCnt[0]; uAnti[sp * 2 + 1] = antiCnt[1];
        if (antiOn[victim]) antiCnt[victim] = cap ? antiCnt[victim] + 1 : 0;
      }
      // prophecy breaks on any capture (and on a check for the check-free one)
      uProph[sp] = 0;
      if (prophecies.length && (cap || prophecies.some((p) => p.checkFree) && (attackers(color, kingSq[color ^ 1]) > 0 || attackers(color ^ 1, kingSq[color]) > 0))) { prophecyBroken++; uProph[sp] = 1; }
      // turn structure: under acceleration a side acts twice before passing
      moverAt[sp] = color; uAct[sp] = actionsLeft; uSwitch[sp] = 1;
      if (actionsLeft === 2) { h1 ^= ZACT1; h2 ^= ZACT2; }
      if (cont) uSwitch[sp] = 0;
      else if (accelOn && actionsLeft > 1) { actionsLeft--; uSwitch[sp] = 0; }
      else actionsLeft = accelOn ? 2 : 1;
      if (actionsLeft === 2) { h1 ^= ZACT1; h2 ^= ZACT2; }
      if (uSwitch[sp]) {
        side ^= 1; h1 ^= ZSIDE1; h2 ^= ZSIDE2; tp++;
        // crown: the side whose turn starts counts a held move
        for (let i = 0; i < crowns.length; i++) {
          const cq = crowns[i].sq;
          if (pk[cq] && pc[cq] === side && !kinds[pk[cq] - 1].royal && !kinds[pk[cq] - 1].block) {
            logChange(i, F_CROWN, (side << 16) | crowns[i].held[side]);
            crowns[i].held[side]++;
          }
        }
      }
      sp++;
      return cap;
    }

    // End of a side's turn: lunchbox timers of its pieces tick (safe when
    // next to its king, otherwise one move closer to dying), then pawns whose
    // VIP time has come turn into VIPs.
    // Scheduled board events: { ply, type: "removeFile", col },
    // { ply, type: "removeIsolated" } (pieces with no neighbour vanish), or
    // { ply, type: "spawn", sq, kind, color } (a piece appears, taking
    // whatever stands there unless it is royal).
    const events = Array.isArray(input.events) ? input.events.filter((e) => Number.isFinite(e.ply)) : [];
    if (events.length || forcedLeft > 0) timed = true;
    if (forcedLeft > 0) { h1 ^= ZF1[forcedSq]; h2 ^= ZF2[forcedSq]; }
    function removeAt(sq) {
      if (!pk[sq] || kinds[pk[sq] - 1].royal) return;
      logChange(sq, F_PIECE, pk[sq] | (pc[sq] << 8) | (pm[sq] << 9) | (fl[sq] << 10));
      lift(sq); fl[sq] = 0;
    }
    function boundary(color) {
      const ks = kingSq[color];
      for (let sq = 0; sq < 64; sq++) {
        if (!lb[sq] || !pk[sq] || pc[sq] !== color) continue;
        if (ks >= 0 && Math.max(Math.abs((sq >> 3) - (ks >> 3)), Math.abs((sq & 7) - (ks & 7))) <= 1) {
          logChange(sq, F_LB, lb[sq]); lb[sq] = 0; continue;
        }
        logChange(sq, F_LB, lb[sq]); lb[sq]--;
        if (lb[sq] === 0) {
          logChange(sq, F_PIECE, pk[sq] | (pc[sq] << 8) | (pm[sq] << 9) | (fl[sq] << 10));
          lift(sq); fl[sq] = 0;
        }
      }
      const plyAfter = rootPly + tp + 1;
      for (let sq = 0; sq < 64; sq++) {
        const s1 = px[sq];
        if (!s1 || !pk[sq] || !slotTxp[s1] || slotTxp[s1] > plyAfter) continue;
        if (!slotTxk[s1]) { removeAt(sq); continue; }
        if (pk[sq] === slotTxk[s1]) continue;
        logChange(sq, F_KIND, pk[sq]);
        const c0 = pc[sq], m0 = pm[sq];
        lift(sq); put(sq, slotTxk[s1], c0, m0);
      }
      if (ultimatumPly !== null && plyAfter === ultimatumPly) {
        for (let sq = 0; sq < 64; sq++) if (pk[sq] && !um[sq] && !kinds[pk[sq] - 1].pawn && !kinds[pk[sq] - 1].block && !kinds[pk[sq] - 1].royal) removeAt(sq);
      }
      if (collapse && plyAfter === collapse.ply && blockKind) {
        for (let sq = 0; sq < 64; sq++) {
          const r = sq >> 3, c = sq & 7;
          if (Math.min(r, c, 7 - r, 7 - c) !== collapse.depth) continue;
          if (pk[sq]) { if (kinds[pk[sq] - 1].royal) continue; removeAt(sq); }
          logChange(sq, F_SPAWN, 0); put(sq, blockKind, 0, 1); fl[sq] = 0;
        }
      }
      for (const ev of events) {
        if (ev.ply !== plyAfter) continue;
        if (ev.type === "spawn") {
          const k = kindIndex.get(ev.kind);
          if (!k || !(ev.sq >= 0 && ev.sq < 64)) continue;
          if (pk[ev.sq]) {
            if (kinds[pk[ev.sq] - 1].royal) continue;
            removeAt(ev.sq);
          }
          logChange(ev.sq, F_SPAWN, 0);
          put(ev.sq, k, ev.color, 1); fl[ev.sq] = 0;
        } else if (ev.type === "strike") {
          // a spell lands: whatever stands on its cells dies, royal pieces too
          for (const q of ev.cells ?? []) {
            if (!(q >= 0 && q < 64) || !pk[q] || kinds[pk[q] - 1].block) continue;
            if (kinds[pk[q] - 1].royal) { logChange(q, F_ROYAL, pc[q]); royalLost[pc[q]]++; }
            logChange(q, F_PIECE, pk[q] | (pc[q] << 8) | (pm[q] << 9) | (fl[q] << 10));
            lift(q); fl[q] = 0;
          }
        } else if (ev.type === "removeFile") for (let r = 0; r < 8; r++) removeAt(r * 8 + ev.col);
        else if (ev.type === "removeIsolated") {
          const doomed = [];
          for (let sq = 0; sq < 64; sq++) {
            if (!pk[sq] || kinds[pk[sq] - 1].block) continue;
            let alone = true;
            for (let dr = -1; dr <= 1 && alone; dr++) for (let dc = -1; dc <= 1 && alone; dc++) {
              if (!dr && !dc) continue;
              const r = (sq >> 3) + dr, c = (sq & 7) + dc;
              if (r >= 0 && r <= 7 && c >= 0 && c <= 7 && pk[r * 8 + c]) alone = false;
            }
            if (alone) doomed.push(sq);
          }
          for (const sq of doomed) removeAt(sq);
        }
      }
      if (vipKind) for (let sq = 0; sq < 64; sq++) {
        if (!vd[sq] || !pk[sq] || vd[sq] > plyAfter) continue;
        logChange(sq, F_VD, vd[sq]); vd[sq] = 0;
        if (!kinds[pk[sq] - 1].pawn) continue;
        logChange(sq, F_KIND, pk[sq]);
        const c = pc[sq], mv = pm[sq];
        lift(sq); put(sq, vipKind, c, mv);
      }
    }
    function unboundary() {
      while (gLen > 0 && gSp[gLen - 1] === sp) {
        gLen--;
        const sq = gSq[gLen], old = gOld[gLen];
        switch (gField[gLen]) {
          case F_LB: lb[sq] = old; break;
          case F_VD: vd[sq] = old; break;
          case F_PIECE: put(sq, old & 255, (old >> 8) & 1, (old >> 9) & 1); fl[sq] = (old >> 10) & 63; break;
          case F_KIND: { const c = pc[sq], mv = pm[sq]; lift(sq); put(sq, old, c, mv); break; }
          case F_SPAWN: lift(sq); fl[sq] = 0; break;
          case F_ROYAL: royalLost[old]--; break;
          case F_CROWN: crowns[sq].held[old >> 16] = old & 0xffff; break;
        }
      }
    }
    function unmake(m) {
      sp--;
      const from = mFrom(m), to = mTo(m);
      if (uSwitch[sp]) { side ^= 1; h1 ^= ZSIDE1; h2 ^= ZSIDE2; tp--; }
      for (let i = 0; i < crowns.length; i++) crowns[i].sq = uCrownSq[sp * crowns.length + i];
      if (actionsLeft === 2) { h1 ^= ZACT1; h2 ^= ZACT2; }
      actionsLeft = uAct[sp];
      if (actionsLeft === 2) { h1 ^= ZACT1; h2 ^= ZACT2; }
      if (uProph[sp]) prophecyBroken--;
      if (forcedLeft > 0) { h1 ^= ZF1[forcedSq]; h2 ^= ZF2[forcedSq]; }
      forcedSq = uFSq[sp]; forcedLeft = uFLeft[sp];
      forcedSide = uFMeta[sp] & 1; forcedDies = (uFMeta[sp] & 2) !== 0; forcedNoKing = (uFMeta[sp] & 4) !== 0;
      if (forcedLeft > 0) { h1 ^= ZF1[forcedSq]; h2 ^= ZF2[forcedSq]; }
      const mover0 = moverAt[sp];
      streak[mover0] = uStreak[sp]; lastSq[mover0] = uLast[sp];
      if (uMovingFl[sp] >= 0) fl[to] = uMovingFl[sp];
      if (anyCountVictory) {
        if (uPenta[sp]) pentaCnt[mover0]--;
        antiCnt[0] = uAnti[sp * 2]; antiCnt[1] = uAnti[sp * 2 + 1];
      }
      if (timed) unboundary();
      if (uRookFrom[sp] >= 0) { const rf = uRookFrom[sp], rt = uRookTo[sp], rk = pk[rt], rc = pc[rt]; lift(rt); put(rf, rk, rc, 0); fl[rf] = fl[rt]; fl[rt] = 0; lk[rf] = lk[rt]; fu[rf] = fu[rt]; lk[rt] = -1; fu[rt] = 0; lb[rf] = lb[rt]; vd[rf] = vd[rt]; lb[rt] = 0; vd[rt] = 0; px[rf] = px[rt]; px[rt] = 0; um[rf] = uRookUm[sp]; um[rt] = 0; }
      const color = pc[to];
      lift(to);
      fl[to] = 0; lk[to] = -1; fu[to] = 0; lb[to] = 0; vd[to] = 0; px[to] = 0; um[to] = 0;
      put(from, uKind[sp], color, uMoved[sp]);
      fl[from] = uFl[sp] & 63; lk[from] = uLk0[sp]; fu[from] = uFu0[sp]; lb[from] = uLb0[sp]; vd[from] = uVd0[sp]; px[from] = uPx0[sp]; um[from] = uUm0[sp];
      const cap = uCap[sp];
      if (cap) {
        const cs = uCapSq[sp], ck = cap & 255, cc = (cap >> 8) & 1;
        if (kinds[ck - 1].royal) royalLost[cc]--;
        put(cs, ck, cc, (cap >> 9) & 1); fl[cs] = (uFl[sp] >> 6) & 63; lk[cs] = uLk1[sp]; fu[cs] = uFu1[sp]; lb[cs] = uLb1[sp]; vd[cs] = uVd1[sp]; px[cs] = uPx1[sp]; um[cs] = uUm1[sp];
      }
      ep = uEp[sp];
    }
    // A forced piece (extra move) with nowhere to go: the game closes the
    // window and the turn passes.
    function passForced() {
      uFSq[sp] = forcedSq; uFLeft[sp] = forcedLeft;
      uFMeta[sp] = forcedSide | (forcedDies ? 2 : 0) | (forcedNoKing ? 4 : 0);
      if (forcedLeft > 0) { h1 ^= ZF1[forcedSq]; h2 ^= ZF2[forcedSq]; }
      forcedSq = -1; forcedLeft = 0;
      uEp[sp] = ep; ep = -1; moverAt[sp] = side;
      side ^= 1; h1 ^= ZSIDE1; h2 ^= ZSIDE2; sp++; tp++;
    }
    function unpassForced() {
      sp--; tp--; side ^= 1; h1 ^= ZSIDE1; h2 ^= ZSIDE2; ep = uEp[sp];
      forcedSq = uFSq[sp]; forcedLeft = uFLeft[sp];
      forcedSide = uFMeta[sp] & 1; forcedDies = (uFMeta[sp] & 2) !== 0; forcedNoKing = (uFMeta[sp] & 4) !== 0;
      if (forcedLeft > 0) { h1 ^= ZF1[forcedSq]; h2 ^= ZF2[forcedSq]; }
    }
    function makeNull() { uEp[sp] = ep; ep = -1; moverAt[sp] = side; side ^= 1; h1 ^= ZSIDE1; h2 ^= ZSIDE2; sp++; tp++; }
    function unmakeNull() { sp--; tp--; side ^= 1; h1 ^= ZSIDE1; h2 ^= ZSIDE2; ep = uEp[sp]; }

    const hookSeen = new Uint8Array(64), extraSeen = new Uint8Array(64);
    const anySlots = slotExtra.length > 1;
    const extGen = typeof input.externalMoves === "function" ? input.externalMoves : null;
    const COLOR_NAMES = ["white", "black"];
    const occupantCache = new Map();
    const extAt = (r, c) => {
      if (r < 0 || r > 7 || c < 0 || c > 7) return null;
      const sq = r * 8 + c;
      if (!pk[sq]) return null;
      const kd = kinds[pk[sq] - 1];
      const key = pk[sq] * 4 + (kd.block ? 2 : pc[sq]);
      let o = occupantCache.get(key);
      if (!o) {
        o = kd.block ? { type: "wall", color: "neutral" } : { type: kd.typeName, color: COLOR_NAMES[pc[sq]] };
        occupantCache.set(key, o);
      }
      return o;
    };
    // A capturable enemy piece on `to` (blockers such as walls and immune
    // pieces cannot be taken).
    const wandering = (sq, ply) => px[sq] !== 0 && slotSw[px[sq]] !== 0 && ply >= slotSw[px[sq]];
    const passable = (sq, me) => (pc[sq] === me ? fl[sq] & TRANS_OWN : fl[sq] & TRANS_FOE) !== 0 || (pc[sq] !== me && wandering(sq, rootPly + tp));
    const enemyAt = (to, me) => pk[to] && pc[to] !== me && !kinds[pk[to] - 1].block && !(fl[to] & IMMUNE) && !(px[to] && rootPly + tp < slotTuI[px[to]]);

    // Move generation into a buffer; returns count. capturesOnly for quiescence.
    function gen(buf, capturesOnly) {
      let n = 0;
      const me = side, fwd = me === 0 ? -8 : 8, startRow = me === 0 ? 6 : 1, promoRow = me === 0 ? 0 : 7;
      const ply = rootPly + tp;
      const pushPawn = (from, to) => {
        if ((to >> 3) === promoRow) { buf[n++] = enc(from, to, queenKind); if (!capturesOnly) buf[n++] = enc(from, to, knightKind); }
        else buf[n++] = enc(from, to, 0);
      };
      for (let from = 0; from < 64; from++) {
        if (!pk[from] || pc[from] !== me) continue;
        const kd = kinds[pk[from] - 1], r = from >> 3, c = from & 7;
        if (kd.block) continue;
        if (lk[from] === ply) continue; // counterattack lock: cannot move this ply
        if (fl[from] & FROZEN) continue;
        if (exhaust[me] && from === lastSq[me] && streak[me] >= 3 && !kd.royal) continue;
        if (forcedLeft > 0 && me === forcedSide && from !== forcedSq) continue;
        const s1 = px[from];
        if (s1 && ply < slotTuF[s1]) continue;
        const canCap = !(fl[from] & NO_CAPTURE) && !(fu[from] > ply) && !(s1 && ply < slotTuN[s1]) && !(s1 && wandering(from, ply));
        if (!canCap && capturesOnly && !kd.pawn) continue;
        const noKing = forcedNoKing && forcedLeft > 0 && me === forcedSide;
        const eats = (fl[from] & EAT_OWN) !== 0;
        const cap = (to) => (canCap && enemyAt(to, me) && !banned(me, from, to) && !(noKing && kinds[pk[to] - 1].royal && !kinds[pk[to] - 1].secondary))
          || (eats && pk[to] && pc[to] === me && to !== from && !kinds[pk[to] - 1].royal && !kinds[pk[to] - 1].block);
        if (kd.external && extGen) {
          // The game's own movement function decides the geometry; capture
          // permission (immune, blockers, capture bans) is still ours.
          const list = extGen(kd.typeName, r, c, me, pm[from], extAt);
          for (let i = 0; i < list.length; i++) {
            const mv = list[i], rr = mv.row, cc = mv.col;
            if (!(rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7)) continue;
            const to = rr * 8 + cc;
            if (to === from) continue;
            if (pk[to]) { if (cap(to)) buf[n++] = enc(from, to, 0); }
            else if (!capturesOnly) buf[n++] = enc(from, to, 0);
          }
          continue;
        }
        if (kd.pawn) {
          const one = from + fwd;
          if (one < 0 || one > 63) continue;
          const straightMove = kd.pawn === 1, diagMove = kd.pawn === 2;
          // captures
          if (straightMove) {
            for (const dc of [-1, 1]) {
              const cc = c + dc; if (cc < 0 || cc > 7) continue;
              const to = one + dc;
              if (cap(to) || (canCap && to === ep && !pk[to])) pushPawn(from, to);
            }
            if (!pk[one] && (!capturesOnly || (one >> 3) === promoRow)) {
              pushPawn(from, one);
              const two = one + fwd;
              if (!capturesOnly && r === startRow && two >= 0 && two < 64 && !pk[two]) buf[n++] = enc(from, two, 0);
            }
          } else if (diagMove) {
            if (cap(one)) pushPawn(from, one);
            for (const dc of [-1, 1]) {
              const cc = c + dc; if (cc < 0 || cc > 7) continue;
              const to = one + dc;
              if (!pk[to] && (!capturesOnly || (to >> 3) === promoRow)) {
                pushPawn(from, to);
                const cc2 = c + 2 * dc, to2 = to + fwd + dc;
                if (!capturesOnly && r === startRow && cc2 >= 0 && cc2 <= 7 && to2 >= 0 && to2 < 64 && !pk[to2]) buf[n++] = enc(from, to2, 0);
              }
            }
          }
          continue;
        }
        for (const [dr, dc] of kd.leaps) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
          const to = rr * 8 + cc;
          if (pk[to] ? cap(to) : !capturesOnly) buf[n++] = enc(from, to, 0);
        }
        for (const [dr, dc] of kd.slides) {
          let rr = r + dr, cc = c + dc;
          while (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7) {
            const to = rr * 8 + cc;
            if (pk[to]) {
              if (passable(to, me)) { rr += dr; cc += dc; continue; }
              if (cap(to)) buf[n++] = enc(from, to, 0);
              break;
            }
            if (!capturesOnly) buf[n++] = enc(from, to, 0);
            rr += dr; cc += dc;
          }
        }
        if (kd.specs.length) {
          const fwdSign = me === 0 ? -1 : 1;
          for (const s of kd.specs) {
            const steps = s.ray || 1;
            for (const [d0, dc] of s.d) {
              const dr = s.rel ? d0 * fwdSign : d0;
              let rr = r + dr, cc = c + dc;
              for (let step = 0; step < steps && rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7; step++) {
                const to = rr * 8 + cc;
                if (pk[to]) {
                  if (steps > 1 && passable(to, me)) { rr += dr; cc += dc; continue; }
                  if (!s.quiet && cap(to) && (!s.royalOnly || kinds[pk[to] - 1].royal)) buf[n++] = enc(from, to, 0);
                  break;
                }
                if (!s.capOnly && !capturesOnly) buf[n++] = enc(from, to, 0);
                rr += dr; cc += dc;
              }
            }
          }
        }
        if (kd.teleportQuiet && !capturesOnly) {
          for (let to = 0; to < 64; to++) if (!pk[to]) buf[n++] = enc(from, to, 0);
        }
        if (kd.hop) {
          // Grasshopper: slide over empty squares, jump the first piece,
          // land on the square right behind it.
          for (const [dr, dc] of KING) {
            let rr = r + dr, cc = c + dc;
            while (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7 && !pk[rr * 8 + cc]) { rr += dr; cc += dc; }
            if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
            rr += dr; cc += dc;
            if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
            const to = rr * 8 + cc;
            if (pk[to] ? cap(to) : !capturesOnly) buf[n++] = enc(from, to, 0);
          }
        }
        if (kd.hook) {
          // Destinations are de-duplicated: a square reachable by several
          // paths is one move.
          const seen = hookSeen; seen.fill(0);
          const add = (to) => { if (!seen[to]) { seen[to] = 1; buf[n++] = enc(from, to, 0); } };
          for (const [dr, dc] of ORTHO) {
            let rr = r + dr, cc = c + dc;
            while (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7) {
              const to = rr * 8 + cc;
              if (pk[to]) { if (cap(to)) add(to); break; }
              if (!capturesOnly) add(to);
              // bend here: perpendicular legs
              for (const [tr, tc] of ORTHO) {
                if (tr * dr + tc * dc !== 0) continue;
                let br = rr + tr, bc = cc + tc;
                while (br >= 0 && br <= 7 && bc >= 0 && bc <= 7) {
                  const bt = br * 8 + bc;
                  if (pk[bt]) { if (cap(bt)) add(bt); break; }
                  if (!capturesOnly) add(bt);
                  br += tr; bc += tc;
                }
              }
              rr += dr; cc += dc;
            }
          }
        }
        if (kd.cannon) {
          // Cannon: quiet rook moves; captures the first piece past a screen.
          for (const [dr, dc] of ORTHO) {
            let rr = r + dr, cc = c + dc, screen = false;
            while (rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7) {
              const to = rr * 8 + cc;
              if (!screen) {
                if (!pk[to]) { if (!capturesOnly) buf[n++] = enc(from, to, 0); }
                else screen = true;
              } else if (pk[to]) { if (cap(to)) buf[n++] = enc(from, to, 0); break; }
              rr += dr; cc += dc;
            }
          }
        }
      }
      if (anySlots) n = correct(buf, n, capturesOnly, me, ply);
      return n;
    }

    // Apply each corrected piece's learned bans and extra offsets.
    function correct(buf, n, capturesOnly, me, ply) {
      let w = 0;
      for (let i = 0; i < n; i++) {
        const m = buf[i], f = mFrom(m), s0 = px[f];
        if (s0) {
          const t = mTo(m);
          if (slotBan[s0][offIdx((t >> 3) - (f >> 3), (t & 7) - (f & 7))]) continue;
        }
        buf[w++] = m;
      }
      n = w;
      for (let f = 0; f < 64; f++) {
        const s0 = px[f];
        if (!s0 || !pk[f] || pc[f] !== me || !slotExtra[s0].length) continue;
        if (lk[f] === ply || (fl[f] & FROZEN) || ply < slotTuF[s0]) continue;
        const canCap = !(fl[f] & NO_CAPTURE) && !(fu[f] > ply) && !(ply < slotTuN[s0]) && !wandering(f, ply);
        const have = extraSeen; have.fill(0);
        for (let i = 0; i < n; i++) if (mFrom(buf[i]) === f) have[mTo(buf[i])] = 1;
        const r = f >> 3, c = f & 7;
        for (const [dr, dc, ray] of slotExtra[s0]) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
          const t = rr * 8 + cc;
          if (have[t]) continue;
          if (ray) {
            // a sliding move: every square on the way must be empty
            const n0 = Math.max(Math.abs(dr), Math.abs(dc)), sr = Math.sign(dr), sc = Math.sign(dc);
            let blocked = false;
            for (let k = 1; k < n0 && !blocked; k++) if (pk[(r + sr * k) * 8 + c + sc * k]) blocked = true;
            if (blocked) continue;
          }
          if (pk[t]) { if (canCap && enemyAt(t, me) && !banned(me, f, t)) { buf[n++] = enc(f, t, 0); have[t] = 1; } }
          else if (!capturesOnly) { buf[n++] = enc(f, t, 0); have[t] = 1; }
        }
      }
      return n;
    }

    function squareTerms() {
      // Pieces next to a neutral monster may be taken when it moves: lose a
      // third of their value. Pieces within two squares of a platform get a
      // small bonus (a platform gives an extra move).
      let t = 0;
      for (let sq = 0; sq < 64; sq++) {
        if (!pk[sq]) continue;
        const kd = kinds[pk[sq] - 1];
        if (kd.block || kd.royal) continue;
        let v = 0;
        if (dangerSq[sq]) v -= Math.round(kd.value * 0.33);
        if (platformNear[sq]) v += 15;
        t += pc[sq] === 0 ? v : -v;
      }
      return t;
    }
    // Pawn structure (cached by pawn key), bishop pair, rooks on open files,
    // king shelter and enemy pieces near the king. White's view.
    const PASSED = [0, 10, 17, 25, 40, 65, 100, 0]; // by steps advanced from home rank
    const structureOn = input.evalStructure !== false;
    // Experimental terms (bit mask, default off): 1 pawn connections
    // (phalanx, pawn-defended pawns), 2 open files at the king, 4 passed pawn
    // vs king distance in the endgame.
    const EXTRA = input.evalExtra | 0;
    const PCACHE = 1 << 14;
    const pcKey = new Int32Array(PCACHE).fill(-1), pcBase = new Int32Array(PCACHE), pcPassed = new Int32Array(PCACHE);
    const pcPassSq = new Int8Array(PCACHE * 16).fill(-1); // passed pawn squares per slot (white 0-7, black 8-15)
    const pMin = new Int8Array(16), pMax = new Int8Array(16);
    function pawnTerms(slot) {
      pMin.fill(8); pMax.fill(-1);
      for (let sq = 0; sq < 64; sq++) {
        if (!pk[sq]) continue;
        const kd = kinds[pk[sq] - 1];
        if (!kd.pawn || kd.block) continue;
        const i = pc[sq] * 8 + (sq & 7), r = sq >> 3;
        if (r < pMin[i]) pMin[i] = r;
        if (r > pMax[i]) pMax[i] = r;
      }
      let base = 0, passedSum = 0;
      for (let col = 0; col < 2; col++) {
        const sign = col === 0 ? 1 : -1, en = (col ^ 1) * 8, me = col * 8;
        for (let f = 0; f < 8; f++) {
          const n = pawnFileCnt[me + f];
          if (n <= 0) continue;
          if (n > 1) base -= sign * 15 * (n - 1);
          if (!(f > 0 && pawnFileCnt[me + f - 1] > 0) && !(f < 7 && pawnFileCnt[me + f + 1] > 0)) base -= sign * 12 * n;
          // most advanced pawn on this file is passed if no enemy pawn is
          // ahead of it on this or an adjacent file (white moves to row 0)
          const r = col === 0 ? pMin[me + f] : pMax[me + f];
          let passed = true;
          for (let ff = Math.max(0, f - 1); ff <= Math.min(7, f + 1) && passed; ff++) {
            if (pawnFileCnt[en + ff] <= 0) continue;
            if (col === 0 ? pMin[en + ff] < r : pMax[en + ff] > r) passed = false;
          }
          if (passed) passedSum += sign * PASSED[Math.max(0, Math.min(7, col === 0 ? 6 - r : r - 1))];
          pcPassSq[slot * 16 + me + f] = passed ? r * 8 + f : -1;
        }
        for (let f = 0; f < 8; f++) if (pawnFileCnt[me + f] <= 0) pcPassSq[slot * 16 + me + f] = -1;
      }
      if (EXTRA & 1) {
        // side-by-side pawns +4 each, pawns defended by a pawn +6 each
        for (let sq = 0; sq < 64; sq++) {
          if (!pk[sq]) continue;
          const kd = kinds[pk[sq] - 1];
          if (!kd.pawn || kd.block) continue;
          const col = pc[sq], sign = col === 0 ? 1 : -1, r = sq >> 3, c = sq & 7, back = col === 0 ? r + 1 : r - 1;
          const isOwnPawn = (q) => pk[q] && pc[q] === col && kinds[pk[q] - 1].pawn && !kinds[pk[q] - 1].block;
          if (c < 7 && isOwnPawn(sq + 1)) base += sign * 4;
          if (back >= 0 && back < 8 && ((c > 0 && isOwnPawn(back * 8 + c - 1)) || (c < 7 && isOwnPawn(back * 8 + c + 1)))) base += sign * 6;
        }
      }
      pcKey[slot] = pawnKey; pcBase[slot] = base; pcPassed[slot] = passedSum;
    }
    function structureTerms(phase) {
      const slot = pawnKey & (PCACHE - 1);
      if (pcKey[slot] !== pawnKey) pawnTerms(slot);
      let t = pcBase[slot] + Math.round(pcPassed[slot] * (1.3 - 0.6 * phase));
      if (bishopCnt[0] >= 2) t += 30;
      if (bishopCnt[1] >= 2) t -= 30;
      for (let col = 0; col < 2; col++) {
        const sign = col === 0 ? 1 : -1, me = col * 8, en = (col ^ 1) * 8;
        for (let f = 0; f < 8; f++) {
          if (rookFileCnt[me + f] <= 0 || pawnFileCnt[me + f] > 0) continue;
          t += sign * rookFileCnt[me + f] * (pawnFileCnt[en + f] > 0 ? 10 : 20);
        }
      }
      if (phase > 0.2) {
        for (let col = 0; col < 2; col++) {
          const ks = kingSq[col];
          if (ks < 0) continue;
          const kr = ks >> 3, kc = ks & 7, rr = kr + (col === 0 ? -1 : 1);
          let v = 0;
          // own pawns on the three squares in front of the king
          if (rr >= 0 && rr < 8) for (let dc = -1; dc <= 1; dc++) {
            const cc = kc + dc; if (cc < 0 || cc > 7) continue;
            const q = rr * 8 + cc;
            if (pk[q] && pc[q] === col && kinds[pk[q] - 1].pawn) v += 12;
          }
          // enemy non-pawn pieces within two squares of the king
          for (let r = Math.max(0, kr - 2); r <= Math.min(7, kr + 2); r++) for (let c = Math.max(0, kc - 2); c <= Math.min(7, kc + 2); c++) {
            const q = r * 8 + c;
            if (pk[q] && pc[q] !== col) { const kd = kinds[pk[q] - 1]; if (!kd.pawn && !kd.block && !kd.royal) v -= 18; }
          }
          t += (col === 0 ? 1 : -1) * Math.round(v * phase);
        }
      }
      if ((EXTRA & 2) && phase > 0.2) {
        // the king's file and its neighbours: no own pawn -12, no pawn at all -8 more
        for (let col = 0; col < 2; col++) {
          const ks = kingSq[col];
          if (ks < 0) continue;
          const kc = ks & 7, me = col * 8, en = (col ^ 1) * 8;
          let v = 0;
          for (let f = Math.max(0, kc - 1); f <= Math.min(7, kc + 1); f++) {
            if (pawnFileCnt[me + f] > 0) continue;
            v -= 12;
            if (pawnFileCnt[en + f] <= 0) v -= 8;
          }
          t += (col === 0 ? 1 : -1) * Math.round(v * phase);
        }
      }
      if ((EXTRA & 4) && phase < 0.6) {
        // passed pawns in the endgame: (enemy king distance - own king
        // distance) to the square in front, 6 per step
        const w = 1 - phase;
        for (let i = 0; i < 16; i++) {
          const sq = pcPassSq[slot * 16 + i];
          if (sq < 0) continue;
          const col = i < 8 ? 0 : 1, r = sq >> 3, c = sq & 7, fr = col === 0 ? r - 1 : r + 1;
          if (fr < 0 || fr > 7) continue;
          const dist = (k) => (k < 0 ? 4 : Math.max(Math.abs((k >> 3) - fr), Math.abs((k & 7) - c)));
          t += (col === 0 ? 1 : -1) * Math.round(6 * w * (dist(kingSq[col ^ 1]) - dist(kingSq[col])));
        }
      }
      return t;
    }
    function evaluate() {
      if (nn) {
        const a = side === 0 ? accW : accB, b = side === 0 ? accB : accW, W2 = nn.W2;
        let o = nn.B2;
        for (let j = 0; j < nnH; j++) {
          let x = a[j]; x = x < 0 ? 0 : x > 1 ? 1 : x; o += W2[j] * x;
          let y = b[j]; y = y < 0 ? 0 : y > 1 ? 1 : y; o += W2[nnH + j] * y;
        }
        let v = Math.round(o * 400) + (side === 0 ? nnExtra : -nnExtra);
        if (evalSquares) v += side === 0 ? squareTerms() : -squareTerms();
        return v;
      }
      // Phase from non-pawn material: 0 = endgame, 1 = opening.
      const phase = Math.min(1, (nonPawn[0] + nonPawn[1]) / 6200);
      let s = score + (evalSquares ? squareTerms() : 0) + (structureOn ? structureTerms(phase) : 0);
      for (let color = 0; color < 2; color++) {
        const sq = kingSq[color];
        if (sq < 0) continue;
        const i = color === 0 ? sq : (7 - (sq >> 3)) * 8 + (sq & 7);
        const v = Math.round(PST.kingMid[i] * phase + PST.kingEnd[i] * (1 - phase));
        s += color === 0 ? v : -v;
      }
      return side === 0 ? s : -s;
    }

    // Did `color` (who just moved) leave a killer attacking the enemy king?
    // Then the game executes the king at the end of that turn.
    function executes(color) {
      if (!autoCnt[color]) return false;
      const ks = kingSq[color ^ 1];
      if (ks < 0 || (fl[ks] & IMMUNE)) return false;
      const kr = ks >> 3, kc = ks & 7;
      for (let sq = 0; sq < 64; sq++) {
        if (!pk[sq] || pc[sq] !== color || !kinds[pk[sq] - 1].autoExec) continue;
        if (fu[sq] > rootPly + tp - 1) continue; // freshly transformed: cannot capture yet
        const dr = kr - (sq >> 3), dc = kc - (sq & 7), ad = Math.abs(dr);
        if (ad !== Math.abs(dc) || ad < 1 || ad > 2) continue;
        if (ad === 2 && pk[sq + (dr / 2) * 8 + dc / 2]) continue;
        return true;
      }
      return false;
    }

    // At the start of `color`'s turn: can one of its Brutus pieces take its
    // own king? (The king is shown to the move generator as an enemy piece.)
    function betrays(color) {
      if (!betrayCnt[color]) return false;
      const ks = kingSq[color];
      if (ks < 0) return false;
      const save = side;
      pc[ks] = color ^ 1; side = color;
      let hit = false;
      try {
        const nn = gen(attackScratch, true);
        for (let i = 0; i < nn && !hit; i++) if (mTo(attackScratch[i]) === ks && kinds[pk[mFrom(attackScratch[i])] - 1].betrays) hit = true;
      } finally { pc[ks] = color; side = save; }
      return hit;
    }

    // Herald of `color` standing next to the enemy king?
    function heraldNext(color) {
      if (!proxCnt[color]) return false;
      const ks = kingSq[color ^ 1];
      if (ks < 0) return false;
      const kr = ks >> 3, kc = ks & 7;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const r = kr + dr, c = kc + dc;
        if (r < 0 || r > 7 || c < 0 || c > 7) continue;
        const sq = r * 8 + c;
        if (pk[sq] && pc[sq] === color && kinds[pk[sq] - 1].proximityWin) return true;
      }
      return false;
    }
    // Special victories decided by the position after `mover` moved.
    // Returns +1 if the mover has won, -1 if the other side has, 0 if none.
    const attackScratch = new Int32Array(1024);
    // Distinct pieces of `color` that could capture on `sq` right now.
    function attackers(color, sq) {
      if (sq < 0) return 0;
      const save = side; side = color;
      const nn = gen(attackScratch, true);
      side = save;
      let count = 0; const seen = new Set();
      for (let i = 0; i < nn; i++) if (mTo(attackScratch[i]) === sq && !seen.has(mFrom(attackScratch[i]))) { seen.add(mFrom(attackScratch[i])); count++; }
      return count;
    }
    function countVictory(mover) {
      const other = mover ^ 1;
      if (vGomoku[mover]) for (let c = 0; c < 8; c++) {
        let run = 0;
        for (let r = 0; r < 8; r++) { const sq = r * 8 + c; run = pk[sq] && pc[sq] === mover && !kinds[pk[sq] - 1].block ? run + 1 : 0; if (run >= 5) return 1; }
      }
      if (vRelig[mover] || vRelig[other] || vHigh[mover]) {
        let bm = 0, bo = 0; const types = new Map();
        for (let sq = 0; sq < 64; sq++) {
          if (!pk[sq] || kinds[pk[sq] - 1].block) continue;
          const tn = kinds[pk[sq] - 1].typeName;
          if (tn === "bishop") { if (pc[sq] === mover) bm++; else bo++; }
          if (pc[sq] === mover) types.set(tn, (types.get(tn) ?? 0) + 1);
        }
        if (vRelig[mover] && bm >= bo + 3) return 1;
        if (vRelig[other] && bo >= bm + 3) return -1;
        if (vHigh[mover] && types.size >= 4 && [...types.values()].every((v) => v === 1)) return 1;
      }
      if (vBina[mover] && attackers(mover, kingSq[other]) >= 2) return 1;
      if (pentaOn[mover] && pentaCnt[mover] >= 5) return 1;
      if (antiOn[other] && antiCnt[other] >= 4) return -1;
      return 0;
    }
    function ruleResult(mover) {
      // capture the flag: the mover's turn ended with an enemy on its flag
      if (flagSq[mover] >= 0 && pk[flagSq[mover]] && pc[flagSq[mover]] === (mover ^ 1) && !kinds[pk[flagSq[mover]] - 1].block) return -1;
      for (const c of crowns) { if (c.held[mover] >= 10) return 1; if (c.held[mover ^ 1] >= 10) return -1; }
      if (prophecies.length && !prophecyBroken) for (const p of prophecies) if (tp >= p.remaining) return p.color === mover ? 1 : -1;
      if (rootPly + tp >= revelationPly) {
        let mat = 0;
        for (let sq = 0; sq < 64; sq++) if (pk[sq] && !kinds[pk[sq] - 1].royal && !kinds[pk[sq] - 1].block) mat += (pc[sq] === mover ? 1 : -1) * kinds[pk[sq] - 1].value;
        return mat > 0 ? 1 : mat < 0 ? -1 : 2; // 2: draw
      }
      return 0;
    }
    function specialResult(mover) {
      if (racing[mover] && kingSq[mover] >= 0 && (kingSq[mover] >> 3) === (mover === 0 ? 0 : 7)) return 1;
      { const rr = ruleResult(mover); if (rr) return rr; }
      if (anyCountVictory) {
        const cv = countVictory(mover);
        if (cv) return cv;
        // hope: checked at the start of the side to move's turn
        if (vHope[mover ^ 1]) { let n0 = 0; for (let sq = 0; sq < 64; sq++) if (pk[sq] && pc[sq] === (mover ^ 1) && !kinds[pk[sq] - 1].block) n0++; if (n0 <= 2) return -1; }
      }
      if (heraldNext(mover)) return 1;
      if (heraldNext(mover ^ 1)) return -1;
      return 0;
    }

    const valueAt = (sq) => (pk[sq] ? kinds[pk[sq] - 1].value || 20000 : 0);
    const isKingCapture = (m) => { const t = mTo(m); return pk[t] && kinds[pk[t] - 1].royal && pc[t] !== side; };

    // Ordering state.
    const killers = new Int32Array(MAXPLY * 2);
    // 0.17 search options (each can be turned off for comparisons):
    // kingSafety (off by default until measured): no stand-pat in quiescence
    //   while our king is attacked;
    //   (kingExt, off by default: too slow) one more ply near the horizon when it is;
    // tt2: two-way TT buckets; aspiration: root window around the last score;
    // histMalus: history per color with a bounded bonus and a malus for
    //   quiet moves tried before the cutoff move
    const KS = !!input.kingSafety, KX = !!input.kingExt, TT2 = input.tt2 !== false, ASP = input.aspiration !== false, HM = input.histMalus !== false;
    const history = new Int32Array(2 * 64 * 64);
    const extPly = new Uint8Array(MAXPLY + 8);
    const quietTried = Array.from({ length: MAXPLY + 8 }, () => new Int32Array(256));
    const histAdd = (idx, b) => { if (HM) history[idx] += b - Math.trunc(history[idx] * Math.abs(b) / 16384); else history[idx] += b; };
    const bufs = Array.from({ length: MAXPLY + 8 }, () => new Int32Array(1024));
    const scores = Array.from({ length: MAXPLY + 8 }, () => new Int32Array(1024));

    let nodes = 0, deadline = 0, stopped = false, nodeCap = Infinity;
    const now = input.now || (() => performance.now());

    function order(ply, n, ttm) {
      const buf = bufs[ply], sc = scores[ply];
      for (let i = 0; i < n; i++) {
        const m = buf[i], to = mTo(m);
        let s;
        if (m === ttm) s = 1 << 30;
        else if (pk[to]) s = (1 << 28) + valueAt(to) * 16 - (valueAt(mFrom(m)) >> 4);
        else if (mPromo(m)) s = (1 << 27);
        else if (m === killers[ply * 2]) s = (1 << 26);
        else if (m === killers[ply * 2 + 1]) s = (1 << 26) - 1;
        else s = history[(HM ? side << 12 : 0) | (mFrom(m) << 6) | to];
        sc[i] = s;
      }
    }
    function pick(ply, n, i) {
      const buf = bufs[ply], sc = scores[ply];
      let best = i;
      for (let j = i + 1; j < n; j++) if (sc[j] > sc[best]) best = j;
      if (best !== i) { let t = buf[i]; buf[i] = buf[best]; buf[best] = t; t = sc[i]; sc[i] = sc[best]; sc[best] = t; }
      return buf[i];
    }

    // Child value from the mover's point of view: the side to move after a
    // move is normally the opponent (negate), but under acceleration it can
    // be the mover again (no negation).
    const sub = (mover, d, a, b, p, nul) => (side === mover ? negamax(d, a, b, p, nul) : -negamax(d, -b, -a, p, nul));
    const subQ = (mover, a, b, p) => (side === mover ? quiesce(a, b, p) : -quiesce(-b, -a, p));
    function quiesce(alpha, beta, ply, chk) {
      if ((++nodes & 1023) === 0 && (now() > deadline || nodes >= nodeCap)) { stopped = true; throw new AbortSearch(); }
      const prevQ = sp > 0 ? moverAt[sp - 1] : side ^ 1;
      if (royalLost[side] || kingSq[side] < 0 || (prevQ !== side && executes(prevQ))) return -MATE + ply;
      if (royalLost[side ^ 1] || kingSq[side ^ 1] < 0) return MATE - ply;
      if (prevQ !== side && betrays(side)) return -MATE + ply;
      { const sr = specialResult(prevQ); if (sr === 2) return 0; if (sr) return (sr > 0) === (prevQ === side) ? MATE - ply : -MATE + ply; }
      const stand = evaluate();
      // our king attacked (first quiescence ply only): standing pat would let
      // it be taken next turn, so every move is searched instead
      const inChk = chk && stand > alpha && kingSq[side] >= 0 && attackers(side ^ 1, kingSq[side]) > 0;
      if (!inChk) {
        if (stand >= beta) return stand;
        if (alpha < stand) alpha = stand;
      }
      if (ply >= MAXPLY) return stand;
      const n = gen(bufs[ply], !inChk);
      if (inChk && n === 0) return forcedLeft > 0 ? stand : -MATE + ply;
      order(ply, n, 0);
      for (let i = 0; i < n; i++) {
        const m = pick(ply, n, i);
        if (isKingCapture(m)) return MATE - ply - 1;
        // Delta pruning: skip captures that cannot raise alpha.
        if (!inChk && !mPromo(m) && stand + valueAt(mTo(m)) + 200 < alpha) continue;
        const mq = side;
        make(m);
        const v = subQ(mq, alpha, beta, ply + 1);
        unmake(m);
        if (v >= beta) return v;
        if (v > alpha) alpha = v;
      }
      return alpha;
    }

    function negamax(depth, alpha, beta, ply, allowNull) {
      const prevN = sp > 0 ? moverAt[sp - 1] : side ^ 1;
      if (royalLost[side] || kingSq[side] < 0 || (ply > 0 && prevN !== side && executes(prevN))) return -MATE + ply;
      if (ply > 0 && (royalLost[side ^ 1] || kingSq[side ^ 1] < 0)) return MATE - ply;
      if (ply > 0 && prevN !== side && betrays(side)) return -MATE + ply;
      if (ply > 0) { const sr = specialResult(prevN); if (sr === 2) return 0; if (sr) return (sr > 0) === (prevN === side) ? MATE - ply : -MATE + ply; }
      // king attacked near the horizon: one more ply (at most 2 per line)
      { const prevExt = ply > 0 ? extPly[ply - 1] : 0; let e = 0;
        if (KX && depth <= 2 && prevExt < 2 && ply > 0 && kingSq[side] >= 0 && attackers(side ^ 1, kingSq[side]) > 0) { depth++; e = 1; }
        extPly[ply] = prevExt + e; }
      if (depth <= 0) return quiesce(alpha, beta, ply, KS);
      if ((++nodes & 1023) === 0 && (now() > deadline || nodes >= nodeCap)) { stopped = true; throw new AbortSearch(); }
      if (ply >= MAXPLY) return evaluate();

      const s0 = TT2 ? (h1 & TT_MASK) & ~1 : h1 & TT_MASK, alpha0 = alpha;
      const slot = TT2 && ttKey[s0] !== h2 && ttKey[s0 | 1] === h2 ? s0 | 1 : s0;
      let ttm = 0;
      if (ttKey[slot] === h2) {
        ttm = ttMove[slot];
        if (ttDepth[slot] >= depth) {
          let s = ttScore[slot];
          if (s > MATE - 1000) s -= ply; else if (s < -MATE + 1000) s += ply;
          const f = ttFlag[slot];
          if (f === EXACT || (f === LOWER && s >= beta) || (f === UPPER && s <= alpha)) return s;
        }
      }

      const buf = bufs[ply];
      const n = gen(buf, false);
      for (let i = 0; i < n; i++) if (isKingCapture(buf[i])) return MATE - ply - 1;
      // Augment Chess: a side that cannot move at all loses (no stalemate).
      if (n === 0) {
        if (forcedLeft > 0 && side === forcedSide && ply < MAXPLY - 1) {
          passForced();
          const v = -negamax(depth - 1, -beta, -alpha, ply + 1, false);
          unpassForced();
          return v;
        }
        return -MATE + ply;
      }

      // Null move: skip a turn; if still >= beta, prune.
      if (allowNull && !accelOn && forcedLeft === 0 && depth >= 3 && nonPawn[side] > 0 && beta < MATE - 1000) {
        makeNull();
        const v = -negamax(depth - 3, -beta, -beta + 1, ply + 1, false);
        unmakeNull();
        if (v >= beta) return beta;
      }

      order(ply, n, ttm);
      let best = -INF, bestMove = 0, nq = 0;
      const qt = quietTried[ply];
      for (let i = 0; i < n; i++) {
        const m = pick(ply, n, i);
        const quiet = !pk[mTo(m)] && !mPromo(m);
        const mn = side;
        make(m);
        let v;
        if (i === 0) v = sub(mn, depth - 1, alpha, beta, ply + 1, true);
        else {
          // Late move reduction for quiet moves, then PVS re-search.
          const r = quiet && depth >= 3 && i >= 4 ? (i >= 12 ? 2 : 1) : 0;
          v = sub(mn, depth - 1 - r, alpha, alpha + 1, ply + 1, true);
          if (v > alpha && r) v = sub(mn, depth - 1, alpha, alpha + 1, ply + 1, true);
          if (v > alpha && v < beta) v = sub(mn, depth - 1, alpha, beta, ply + 1, true);
        }
        unmake(m);
        if (v > best) { best = v; bestMove = m; }
        if (v > alpha) alpha = v;
        if (alpha >= beta) {
          if (quiet) {
            if (killers[ply * 2] !== m) { killers[ply * 2 + 1] = killers[ply * 2]; killers[ply * 2] = m; }
            const hs = HM ? side << 12 : 0, b = Math.min(depth * depth, 400);
            histAdd(hs | (mFrom(m) << 6) | mTo(m), b);
            if (HM) for (let k = 0; k < nq; k++) histAdd(hs | (mFrom(qt[k]) << 6) | mTo(qt[k]), -b);
          }
          break;
        }
        if (quiet && nq < 256) qt[nq++] = m;
      }
      let stored = best;
      if (stored > MATE - 1000) stored += ply; else if (stored < -MATE + 1000) stored -= ply;
      const ss = !TT2 ? s0 : ttKey[s0] === h2 || ttGen[s0] !== ttAge || depth >= ttDepth[s0] ? s0 : s0 | 1;
      ttKey[ss] = h2; ttMove[ss] = bestMove; ttScore[ss] = stored; ttDepth[ss] = depth; ttGen[ss] = ttAge;
      ttFlag[ss] = best <= alpha0 ? UPPER : best >= beta ? LOWER : EXACT;
      return best;
    }

    // Debug/validation: list the engine's own moves for the side to move.
    if (input.listOnly) {
      const buf = new Int32Array(1024), n = gen(buf, false), out = [];
      for (let i = 0; i < n; i++) {
        const m = buf[i];
        out.push({ from: mFrom(m), to: mTo(m), promo: mPromo(m) ? kinds[mPromo(m) - 1].name : null });
      }
      return { ok: true, moves: out };
    }

    // Root: only the moves the game says are legal. Without a list (used when
    // scoring positions after a card), the engine's own moves are used.
    const rootMoves = [];
    let rootList = input.rootMoves;
    if (!rootList) {
      const buf = new Int32Array(1024), n = gen(buf, false);
      rootList = [];
      for (let i = 0; i < n; i++) {
        const m = buf[i];
        rootList.push({ from: mFrom(m), to: mTo(m), promo: mPromo(m) ? kinds[mPromo(m) - 1].name : null, key: `${mFrom(m)}-${mTo(m)}-${mPromo(m)}` });
      }
      // Augment Chess: a side with no move at all has lost.
      if (!rootList.length) return { ok: true, move: null, score: -MATE, depth: 0, nodes: 0, ms: 0, rootScores: [] };
    }
    for (const rm of rootList) {
      const promo = rm.promo ? kindIndex.get(rm.promo) || queenKind : 0;
      if (!pk[rm.from] || pc[rm.from] !== side) continue;
      rootMoves.push({ m: enc(rm.from, rm.to, promo), ref: rm, score: -INF });
    }
    if (!rootMoves.length) return { ok: false, reason: "no root moves" };

    // The side to move can take the enemy king right now.
    for (const r of rootMoves) {
      if (isKingCapture(r.m)) return { ok: true, move: r.ref, score: MATE - 1, depth: 1, nodes: 0, ms: 0, rootScores: [{ ...r.ref, score: MATE - 1 }] };
    }

    const started = now();
    deadline = started + Math.max(10, input.timeMs || 1000);
    // optional node budget: the same search on any machine (time stays a safety limit)
    nodeCap = input.maxNodes > 0 ? input.maxNodes : Infinity;
    // freshTT: forget earlier searches, so the same input gives the same result
    if (input.freshTT) ttKey.fill(0);
    ttAge = (ttAge + 1) & 255;
    // Time management (optional): a soft limit after which no new depth is
    // started (x1.5 while the best move is still changing), and no depth is
    // started that is predicted not to finish before the hard deadline
    // (time per depth grows by the measured factor). Time left unused is
    // saved for later moves.
    const softMs = input.softMs ?? (input.softFrac ? (input.timeMs || 1000) * input.softFrac : null);
    const soft = softMs != null ? started + Math.max(5, softMs) : null;
    let lastIterMs = 0, growth = 3, stopReason = "time", bestChanges = 0;
    const maxDepth = Math.min(input.maxDepth || 30, MAXPLY - 4);
    let bestRoot = rootMoves[0], completedDepth = 0, bestScore = -INF;
    const rootScores = new Map();

    let prevScore = null, scoreDrop = false, sameBest = 0, margin = 0;
    for (let depth = 1; depth <= maxDepth; depth++) {
      if (soft !== null && completedDepth >= 1 && rootMoves.length === 1) { stopReason = "only move"; break; }
      if (soft !== null && completedDepth >= 2) {
        const t = now(), span = soft - started;
        // a clear best that stayed the same: stop early (easy move);
        // a falling score (a threat was found): think twice as long;
        // a changing best: 1.5x
        if (!input.noEasy && completedDepth >= 5 && sameBest >= 2 && margin >= ROOT_BAND && t >= started + span * 0.4) { stopReason = "easy"; break; }
        const softEff = Math.min(deadline, started + span * (scoreDrop ? 2 : bestChanges > 0 ? 1.5 : 1));
        if (t >= softEff) { stopReason = "soft"; break; }
        if (!input.noPredict && t + lastIterMs * growth > deadline) { stopReason = "predicted"; break; }
      }
      const iterStart = now();
      let alpha = -INF, beta = INF, iterBest = null, iterScore = -INF;
      try {
        // Root move ordering: previous scores, then captures.
        rootMoves.sort((a, b) => b.score - a.score);
        for (let i = 0; i < rootMoves.length; i++) {
          const rmv = rootMoves[i], m = rmv.m;
          let v;
          if (isKingCapture(m)) v = MATE - 1;
          else {
            const mr = side;
            make(m);
            // Window reaches ROOT_BAND below the best, so moves close to the
            // best get true scores (callers rank and verify them); clearly
            // worse moves only get an upper bound.
            if (i === 0) {
              // aspiration: a narrow window around the last score first,
              // the full window only when the score falls outside it
              if (ASP && depth >= 4 && prevScore !== null && Math.abs(prevScore) < MATE - 1000) {
                const lo = prevScore - 50, hi = prevScore + 50;
                v = sub(mr, depth - 1, lo, hi, 1, true);
                if (v <= lo || v >= hi) v = sub(mr, depth - 1, alpha, beta, 1, true);
              } else v = sub(mr, depth - 1, alpha, beta, 1, true);
            } else {
              const low = alpha === -INF ? -INF : alpha - ROOT_BAND;
              v = sub(mr, depth - 1, low, alpha + 1, 1, true);
              if (v > alpha) v = sub(mr, depth - 1, alpha, beta, 1, true);
            }
            unmake(m);
          }
          rmv.score = v;
          rmv.exact = i === 0 || v > alpha - ROOT_BAND;
          if (v > iterScore) { iterScore = v; iterBest = rmv; }
          if (v > alpha) alpha = v;
        }
      } catch (e) {
        if (!(e instanceof AbortSearch)) throw e;
        // The board is left mid-line after an abort; it is not used again.
        // Partial iteration: the previous best is searched first, so if
        // another move already beat it at this depth, take that move.
        if (iterBest && completedDepth > 0 && iterBest !== bestRoot) {
          bestRoot = iterBest; bestScore = iterScore;
          // also in the ranked list the callers verify (it beat the old best
          // at a deeper level; its score came from a full-window search)
          if (input.partialRank !== false) rootScores.set(iterBest.ref, { score: iterScore, exact: true });
        }
        break;
      }
      bestChanges = completedDepth > 0 && iterBest !== bestRoot ? 1 : 0;
      sameBest = bestChanges || completedDepth === 0 ? 0 : sameBest + 1;
      scoreDrop = prevScore !== null && iterScore < prevScore - 50;
      prevScore = iterScore;
      // gap to the runner-up (its score is exact or an upper bound, so this
      // is a lower bound of the real gap)
      { let second = -INF; for (const r of rootMoves) if (r !== iterBest && r.score > second) second = r.score; margin = rootMoves.length > 1 ? iterScore - second : INF; }
      bestRoot = iterBest; bestScore = iterScore; completedDepth = depth;
      for (const r of rootMoves) rootScores.set(r.ref, { score: r.score, exact: !!r.exact });
      const iterMs = now() - iterStart;
      if (lastIterMs > 1 && iterMs > 1) growth = Math.max(1.5, Math.min(6, iterMs / lastIterMs));
      lastIterMs = iterMs;
      if (iterScore > MATE - 1000) { stopReason = "mate"; break; } // forced king capture found
      if (depth === maxDepth) stopReason = "depth";
    }
    return {
      ok: true,
      move: bestRoot.ref,
      score: bestScore,
      depth: completedDepth,
      nodes,
      stopReason,
      ms: Math.round(now() - started),
      rootScores: [...rootScores].map(([ref, s]) => ({ ...ref, score: s.score, exact: s.exact }))
    };
  }

  return { search, BUILTIN, ALIASES, resolveKind, MATE };
}

if (typeof module !== "undefined" && module.exports) module.exports = acbFastEngineModule;
else if (typeof globalThis !== "undefined") globalThis.acbFastEngineModule = acbFastEngineModule;
