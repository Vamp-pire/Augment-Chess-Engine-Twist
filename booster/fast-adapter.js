// Bridges the game's AI worker and fast-engine.js.
//
// This function's SOURCE is injected inside the game's worker scope, so the
// identifiers it uses (CanonicalEditorSession, canonicalAiMoveCandidates,
// canonicalAiActionCandidates, prepareCanonicalAiSearchSnapshot,
// projectCanonicalLocalSession, aiPieceValue) resolve to the game's own
// functions there. It is never called in the extension's own context.
//
// Cards: the game itself applies every playable card (with its target
// choices) exactly; the fast engine then searches the resulting position.
// A card is chosen only if it beats the best plain move by a margin.
function acbFastAdapterModule(engine) {
  "use strict";
  const KING_OFFSETS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const MATE = engine.MATE;
  const CARD_MARGIN = 50; // a used card is gone; keep it unless it clearly pays
  const sqOf = (name) => (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97);
  const other = (color) => (color === "white" ? "black" : "white");
  const now = () => performance.now();
  // Rule limits learned at the root of the current pick, by piece id
  // ({ noCapture, frozen }). Applied to every position read during the pick.
  let activeRestrict = new Map();
  // The game's own movement function (worker scope), if present.
  const gameMoves = typeof parrotBaseMoves === "function" ? parrotBaseMoves : null;

  // Wizard spells come as piece moves whose "promotion" names the spell.
  const SPELL = /^wizard-/;
  const isSpell = (a) => a?.intent?.kind === "piece_move" && SPELL.test(a.intent.payload?.promotion ?? "");
  const isMove = (a) => a?.intent?.kind === "piece_move" && !SPELL.test(a.intent.payload?.promotion ?? "");
  const SPELL_NAMES = { "wizard-lightning": "번개", "wizard-shield": "보호막", "wizard-meteor": "메테오", "wizard-time-stop": "시간 정지" };

  // ---- board conversion ---------------------------------------------------

  // Timed card effects stored on a piece, as engine timers (plies). Counts
  // given in "moves" are a side's own moves, about two plies each.
  function pieceTimers(attributes, plyNow) {
    const a = attributes ?? {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const inMoves = (v) => plyNow + Math.max(0, num(v)) * 2;
    const t = {};
    const until = (key, ply) => { if (ply > plyNow) t[key] = Math.max(t[key] ?? 0, ply); };
    if (num(a.frozenRemaining) > 0) { until("frozenUntil", inMoves(a.frozenRemaining)); until("immuneUntil", inMoves(a.frozenRemaining)); } // freeze
    if (num(a.stakedRemaining) > 0) until("frozenUntil", inMoves(a.stakedRemaining)); // stake
    if (num(a.poisonStunRemaining) > 0) until("frozenUntil", inMoves(a.poisonStunRemaining)); // poison stun
    if (num(a.sacrificeProtectionRemaining) > 0) until("immuneUntil", inMoves(a.sacrificeProtectionRemaining)); // sacrifice
    if (num(a.lastResistanceRemaining) > 0) until("immuneUntil", inMoves(a.lastResistanceRemaining)); // last resistance
    if (num(a.deceptionUntilPly) > plyNow) { until("immuneUntil", num(a.deceptionUntilPly)); until("noCaptureUntil", num(a.deceptionUntilPly)); } // deception barrier
    if (num(a.quantumNoCaptureUntilPly) > plyNow) until("noCaptureUntil", num(a.quantumNoCaptureUntilPly)); // quantum
    // scheduled changes (the latest one wins if several)
    if (num(a.holdoutDuePly) > plyNow) { t.transformAt = num(a.holdoutDuePly); t.transformTo = "queen"; } // holdout
    const bear = num(a.babyBearGrowthDuePly);
    if (bear > plyNow) { t.transformAt = bear; t.transformTo = "queen"; } // baby bear grows (bear moves like a queen)
    if (num(a.bribedRemaining) > 0) { t.transformAt = inMoves(a.bribedRemaining); t.transformTo = "knight"; } // bribe wears off
    if (num(a.necromancyRemaining) > 0) { t.transformAt = inMoves(a.necromancyRemaining); t.transformTo = null; } // revived piece expires
    return Object.keys(t).length ? t : null;
  }

  // Scheduled board events and count-based victory states from the view.
  function boardSchedule(view, game, plyNow, actor) {
    const events = [];
    const turnsUntil = (n, color) => plyNow + Math.max(0, n) * 2 - (color && color !== actor ? 1 : 0);
    for (const b of view.pendingBombardments ?? []) {
      if (Number.isInteger(b?.col) && Number.isFinite(Number(b.remaining))) events.push({ type: "removeFile", col: b.col, ply: turnsUntil(Number(b.remaining), b.by) });
    }
    for (const g of view.pendingGales ?? []) {
      const taken = Number(view.turnsTaken?.[g.color] ?? 0);
      const left = Number.isFinite(Number(g.remainingOwnTurns)) ? Number(g.remainingOwnTurns) : Number(g.triggerTurn) - taken;
      if (Number.isFinite(left)) events.push({ type: "removeIsolated", ply: turnsUntil(left, g.color) });
    }
    // Scheduled spawns: ascension (queen lands), otherworld (wizard appears
    // after N plies), red card (the exiled piece comes back).
    const spawnKinds = {};
    const spawn = (square, type, color, ply) => {
      if (typeof square !== "string" || !/^[a-h][1-8]$/.test(square) || !Number.isFinite(ply) || ply <= plyNow) return;
      const kind = engine.resolveKind(type) ?? `${type}@${color}`;
      if (!engine.BUILTIN[kind]) spawnKinds[kind] = { external: true, typeName: type, value: Math.max(0, Math.min(5000, aiPieceValue({ type }))), pst: "none" };
      events.push({ type: "spawn", sq: sqOf(square), kind, color: color === "white" ? 0 : 1, ply });
    };
    for (const t of game.cardState.pending?.triggers ?? []) {
      const p = t.payload ?? {};
      if (t.kind === "ascension-return") spawn(p.square, "queen", t.actor, Number.isFinite(Number(p.duePly)) ? Number(p.duePly) : plyNow + Number(p.remaining) * 2);
      else if (t.kind === "otherworld-return") spawn(p.square, "wizard", p.color ?? t.actor, plyNow + Number(p.remainingMoves));
      else if (t.kind === "wizard-hazard" && Number(p.duePly) > plyNow) {
        // lightning / meteor: the marked cells are struck at duePly
        const cells = (p.cells ?? []).filter((x) => typeof x === "string" && /^[a-h][1-8]$/.test(x)).map(sqOf);
        if (cells.length) events.push({ type: "strike", cells, ply: Number(p.duePly) });
      }
    }
    for (const e of game.cardState.effects.global ?? []) {
      if (e.kind !== "judgment-exile" || !Number.isFinite(Number(e.attributes?.duePly))) continue;
      const m = e.attributes.metadata ?? {};
      spawn(e.attributes.originalSquare, m.typeOverride ?? m.baseType ?? "pawn", m.color ?? e.attributes.returnColor, Number(e.attributes.duePly));
    }
    const colors = ["white", "black"];
    const flag = (obj) => colors.map((c) => Boolean(obj?.[c]));
    const effectCount = (kind) => colors.map((c) => {
      const e = game.cardState.effects.colors?.[c]?.find((x) => x.kind === kind);
      return e && Number.isFinite(Number(e.attributes?.count)) ? Number(e.attributes.count) : undefined;
    });
    const hope = colors.map((c) => game.cardState.inventories[c].some((x) => x.cardId === "hope" && x.status === "APPLIED"));
    const victory = {
      gomoku: flag(view.gomoku), religious: flag(view.religiousVictory), highlander: flag(view.highlander),
      binaMate: flag(view.binaMate), hope, penta: effectCount("penta-check"), antichess: effectCount("antichess")
    };
    return { events, victory, spawnKinds };
  }

  // Rule cards that change the turn structure or add win conditions, and
  // board squares the evaluation should know about.
  function ruleInputs(view, game, plyNow, input) {
    const colors = ["white", "black"];
    const global = game.cardState.effects.global ?? [];
    const g = (kind) => global.find((e) => e.kind === kind)?.attributes ?? null;
    const colorFx = (color, kind) => game.cardState.effects.colors?.[color]?.find((e) => e.kind === kind)?.attributes ?? null;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const cell = (v) => {
      if (typeof v === "string" && /^[a-h][1-8]$/.test(v)) return sqOf(v);
      if (Number.isInteger(v?.row) && Number.isInteger(v?.col) && v.row >= 0 && v.row < 8 && v.col >= 0 && v.col < 8) return v.row * 8 + v.col;
      return -1;
    };
    const idSq = new Map();
    const ids = game.cardState.board.pieceIds;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (ids[r]?.[c]) idSq.set(ids[r][c], r * 8 + c);

    // Acceleration: two actions per turn once active.
    const acc = g("acceleration");
    if (acc && plyNow >= (num(acc.activeAfterPly) ?? Infinity)) {
      const left = acc.turnActor === game.position.turn ? Math.max(1, Math.min(2, num(acc.remaining) ?? 2)) : 2;
      input.accel = { on: true, left };
    }
    // Exhaustion / moving: consecutive moves with one piece.
    const ex = view.exhaustion ?? {}, mv = view.moving ?? {};
    input.exhaust = colors.map((c) => Boolean(ex[c]?.enabled));
    input.moving = colors.map((c) => Boolean(mv[c]?.enabled));
    input.streak = colors.map((c) => {
      const pr = (ex[c]?.enabled && ex[c]?.pieceId ? ex[c] : null) ?? (mv[c]?.enabled && mv[c]?.pieceId ? mv[c] : null);
      const sq = pr ? idSq.get(pr.pieceId) : undefined;
      return sq === undefined ? { sq: -1, n: 0 } : { sq, n: Math.max(0, num(pr.count) ?? 0) };
    });
    // Capture the flag.
    const ctf = g("capture-the-flag");
    if (ctf?.flags) input.flags = colors.map((c) => cell(ctf.flags[c]));
    // Crown: the holder's square (else the ground), held full moves per side.
    const crown = g("crown-rule");
    if (crown) {
      const at = crown.holderId && idSq.has(crown.holderId) ? idSq.get(crown.holderId) : cell(crown.ground);
      if (at >= 0) input.crowns = [{ sq: at, held: [num(crown.whiteHeldMoves) ?? 0, num(crown.blackHeldMoves) ?? 0] }];
    }
    // Prophecy: no capture (or check) for N plies wins for its owner.
    const proph = [];
    for (const c of colors) {
      const p = colorFx(c, "prophecy");
      const left = num(p?.remainingHalfTurns);
      if (p && left > 0) proph.push({ color: (colors.includes(p.by) ? p.by : c) === "white" ? 0 : 1, remaining: left, checkFree: p.checkFree === true });
    }
    if (proph.length) input.prophecy = proph;
    // Revelation (material version): after 60 full moves, more material wins.
    if (global.some((e) => e.kind === "revelation" && num(e.attributes?.materialTurnLimit))) {
      input.revelation = { ply: num(global.find((e) => e.kind === "revelation" && num(e.attributes?.materialTurnLimit)).attributes.materialTurnLimit) * 2 };
    }
    // Ultimatum: unmoved pieces vanish at duePly.
    const ult = g("ultimatum");
    if (ult && num(ult.duePly) > plyNow) {
      input.ultimatum = { ply: num(ult.duePly) };
      const moved = new Set(ult.movedIds ?? []);
      for (const p of input.board) if (p?.pieceId && moved.has(p.pieceId)) p.movedSinceUltimatum = true;
    }
    // Periodic collapse: every 20th full move the next ring falls.
    const pc = view.periodicCollapse ?? g("periodic-collapse");
    const nextFull = num(pc?.nextAt) ?? num(pc?.nextFullmove);
    if (pc && pc.enabled !== false && nextFull) {
      const depth = Math.max(0, num(g("collapse-state")?.depth) ?? num(view.collapseDepth) ?? 0);
      if (depth < 4) input.collapse = { ply: nextFull * 2, depth };
    }
    // Winter kingdom: frozen pieces thaw 3 full moves after the freeze; the
    // engine can plan attacks for the thaw.
    const winter = g("winter-kingdom");
    if (winter && Array.isArray(winter.frozenIds)) {
      const fullmove = Math.floor(plyNow / 2) + 1;
      const cycle = num(winter.cycle) ?? Math.floor((fullmove - 1) / 3) * 3;
      const thaw = Math.max(plyNow + 1, (cycle + 3) * 2);
      for (const p of input.board) {
        if (!p?.pieceId || !winter.frozenIds.includes(p.pieceId)) continue;
        p.timers = { ...(p.timers ?? {}), frozenUntil: Math.max(p.timers?.frozenUntil ?? 0, thaw), immuneUntil: Math.max(p.timers?.immuneUntil ?? 0, thaw) };
      }
    }
    // Monster: squares next to it are risky. Platform: its cell.
    const danger = new Set();
    const mark = (q) => {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = (q >> 3) + dr, c = (q & 7) + dc;
        if ((dr || dc) && r >= 0 && r < 8 && c >= 0 && c < 8) danger.add(r * 8 + c);
      }
    };
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (view.board[r]?.[c]?.type === "monster") mark(r * 8 + c);
      if ((game.cardState.board.installations?.[r]?.[c] ?? []).some((x) => x?.kind === "monster")) mark(r * 8 + c);
    }
    if (danger.size) input.danger = [...danger];
    const plat = g("platform-rule") ?? view.platformRule;
    const platSq = cell(plat?.cell);
    if (plat && plat.enabled !== false && platSq >= 0) input.platform = [platSq];
  }

  // Pieces whose capture ends the game (the game's royal list).
  const ROYAL_TYPES = new Set(["king", "royal-knight", "dark-wizard", "shotgun-king", "vip", "merchant", "time-traveler", "vampire-lord"]);
  const isRoyal = (record, p) => record?.baseType === "king" || ROYAL_TYPES.has(record?.typeOverride ?? record?.baseType) || ROYAL_TYPES.has(p?.type)
    || record?.attributes?.crownRoyal === true || record?.attributes?.editorRoyal === true;

  // Engine kind for a piece whose movement the engine knows exactly
  // (transcribed from the game's movement table), or null.
  function exactKind(p, record, view, game) {
    const type = p.type;
    if (type === "pawn" && p.berolinaPawn) return "berolina-pawn";
    if (type === "windmill") return (record?.attributes?.windmillMode ?? p.windmillMode) === "rook" ? "windmill-rook" : "windmill-bishop";
    if (type === "berserker") {
      let allies = 0;
      for (const row of view.board) for (const q of row) if (q?.color === p.color) allies++;
      return allies <= 5 ? "berserker-strong" : allies <= 9 ? "berserker-mid" : "berserker-weak";
    }
    if (type === "jester") {
      try { if (usesBorrowedCaptureRules(game)) return "jester-royal"; } catch { /* older rules */ }
    }
    // A herald whose king threat is suppressed cannot win by proximity.
    if (type === "herald" && (record?.attributes?.kingThreatSuppressed || p.kingThreatSuppressed)) return "herald-quiet";
    return engine.resolveKind(type);
  }

  // Board + kinds from a prepared snapshot. `learned` maps "type@color" to
  // offsets learned earlier; unknown pieces without offsets get `fallback`.
  function boardInput(snapshot, learned) {
    const game = snapshot.game;
    const board = game.position.board;
    if (board.length !== 8 || board.some((row) => row.length !== 8)) return { ok: false, reason: "board not 8x8" };
    const pieces = game.cardState.pieces;
    for (const piece of Object.values(pieces)) {
      if (Array.isArray(piece?.attributes?.largeFootprint)) return { ok: false, reason: "large piece on board" };
    }
    const view = projectCanonicalLocalSession(snapshot).boardPatch;
    const actor = game.position.turn;
    // Same ply counter as the game: (fullmove - 1) * 2 + (black ? 1 : 0).
    const plyNow = (Math.max(1, Number(game.position.fullmoveNumber) || 1) - 1) * 2 + (actor === "black" ? 1 : 0);
    const input = { turn: actor === "white" ? 0 : 1, board: new Array(64).fill(null), kinds: {}, rootMoves: null, rootPly: plyNow };
    input.kinds["herald-quiet"] = { ...engine.BUILTIN.herald, proximityWin: false };
    // Racing king objective (card): king on the far rank wins.
    const race = view.racingKing, macho = Boolean(view.machoChess);
    input.racing = [macho || race === true || race?.white === true, macho || race === true || race?.black === true];
    const unknown = new Map();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = view.board[r]?.[c];
      if (!p) continue;
      if (p.color !== "white" && p.color !== "black") {
        // Neutral objects (walls, terrain): never move, cannot be captured.
        input.kinds["neutral-block"] = { leaps: [], value: 0, pst: "none", block: true };
        input.board[r * 8 + c] = { kind: "neutral-block", color: 0, moved: true };
        continue;
      }
      const color = p.color === "white" ? 0 : 1;
      const record = pieces[game.cardState.board.pieceIds[r]?.[c]];
      let kind = exactKind(p, record, view, game);
      if (kind && isRoyal(record, p) && !engine.BUILTIN[kind]?.royal) {
        // A royal piece moving like another kind (e.g. a transformed king).
        const royalKind = `${kind}@royal`;
        input.kinds[royalKind] = { ...engine.BUILTIN[kind], royal: true, value: 0 };
        kind = royalKind;
      }
      if (!kind) {
        const key = `${p.type}@${p.color}`;
        if (!unknown.has(key)) unknown.set(key, { type: p.type, value: Math.max(0, Math.min(5000, aiPieceValue(record ?? p))), color: p.color, royal: isRoyal(record, p) });
        kind = key;
      }
      // Freshly transformed pieces cannot capture on the current move (the
      // game blocks them until its ply counter reaches freshNoCaptureUntilPly);
      // barrier pieces never capture and cannot be captured.
      const statuses = record?.statuses ?? [];
      const freshUntil = Number(record?.attributes?.freshNoCaptureUntilPly);
      const barrier = statuses.includes("barrier");
      // Temporary protection (vigilance) or protective statuses: cannot be
      // captured. Treated as lasting the whole search.
      const protectedNow = Number(p.vigilanceProtection?.remaining ?? record?.attributes?.vigilanceProtection?.remaining) > 0
        || statuses.some((s) => ["outpost-protected", "permanent-protection", "sacrifice-protection"].includes(s));
      const lockPly = Number(record?.attributes?.counterattackLockedPly ?? p.counterattackLockedPly);
      // Empty lunchbox (on any non-king piece): must stand next to its own
      // king within N of its owner's moves or it dies.
      const lunchbox = statuses.includes("empty-lunchbox") ? Number(record?.attributes?.emptyLunchboxRemaining ?? 3) : 0;
      // VIP card: a pawn still alive at this ply becomes a VIP (royal).
      const vipDue = Number(record?.attributes?.vipDuePly);
      const pieceId = game.cardState.board.pieceIds[r]?.[c];
      const limit = pieceId ? activeRestrict.get(pieceId) : null;
      const timers = pieceTimers(record?.attributes, plyNow) ?? limit?.timers ?? null;
      const pass = pieceId ? activeRestrict.get(`pass:${pieceId}`) : null;
      // Sleepwalking (side to move): wanders before this side's next turn.
      const sleepwalkFrom = record?.attributes?.sleepwalking === true && p.color === actor ? plyNow + 2 : undefined;
      input.board[r * 8 + c] = {
        kind, color, moved: !!p.moved, pieceId,
        frozen: !!limit?.frozen, timers, sleepwalkFrom,
        transOwn: !!pass?.own, transFoe: !!pass?.foe,
        extra: limit?.extra, banned: limit?.banned,
        lunchbox: lunchbox > 0 ? lunchbox : undefined,
        vipDue: Number.isFinite(vipDue) ? vipDue : undefined,
        freshUntil: Number.isFinite(freshUntil) ? freshUntil : undefined,
        lockPly: Number.isFinite(lockPly) ? lockPly : undefined,
        noCapture: barrier || !!limit?.noCapture,
        immune: barrier || protectedNow
      };
    }
    if (gameMoves) {
      // Pieces the engine does not model move by the game's own function.
      input.externalMoves = (type, row, col, colorIdx, moved, at) => {
        const color = colorIdx ? "black" : "white";
        try {
          return gameMoves({
            memory: { type }, row, col, color, moved: !!moved, rows: 8, cols: 8, at,
            canCapture: (target) => Boolean(target) && target.color !== color && target.color !== "neutral",
            state: game
          });
        } catch { return []; }
      };
    }
    const ep = game.position.enPassantTarget;
    input.ep = typeof ep === "string" && /^[a-h][1-8]$/.test(ep) ? sqOf(ep) : -1;
    const sched = boardSchedule(view, game, plyNow, actor);
    input.events = sched.events;
    input.victory = sched.victory;
    for (const [kind, def] of Object.entries(sched.spawnKinds)) if (!input.kinds[kind]) input.kinds[kind] = def;
    // Rule cards are optional: on a read error the search goes on without
    // the rest of them, and the error shows in the diagnostics.
    let ruleError = null;
    try { ruleInputs(view, game, plyNow, input); } catch (e) { ruleError = String(e?.message ?? e).slice(0, 200); }
    // Forced extra moves (desperado, platform, chains): the same piece moves
    // again before the turn passes.
    const forced = (game.cardState.pending?.actionWindows ?? []).find((w) => w.kind === "forced-extra-move" && w.status === "OPEN" && w.payload?.actor === actor);
    if (forced) {
      const ids = game.cardState.board.pieceIds;
      let at = -1;
      for (let r = 0; r < 8 && at < 0; r++) for (let c = 0; c < 8; c++) if (ids[r]?.[c] === forced.payload.pieceId) { at = r * 8 + c; break; }
      const left = Number(forced.payload.remaining);
      if (at >= 0 && left > 0) input.forced = { sq: at, left, side: actor === "white" ? 0 : 1, dies: forced.payload.reason === "desperado", noKing: forced.payload.reason === "desperado" };
    }
    input.capBans = activeCapBans;
    for (const p of input.board) if (p && activeEat.kinds[p.color]?.has(p.kind)) p.eatOwn = true;
    input.eatExtra = activeEat.extra;
    return { ok: true, input, unknown, actor, game, ruleError };
  }

  // Kinds for pieces the engine does not know, from what was learned.
  // The side to move ("own") is modelled cautiously (captures only where the
  // game showed a capture); the opponent's pieces are assumed to capture on
  // every square they can move to, so threats are not underestimated.
  function applyKinds(input, unknown, learned, ownColor) {
    if (input.externalMoves) {
      for (const [key, info] of unknown) {
        input.kinds[key] = { external: true, typeName: info.type, value: info.royal ? 0 : info.value, pst: "none", royal: !!info.royal };
      }
      return;
    }
    for (const [key, info] of unknown) {
      const l = learned.get(key);
      let specs, moves;
      if (!l) { specs = [{ d: KING_OFFSETS }]; moves = 8; } // never seen: king-like reach
      else if (info.color === ownColor) {
        specs = [{ d: l.capture }, { d: l.quiet.filter((o) => !l.capture.some((x) => x[0] === o[0] && x[1] === o[1])), quiet: true }];
        moves = l.capture.length + l.quiet.length;
      } else {
        specs = [{ d: [...l.capture, ...l.quiet] }];
        moves = l.capture.length + l.quiet.length;
      }
      input.kinds[key] = {
        specs, value: info.royal ? 0 : info.value, pst: "none", royal: !!info.royal,
        // Pieces valued 0 that cannot move (walls etc.) block and cannot be taken.
        block: info.value === 0 && moves === 0 && !info.royal
      };
    }
  }

  // Learn move offsets of unknown kinds from a list of legal actions,
  // separating moves onto empty squares from captures.
  function learnFrom(actions, input, unknown, learned, color) {
    const seen = new Map();
    for (const action of actions) {
      if (!isMove(action)) continue;
      const { from, to } = action.intent.payload;
      const f = sqOf(from), t = sqOf(to), piece = input.board[f];
      if (!piece || !unknown.has(piece.kind)) continue;
      if (!seen.has(piece.kind)) seen.set(piece.kind, { quiet: new Set(), capture: new Set() });
      const target = input.board[t];
      const off = `${(t >> 3) - (f >> 3)},${(t & 7) - (f & 7)}`;
      (target && target.color !== piece.color ? seen.get(piece.kind).capture : seen.get(piece.kind).quiet).add(off);
    }
    const parse = (set) => [...set].map((s) => s.split(",").map(Number));
    for (const [key, info] of unknown) {
      if (info.color !== color) continue;
      const s = seen.get(key) ?? { quiet: new Set(), capture: new Set() };
      learned.set(key, { quiet: parse(s.quiet), capture: parse(s.capture) });
    }
  }

  let lastOppSession = null; // session of the turn-flipped root (for probes)
  async function opponentMoves(snapshot, color) {
    const flipped = structuredClone(snapshot);
    flipped.game.position.turn = color;
    if (typeof flipped.game.turn === "string") flipped.game.turn = color;
    const s2 = await CanonicalEditorSession.restoreForAi(flipped);
    lastOppSession = s2;
    return canonicalAiMoveCandidates(s2, { canContinue: () => true }).actions;
  }

  // Friendly captures (e.g. the mad horse card: a knight may take its own
  // piece and move once more), found in the game's legal moves.
  let activeEat = { kinds: [new Set(), new Set()], extra: [false, false] };
  async function detectFriendlyCaptures(game, input, sides) {
    activeEat = { kinds: [new Set(), new Set()], extra: [false, false] };
    const board = game.position.board;
    const colorAt = (name) => { const v = board[8 - Number(name[1])]?.[name.charCodeAt(0) - 97]; return typeof v === "string" ? (v[0] === "w" ? 0 : v[0] === "b" ? 1 : -1) : -1; };
    for (const { color, actions, session } of sides) {
      if (!actions) continue;
      const own = actions.filter((a) => isMove(a) && colorAt(a.intent.payload.to) === color && colorAt(a.intent.payload.from) === color);
      if (!own.length || !session) continue;
      // one sample per kind, played for real: the target must disappear (a
      // swap or castling keeps it on the board, so it is no capture)
      const ids = game.cardState.board.pieceIds;
      const tested = new Set();
      for (const a of own) {
        const p = input.board[sqOf(a.intent.payload.from)];
        if (!p || tested.has(p.kind) || tested.size >= 3) continue;
        tested.add(p.kind);
        const to = a.intent.payload.to, from = a.intent.payload.from;
        const targetId = ids[8 - Number(to[1])]?.[to.charCodeAt(0) - 97], moverId = ids[8 - Number(from[1])]?.[from.charCodeAt(0) - 97];
        try {
          const b = session.forkForAi();
          if (!(await applyCanonicalAiCandidate(b, a)).ok) continue;
          const g2 = b.snapshot({ includeHistory: false }).game;
          if (g2.cardState.board.pieceIds.some((row) => row.includes(targetId))) continue; // not a capture
          activeEat.kinds[color].add(p.kind);
          // an extra move: the same side still moves, not because of
          // acceleration or a square-triggered extra move
          const win = (g2.cardState.pending?.actionWindows ?? []).find((w) => w.status === "OPEN" && w.payload?.pieceId === moverId);
          const otherReason = ["platform", "rook-lift", "underpromotion", "checker-chain", "desperado", "reposition"].includes(win?.payload?.reason);
          if (g2.status === "ACTIVE" && g2.position.turn === (color ? "black" : "white") && !input.accel?.on && !otherReason) activeEat.extra[color] = true;
        } catch { /* unknown */ }
      }
    }
    for (const p of input.board) if (p && activeEat.kinds[p.color].has(p.kind)) p.eatOwn = true;
    input.eatExtra = activeEat.extra;
  }

  // ---- automatic calibration ---------------------------------------------

  // Compares the game's legal moves with the engine's own moves for one side
  // and turns the differences into limits the engine can apply: a side that
  // can capture nothing although the engine sees captures (e.g. a capture
  // ban card), a piece the game will not move at all (frozen), a piece that
  // may move but not capture. Returns the number of limits found.
  function calibrate(input, color, actions, restrict, game) {
    if (!actions) return 0;
    // When does a side-wide limit end? The soonest "remaining" count among
    // timed effects on this side (e.g. initiative: 8), else never.
    let sideExpiry = null;
    for (const e of game?.cardState?.effects?.colors?.[color] ?? []) {
      const rem = Number(e?.attributes?.remaining);
      if (Number.isFinite(rem) && rem > 0) sideExpiry = Math.min(sideExpiry ?? Infinity, input.rootPly + rem);
    }
    const colorIdx = color === "white" ? 0 : 1;
    const own = engine.search({ ...input, turn: colorIdx, rootMoves: null, listOnly: true });
    if (!own.ok) return 0;
    const enemyAt = (sq) => input.board[sq] && input.board[sq].color !== colorIdx && input.board[sq].kind !== "neutral-block";
    const gameBy = new Map(), engBy = new Map();
    let gameMovesN = 0, gameCaps = 0, engCaps = 0;
    const entry = (map, f) => { if (!map.has(f)) map.set(f, { all: 0, caps: 0, to: new Set() }); return map.get(f); };
    for (const a of actions) {
      if (!isMove(a)) continue;
      const f = sqOf(a.intent.payload.from), t = sqOf(a.intent.payload.to);
      const g = entry(gameBy, f); g.all++; gameMovesN++; g.to.add(t);
      if (enemyAt(t)) { g.caps++; gameCaps++; }
    }
    for (const m of own.moves) {
      const e = entry(engBy, m.from); e.all++; e.to.add(m.to);
      if (enemyAt(m.to)) { e.caps++; engCaps++; }
    }
    if (!gameMovesN) return 0; // nothing to compare against
    const sideCannotCapture = gameCaps === 0 && engCaps > 0;
    let found = 0;
    for (let sq = 0; sq < 64; sq++) {
      const p = input.board[sq];
      if (!p || p.color !== colorIdx || p.kind === "neutral-block" || !p.pieceId) continue;
      const e = engBy.get(sq), g = gameBy.get(sq);
      const limit = {};
      // A limit already explained by a timed effect on the piece stays timed.
      if (p.timers) { /* frozen/protected/no-capture timers already set */ }
      else if (e?.all && !g) limit.frozen = true;
      else if (sideCannotCapture && sideExpiry) limit.timers = { noCaptureUntil: sideExpiry };
      else if (sideCannotCapture || (e?.caps && g && g.caps === 0)) limit.noCapture = true;
      if (g && !limit.frozen) {
        // Per-piece corrections as offsets from the piece: moves the game
        // allows that the engine misses, and the reverse.
        const off = (t) => [(t >> 3) - (sq >> 3), (t & 7) - (sq & 7)];
        // (castling is left out: the game lists it at the root and it depends
        // on rights the engine does not track deeper)
        const castle = (t) => (p.kind === "king" || p.kind.endsWith("@royal")) && (t >> 3) === (sq >> 3) && Math.abs((t & 7) - (sq & 7)) === 2;
        // A straight or diagonal extra whose path was empty here is treated
        // as a sliding move (blocked by pieces later); others are jumps.
        // A straight move the game allows through pieces means those pieces
        // are passable (ghost pawns for their own side, etc.): mark the
        // blockers instead of teaching this piece a jump.
        const explainedByPass = (t) => {
          const [dr, dc] = off(t), n0 = Math.max(Math.abs(dr), Math.abs(dc));
          if (!(dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc)) || n0 < 2) return false;
          const blockers = [];
          for (let k = 1; k < n0; k++) {
            const bsq = (((sq >> 3) + Math.sign(dr) * k) * 8) + (sq & 7) + Math.sign(dc) * k;
            if (input.board[bsq]) blockers.push(input.board[bsq]);
          }
          if (!blockers.length || blockers.some((b) => !b.pieceId)) return false;
          for (const b of blockers) {
            const key = `pass:${b.pieceId}`, cur = restrict.get(key) ?? {};
            if (b.color === colorIdx) { cur.own = true; b.transOwn = true; } else { cur.foe = true; b.transFoe = true; }
            restrict.set(key, cur);
          }
          return true;
        };
        // A straight or diagonal extra whose path was empty here is treated
        // as a sliding move (blocked by pieces later); others are jumps.
        const asExtra = (t) => {
          const [dr, dc] = off(t), n0 = Math.max(Math.abs(dr), Math.abs(dc));
          const line = dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc);
          return line && n0 > 1 ? [dr, dc, 1] : [dr, dc];
        };
        const extra = [...g.to].filter((t) => !e?.to.has(t) && !castle(t) && !explainedByPass(t)).map(asExtra);
        const banned = e ? [...e.to].filter((t) => !g.to.has(t) && !(limit.noCapture && enemyAt(t))).map(off) : [];
        if (extra.length) limit.extra = extra;
        if (banned.length) limit.banned = banned;
      }
      if (limit.frozen || limit.noCapture || limit.extra || limit.banned || limit.timers) {
        restrict.set(p.pieceId, limit);
        if (limit.frozen) p.frozen = true;
        if (limit.noCapture) p.noCapture = true;
        if (limit.timers) p.timers = limit.timers;
        if (limit.extra) p.extra = limit.extra;
        if (limit.banned) p.banned = limit.banned;
        found++;
      }
    }
    return found;
  }

  // ---- root analysis ------------------------------------------------------

  // Prepares the root: legal actions (moves + cards with their exact result
  // sessions), engine input and learned piece patterns.
  // ---- capture-rule probing -----------------------------------------------
  // Card rules that stop one kind from taking another (e.g. minor pieces
  // cannot take the queen) only show in the legal moves once such a capture
  // is on the board. They are found ahead of time: in a copy of the position
  // the target piece is put where the attacker could take it, and the game's
  // own move list for the attacker says whether the capture is allowed.
  // Cached per card set; each move adds a few pairs within its time budget.
  const capRuleCache = new Map(); // card-set signature -> { done, bans }
  let activeCapBans = [];
  // A piece record with no status and no timed attribute (a per-piece effect
  // must not be mistaken for a rule about the whole kind).
  const cleanRecord = (rec, plyNow) => {
    if (!rec) return false;
    if ((rec.statuses ?? []).length) return false;
    for (const [k, v] of Object.entries(rec.attributes ?? {})) {
      if (v === null || v === undefined || v === false || v === 0) continue;
      if (/Ply$/.test(k)) { if (Number(v) >= plyNow) return false; continue; } // still ahead: active
      if (/Remaining$/.test(k)) { if (Number(v) > 0) return false; continue; }
      if (/(Locked|Bound|Protection)$/.test(k)) return false;
    }
    return true;
  };
  // A target only needs no protection of its own (what it may capture does
  // not matter).
  const cleanTarget = (rec, plyNow) => {
    if (!rec) return false;
    if ((rec.statuses ?? []).length) return false;
    for (const [k, v] of Object.entries(rec.attributes ?? {})) {
      if (!/(Protection|Shield|Immune|Barrier|Sacrifice|Resistance)/i.test(k) || v === null || v === undefined || v === false || v === 0) continue;
      if (/Ply$/.test(k) ? Number(v) >= plyNow : /Remaining$/.test(k) ? Number(v) > 0 : true) return false;
    }
    return true;
  };
  const plainTarget = (p) => p && !p.immune && !p.timers;
  const plainPiece = (p) => p && !p.frozen && !p.noCapture && !p.immune && !p.timers && !p.transOwn && !p.transFoe && !p.lunchbox && !p.vipDue && !(p.lockPly >= 0) && !p.freshUntil && !p.sleepwalkFrom && !p.extra && !p.banned;
  function capRuleSignature(g) {
    const colors = ["white", "black"];
    return JSON.stringify([
      colors.map((c) => g.cardState.inventories[c].map((x) => `${x.cardId}:${x.status}`).sort()),
      [...new Set((g.cardState.effects.global ?? []).map((e) => e.kind))].sort(),
      g.cardState.profile?.catalogHash ?? null
    ]);
  }
  async function probeCaptureRules(snapshot, input, deadline) {
    const g = snapshot.game;
    const sig = capRuleSignature(g);
    let entry = capRuleCache.get(sig);
    if (!entry) {
      entry = { done: new Set(), bans: [] };
      capRuleCache.set(sig, entry);
      if (capRuleCache.size > 24) capRuleCache.delete(capRuleCache.keys().next().value);
    }
    // bans are re-checked after 12 plies (a rule may have been temporary)
    const plyNow = input.rootPly ?? 0;
    const kept = entry.bans.filter((b) => plyNow - b.ply <= 12 && plyNow >= b.ply);
    for (const b of entry.bans) if (!kept.includes(b)) entry.done.delete(`${b.by}|${b.a}|${b.t}`);
    entry.bans = kept;
    activeCapBans = entry.bans;
    if (now() > deadline) return;
    const records = g.cardState.pieces;
    const names = ["white", "black"];
    const valueOf = (kind) => input.kinds?.[kind]?.value ?? engine.BUILTIN[kind]?.value ?? 300;
    // one plain representative square per (color, kind)
    // up to two clean attackers per (colour, kind); one clean target
    const reps = [new Map(), new Map()], targets = [new Map(), new Map()];
    for (let q = 0; q < 64; q++) {
      const p = input.board[q];
      if (!p || p.kind === "neutral-block") continue;
      const clean = cleanRecord(records[p.pieceId], plyNow);
      if (clean && plainPiece(p)) { const l = reps[p.color].get(p.kind) ?? []; if (l.length < 2) l.push(q); reps[p.color].set(p.kind, l); }
      if (cleanTarget(records[p.pieceId], plyNow) && plainTarget(p) && !targets[p.color].has(p.kind)) targets[p.color].set(p.kind, q);
    }
    const pairs = [];
    for (const by of [0, 1]) for (const [a, aSqs] of reps[by]) for (const [t, tSq] of targets[by ^ 1]) {
      const key = `${by}|${a}|${t}`;
      if (!entry.done.has(key)) pairs.push({ by, a, aSqs, t, tSq, key, v: valueOf(t) });
    }
    pairs.sort((x, y) => y.v - x.v);
    const engineMoves = (board, by) => {
      const r = engine.search({ ...input, board, turn: by, rootMoves: null, listOnly: true, capBans: [] });
      return r.ok ? r.moves : [];
    };
    const name = (q) => "abcdefgh"[q & 7] + (8 - (q >> 3));
    // empty squares, centre first
    const empty = [];
    for (let q = 0; q < 64; q++) if (!input.board[q]) empty.push(q);
    const centre = (q) => Math.abs(3.5 - (q >> 3)) + Math.abs(3.5 - (q & 7));
    empty.sort((x, y) => centre(x) - centre(y));
    const kingOf = (board, color) => {
      for (let q = 0; q < 64; q++) {
        const p = board[q];
        if (p && p.color === color && (input.kinds?.[p.kind]?.royal || engine.BUILTIN[p.kind]?.royal) && !(input.kinds?.[p.kind]?.secondary || engine.BUILTIN[p.kind]?.secondary)) return q;
      }
      return -1;
    };
    for (const pair of pairs) {
      if (now() > deadline) break;
      let refusedAll = true, any = false;
      for (const aSq of pair.aSqs) {
      if (now() > deadline) { refusedAll = false; break; }
      const pr = { ...pair, aSq };
      let no = 0, yes = 0, tries = 0;
      const isPawn = !!(engine.BUILTIN[pr.a]?.pawn || input.kinds?.[pr.a]?.pawn);
      const spotsFrom = (bd, p) => {
        if (isPawn) {
          const r = (p >> 3) + (pr.by === 0 ? -1 : 1), c = p & 7;
          return [c - 1, c + 1].filter((cc) => r >= 0 && r < 8 && cc >= 0 && cc < 8 && !bd[r * 8 + cc]).map((cc) => r * 8 + cc);
        }
        return engineMoves(bd, pr.by).filter((m) => m.from === p && !bd[m.to] && !m.promo).map((m) => m.to);
      };
      const plan = [];
      for (const p of empty.slice(0, 6)) {
        if (plan.length >= 3) break;
        const bd1 = input.board.slice();
        bd1[p] = bd1[pr.aSq]; bd1[pr.aSq] = null;
        const qs = spotsFrom(bd1, p).filter((x) => x !== pr.tSq);
        if (qs.length) plan.push([p, qs[0]], ...(qs.length > 2 ? [[p, qs[qs.length - 1]]] : []));
      }
      for (const [found, q] of plan) {
        if (no >= 2 || yes || now() > deadline) break;
        const board = input.board.slice();
        board[found] = board[pr.aSq]; board[pr.aSq] = null;
        board[q] = board[pr.tSq]; board[pr.tSq] = null;
        // the engine must see the capture
        if (!engineMoves(board, pr.by).some((m) => m.from === found && m.to === q)) continue;
        tries++;
        // skip a test position where the attacker's own king is attacked
        const ks = kingOf(board, pr.by);
        if (ks >= 0 && engineMoves(board, pr.by ^ 1).some((m) => m.to === ks)) continue;
        const probe = structuredClone(snapshot);
        const pg = probe.game;
        const move = (from, to) => {
          const [fr, fc] = [from >> 3, from & 7], [tr, tc] = [to >> 3, to & 7];
          for (const bd of [pg.position.board, pg.pieceIdentity.board, pg.cardState.board.pieceIds]) { bd[tr][tc] = bd[fr][fc]; bd[fr][fc] = null; }
        };
        move(pr.aSq, found); move(pr.tSq, q);
        pg.position.turn = names[pr.by];
        if (typeof pg.turn === "string") pg.turn = names[pr.by];
        pg.position.enPassantTarget = null;
        let res;
        try {
          const sess = await CanonicalEditorSession.restoreForAi(probe);
          res = sess.listMoves(names[pr.by], name(found));
        } catch { res = null; }
        if (!res?.ok || !Array.isArray(res.allowed) || !res.allowed.length) continue; // inconclusive
        const allowedTo = new Set(res.allowed.filter((x) => isMove(x)).map((x) => x.intent.payload.to));
        if (allowedTo.has(name(q))) yes++; else no++;
      }
      if (yes) { refusedAll = false; any = true; break; }
      if (no >= 2) any = true; else refusedAll = false;
      }
      if (now() <= deadline || any) entry.done.add(pair.key);
      if (any && refusedAll) entry.bans.push({ by: pair.by, a: pair.a, t: pair.t, ply: plyNow });
    }
  }

  async function prepareRoot(snapshot, { cardDeadline, maxCardProbes, includeCards, probeMs = 0 }) {
    const game = snapshot.game;
    if (game.status !== "ACTIVE") return { ok: false, reason: `status ${game.status}` };
    const timing = {}; let tMark = now();
    const lap = (k) => { const t = now(); timing[k] = Math.round(t - tMark); tMark = t; };
    const session = await CanonicalEditorSession.restoreForAi(snapshot);
    lap("restore");
    if (session.localAiAutomaticCardsDue()) return { ok: false, reason: "automatic cards pending" };
    const query = includeCards
      ? await canonicalAiActionCandidates(session, {
        includeCards: true, maxCardProbes,
        canContinue: () => now() < cardDeadline,
        moveCanContinue: () => true
      })
      : { ...canonicalAiMoveCandidates(session, { canContinue: () => true }), successors: new Map() };
    lap("list");
    // Limits learned for an earlier position must not leak into this one.
    activeRestrict = new Map();
    activeEat = { kinds: [new Set(), new Set()], extra: [false, false] };
    const built = boardInput(snapshot);
    if (!built.ok) return built;
    const { input, unknown, actor } = built;
    const learned = new Map();
    learnFrom(query.actions, input, unknown, learned, actor);
    let oppActions = null;
    lastOppSession = null;
    lap("boardInput");
    try { oppActions = await opponentMoves(snapshot, other(actor)); } catch { oppActions = null; }
    lap("oppList");
    try {
      await detectFriendlyCaptures(game, input, [
        { color: actor === "white" ? 0 : 1, actions: query.actions, session },
        { color: actor === "white" ? 1 : 0, actions: oppActions, session: lastOppSession }
      ]);
    } catch { /* no friendly captures */ }
    lap("friendly");
    if (oppActions) learnFrom(oppActions, input, unknown, learned, other(actor));
    applyKinds(input, unknown, learned, actor);
    // Learn rule limits (capture bans, frozen pieces) for both sides from
    // the game's legal moves; they apply to every position read this pick.
    const limits = calibrate(input, actor, query.actions, activeRestrict, game) + calibrate(input, other(actor), oppActions, activeRestrict, game);
    lap("calibrate");
    // capture rules of the current card set (probed a little every move)
    try { await probeCaptureRules(snapshot, input, now() + probeMs); } catch { /* keep what is known */ }
    lap("capRules");
    input.capBans = activeCapBans;

    const byKey = new Map();
    input.rootMoves = [];
    for (const action of query.actions) {
      if (!isMove(action)) continue;
      const { from, to, promotion } = action.intent.payload;
      const f = sqOf(from), t = sqOf(to);
      if (!input.board[f]) continue;
      const promo = promotion && engine.BUILTIN[promotion] ? promotion : promotion ? "queen" : null;
      const key = `${f}-${t}-${promo}`;
      if (!byKey.has(key)) { byKey.set(key, action); input.rootMoves.push({ from: f, to: t, promo, key }); }
    }
    // cards, plus our wizard's spells (judged like cards: applied for real)
    const valueAtSq = (name) => { const p = input.board[sqOf(name)]; return p ? (input.kinds?.[p.kind]?.value ?? engine.BUILTIN[p.kind]?.value ?? 300) * (p.color === input.turn ? 0.5 : 1) : 0; };
    const spells = query.actions.filter(isSpell)
      .map((a) => ({ a, v: a.intent.payload.promotion === "wizard-time-stop" ? 400 : valueAtSq(a.intent.payload.to) }))
      .sort((x, y) => y.v - x.v).slice(0, 6).map((x) => x.a);
    const cardActions = [...query.actions.filter((a) => a.intent.kind !== "piece_move" && query.successors?.has(a)), ...spells];
    return { ok: true, session, input, byKey, learned, unknown, actor, query, cardActions, limits, ruleError: built.ruleError, timing };
  }

  // Everything the engine can see: piece kinds plus their timers and flags
  // (so a card that only sets a timer, e.g. empty lunchbox, is not "invisible").
  const signature = (input) => `${input.turn}|${input.board.map((p) => (p ? `${p.kind}:${p.color}:${p.lunchbox ?? ""}:${p.vipDue ?? ""}:${p.freshUntil ?? ""}:${p.lockPly ?? ""}:${p.immune ? 1 : 0}${p.noCapture ? 1 : 0}` : "")).join(",")}`;

  // Score (from `actor`'s side) of the exact position a card produced.
  // exact: use the game's legal moves at that position as the root list
  // (slower, but no approximation at the first ply).
  async function scoreAfterCard(branch, actor, learned, timeMs, { exact = false, rootSignature = null } = {}) {
    for (let i = 0; i < 8 && branch.localAiAutomaticCardsDue(); i++) {
      const auto = await branch.advanceLocalAiAutomaticCards();
      if (!auto.ok || !auto.changed) break;
    }
    const snap = await prepareCanonicalAiSearchSnapshot(branch.snapshot({ includeHistory: false }));
    const g = snap.game;
    if (g.status === "FINISHED") {
      const w = g.result?.winner ?? g.position?.winner;
      return { score: w === actor ? MATE : w ? -MATE : 0, depth: 0, finished: true, exact: true };
    }
    // A move can open a card draft (status DRAFTING): the board still
    // decides, so judge it with the engine; the game lists no moves then.
    const active = g.status === "ACTIVE";
    if (!active) exact = false;
    const built = boardInput(snap);
    if (!built.ok) return null;
    const sameTurn = g.position.turn === actor;
    // A card created a piece kind not seen before (e.g. a transformation):
    // learn its moves from the game's legal moves in this position.
    const mover = g.position.turn;
    const newKinds = [...built.unknown].filter(([key, info]) => info.color === mover && !learned.has(key));
    let moverActions = null;
    if (active && (newKinds.length || exact)) {
      moverActions = canonicalAiMoveCandidates(branch, { canContinue: () => true }).actions.filter(isMove);
      if (newKinds.length) {
        learned = new Map(learned);
        learnFrom(moverActions, built.input, built.unknown, learned, mover);
      }
    }
    applyKinds(built.input, built.unknown, learned, g.position.turn);
    // The card changed nothing the engine can see (e.g. a status effect).
    if (rootSignature && sameTurn && signature(built.input) === rootSignature) return { invisible: true, sameTurn };
    if (exact) {
      const actions = moverActions;
      if (!actions.length) {
        // No piece move. That is a loss only if the side has no other action
        // either (a card-response window, shotgun shots, a playable card).
        if (hasOtherActions(branch, snap, mover)) return null;
        return { score: sameTurn ? -MATE : MATE, depth: 0, exact: true, sameTurn };
      }
      built.input.rootMoves = actions.map((a) => {
        const { from, to, promotion } = a.intent.payload;
        return { from: sqOf(from), to: sqOf(to), promo: promotion && engine.BUILTIN[promotion] ? promotion : promotion ? "queen" : null, key: `${from}${to}` };
      });
    }
    built.input.timeMs = timeMs;
    const r = engine.search(built.input);
    if (!r.ok) return null;
    return { score: sameTurn ? r.score : -r.score, depth: r.depth, sameTurn, exact };
  }

  const cardLabel = (snapshot, actor, intent) => {
    const id = intent.payload?.cardInstanceId;
    const card = id ? snapshot.game.cardState.inventories[actor]?.find((c) => c.cardInstanceId === id) : null;
    const squares = intent.payload?.selection?.squares?.join(",") || "";
    return `${card?.cardId ?? intent.kind}${squares ? " " + squares : ""}${intent.payload?.choice ? " " + intent.payload.choice : ""}`;
  };

  // Our score after playing `action` for real (the game applies it). The
  // opponent's first reply comes from the game's own legal-move list, so a
  // piece left hanging to a capture the engine does not model (card-changed
  // pawns, special pieces) is still seen.
  async function exactAfterMove(session, action, actor, learned, timeMs) {
    const branch = session.forkForAi();
    const applied = await applyCanonicalAiCandidate(branch, action);
    if (!applied.ok) return null;
    const s = await scoreAfterCard(branch, actor, learned, timeMs, { exact: true });
    return s ? { ...s, branch } : null;
  }

  // Plays candidate moves for real in engine order and re-scores them.
  // ranked: [{ action, score }] with engine scores (upper bounds for all but
  // the best move). The real-outcome search is shallower, so it only pulls a
  // move DOWN (a surprise the engine could not see, e.g. an on-capture
  // effect). A final score never exceeds the engine score, so once the best
  // verified score reaches the next engine score nothing unverified can win.
  async function verifyRanked(sess, ranked, actor, learned, deadline) {
    ranked = ranked.filter((r) => r.action).sort((a, b) => b.score - a.score || (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
    const out = [];
    let bestFinal = -Infinity;
    for (let i = 0; i < ranked.length; i++) {
      if (out.length >= 2 && bestFinal >= ranked[i].score) break;
      const left = deadline - now();
      if (left < 40 && out.length) break;
      let exact = null;
      if (left > 40) {
        try { exact = await exactAfterMove(sess, ranked[i].action, actor, learned, Math.max(40, left / Math.min(4, ranked.length - i))); } catch { exact = null; }
      }
      const final = exact ? Math.min(ranked[i].score, exact.score + 30) : ranked[i].score;
      out.push({ kind: "move", action: ranked[i].action, score: final, realScore: exact?.score ?? null, branch: exact?.branch ?? null, engineScore: ranked[i].score, exact: !!exact });
      if (final > bestFinal) bestFinal = final;
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // After a card that keeps our turn: best follow-up move, verified for real.
  async function bestVerifiedFollowUp(branch, actor, learned, deadline) {
    const snap = await prepareCanonicalAiSearchSnapshot(branch.snapshot({ includeHistory: false }));
    const built = boardInput(snap);
    if (!built.ok) return null;
    const actions = canonicalAiMoveCandidates(branch, { canContinue: () => true }).actions.filter(isMove);
    if (!actions.length) return hasOtherActions(branch, snap, actor) ? null : { score: -MATE, move: "-" };
    const l2 = new Map(learned);
    if ([...built.unknown].some(([k, i]) => i.color === actor && !l2.has(k))) learnFrom(actions, built.input, built.unknown, l2, actor);
    applyKinds(built.input, built.unknown, l2, actor);
    const keyed = new Map();
    built.input.rootMoves = actions.map((a) => {
      const { from, to, promotion } = a.intent.payload;
      const key = `${from}${to}${promotion ?? ""}`;
      keyed.set(key, a);
      return { from: sqOf(from), to: sqOf(to), promo: promotion && engine.BUILTIN[promotion] ? promotion : promotion ? "queen" : null, key };
    });
    built.input.timeMs = Math.max(60, (deadline - now()) * 0.5);
    const r = engine.search(built.input);
    if (!r.ok || !r.move) return null;
    const verified = await verifyRanked(branch, r.rootScores.map((x) => ({ action: keyed.get(x.key), score: x.score, exact: x.exact })), actor, l2, deadline);
    const best = verified[0];
    return best ? { score: best.score, move: `${best.action.intent.payload.from}${best.action.intent.payload.to}` } : null;
  }

  const holdsCards = (snap, color) => snap.game.cardState.inventories[color].some((c) => c.status === "AVAILABLE" && c.usesRemaining > 0);
  // Actions other than piece moves the side could still take.
  function hasOtherActions(branch, snap, color) {
    try {
      if (branch.responseChoices(color).length || branch.shotgunSources(color).length) return true;
    } catch { /* older sessions */ }
    return holdsCards(snap, color);
  }

  // The mover's legal moves in `branch`, best first by a short engine search.
  function rankMoves(branch, snap, mover, learned, ms, keep) {
    const actions = canonicalAiMoveCandidates(branch, { canContinue: () => true }).actions.filter(isMove);
    if (actions.length <= keep) return actions;
    const built = boardInput(snap);
    if (!built.ok) return actions.slice(0, keep);
    applyKinds(built.input, built.unknown, learned, mover);
    const keyed = new Map();
    built.input.rootMoves = actions.map((a) => {
      const { from, to, promotion } = a.intent.payload;
      const key = `${from}${to}${promotion ?? ""}`;
      keyed.set(key, a);
      return { from: sqOf(from), to: sqOf(to), promo: promotion && engine.BUILTIN[promotion] ? promotion : promotion ? "queen" : null, key };
    });
    built.input.timeMs = ms;
    const r = engine.search(built.input);
    if (!r.ok || !r.rootScores?.length) return actions.slice(0, keep);
    return [...r.rootScores].sort((a, b) => b.score - a.score).slice(0, keep).map((x) => keyed.get(x.key)).filter(Boolean);
  }

  // The rest of the opponent's turn, followed with the game's own rules:
  // more cards in a row, their moves, and extra moves in the same turn
  // (e.g. desperado moves one piece twice). Returns OUR score once the turn
  // comes back to us, assuming the opponent picks what hurts us most.
  async function followOpponentTurn(branch, actor, learned, deadline, depth) {
    const snap = await prepareCanonicalAiSearchSnapshot(branch.snapshot({ includeHistory: false }));
    const g = snap.game;
    if (g.status === "FINISHED") {
      const w = g.result?.winner ?? g.position?.winner;
      return w === actor ? MATE : w ? -MATE : 0;
    }
    const leaf = async () => {
      const s = await scoreAfterCard(branch, actor, learned, Math.max(40, Math.min(250, deadline - now())));
      return s && !s.invisible ? s.score : null;
    };
    if (g.status !== "ACTIVE" || g.position.turn === actor || depth <= 0 || now() > deadline - 60) return leaf();
    const opp = g.position.turn;
    let worst = Infinity;
    // their best moves, each played for real
    for (const move of rankMoves(branch, snap, opp, learned, 60, 2)) {
      if (now() > deadline - 40) break;
      const child = branch.forkForAi();
      const applied = await applyCanonicalAiCandidate(child, move);
      if (!applied.ok) continue;
      const v = await followOpponentTurn(child, actor, learned, deadline, depth - 1);
      if (v !== null && v < worst) worst = v;
    }
    // another card in the same turn
    if (depth >= 2 && holdsCards(snap, opp) && now() < deadline - 150) {
      const q = await canonicalAiActionCandidates(branch, { includeCards: true, maxCardProbes: 4, canContinue: () => now() < deadline - 100, moveCanContinue: () => false });
      for (const a of q.actions.filter((x) => x.intent.kind !== "piece_move" && q.successors?.has(x)).slice(0, 2)) {
        if (now() > deadline - 40) break;
        const v = await followOpponentTurn(q.successors.get(a), actor, learned, deadline, depth - 1);
        if (v !== null && v < worst) worst = v;
      }
    }
    return Number.isFinite(worst) ? worst : leaf();
  }

  // Worst case for us when the opponent spends cards this turn. `branch` is
  // the exact position after our action, opponent to move. Every card is
  // screened with the engine; the most dangerous ones that keep the turn
  // are then followed through the whole turn with the game's rules.
  // The opponent's card actions, listed from the session's target queries
  // (cheap: nothing is applied). One-square and no-target selections only.
  // Most dangerous first: targets nearest our royal pieces (king, VIP...).
  function opponentCardIntents(branch, snap, opp, actor, limit, deadline = Infinity) {
    const g = snap.game, ids = g.cardState.board.pieceIds, pieces = g.cardState.pieces;
    const royals = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const rec = pieces[ids[r]?.[c]];
      if (rec?.color === actor && isRoyal(rec, null)) royals.push(r * 8 + c);
    }
    const dist = (name) => {
      const q = sqOf(name);
      let d = 8;
      for (const k of royals) d = Math.min(d, Math.max(Math.abs((q >> 3) - (k >> 3)), Math.abs((q & 7) - (k & 7))));
      return d;
    };
    const intent = (id, kind, squares) => ({ schemaVersion: 1, kind: "card_action", payload: { cardInstanceId: id, selection: { schemaVersion: 1, kind, squares, choice: null } } });
    // first the target squares of every card, then the nearest ones across
    // all cards are checked while time lasts
    const out = [], pending = [];
    for (const owned of g.cardState.inventories[opp] ?? []) {
      if (owned.status !== "AVAILABLE" || !(owned.usesRemaining > 0) || owned.attributes?.draftNextTurnPending === true || owned.cardId === "barricade") continue;
      let q0;
      try { q0 = branch.listCardTargets(opp, owned.cardInstanceId, []); } catch { continue; }
      if (!q0?.ok) continue;
      const squares = Array.isArray(q0.squares) ? q0.squares : [];
      if (q0.complete && !squares.length) { out.push({ intent: intent(owned.cardInstanceId, "none", []), prio: 4, cardId: owned.cardId }); continue; }
      for (const sq of squares) if (typeof sq === "string" && /^[a-h][1-8]$/.test(sq)) pending.push({ id: owned.cardInstanceId, cardId: owned.cardId, sq, prio: dist(sq) });
    }
    pending.sort((x, y) => x.prio - y.prio);
    for (const p of pending) {
      if (out.length >= limit || now() > deadline) break;
      let q1;
      try { q1 = branch.listCardTargets(opp, p.id, [p.sq]); } catch { continue; }
      if (q1?.ok && q1.complete) out.push({ intent: intent(p.id, "squares", [p.sq]), prio: p.prio, cardId: p.cardId });
    }
    return out.sort((a, b) => a.prio - b.prio).slice(0, limit);
  }

  async function opponentCardThreat(branch, actor, learned, deadline, maxProbes) {
    const snap = branch.snapshot({ includeHistory: false });
    const opp = other(actor);
    if (snap.game.status !== "ACTIVE" || snap.game.position.turn !== opp || !holdsCards(snap, opp)) return null;
    const screened = [];
    // 1. replies listed from the target queries, nearest our royal pieces
    //    first, each applied as it is screened. (The first target query of a
    //    position has a fixed setup cost, so screening time is set after it.)
    const listed = opponentCardIntents(branch, snap, opp, actor, maxProbes, now() + (deadline - now()) * 0.25);
    const screenEnd = now() + Math.max(80, (deadline - now()) * 0.6);
    for (let i = 0; i < listed.length && now() < screenEnd; i++) {
      const per = Math.max(25, Math.min(150, (screenEnd - now()) / (listed.length - i)));
      try {
        const child = branch.forkForAi();
        if (!(await child.dispatch(opp, listed[i].intent)).ok) continue;
        const sc = await scoreAfterCard(child, opp, learned, per);
        if (!sc) continue;
        screened.push({ child, label: cardLabel(snap, opp, listed[i].intent), oppScore: sc.invisible ? null : sc.score, sameTurn: !!sc.sameTurn });
      } catch { /* unreadable reply */ }
    }
    // 2. nothing listed (cards with several squares or a choice): the
    //    game's own generator
    if (!screened.length) {
      const q = await canonicalAiActionCandidates(branch, {
        includeCards: true, maxCardProbes: maxProbes,
        canContinue: () => now() < deadline, moveCanContinue: () => false
      });
      const replies = q.actions.filter((a) => a.intent.kind !== "piece_move" && q.successors?.has(a));
      for (let i = 0; i < replies.length && now() < screenEnd; i++) {
        const per = Math.max(25, Math.min(150, (screenEnd - now()) / (replies.length - i)));
        try {
          const child = q.successors.get(replies[i]);
          const sc = await scoreAfterCard(child, opp, learned, per);
          if (!sc) continue;
          screened.push({ child, label: cardLabel(snap, opp, replies[i].intent), oppScore: sc.invisible ? null : sc.score, sameTurn: !!sc.sameTurn });
        } catch { /* unreadable reply */ }
      }
    }
    let worst = null;
    for (const c of screened) if (c.oppScore !== null && (!worst || -c.oppScore < worst.score)) worst = { score: -c.oppScore, label: c.label };
    // Follow the most dangerous turn-keeping cards to the end of their turn.
    const deep = screened.filter((c) => c.sameTurn).sort((a, b) => (b.oppScore ?? -Infinity) - (a.oppScore ?? -Infinity)).slice(0, 2);
    for (const c of deep) {
      if (now() > deadline - 120) break;
      try {
        const v = await followOpponentTurn(c.child, actor, learned, deadline, 3);
        if (v !== null && (!worst || v < worst.score)) worst = { score: v, label: `${c.label} (턴 전체)` };
      } catch { /* skip */ }
    }
    return worst;
  }

  // Main entry: best action (move or card) within timeMs.
  //   1. game lists moves + cards (each card applied exactly)
  //   2. engine searches plain moves deeply
  //   3. cards: visible effects -> engine search of the result;
  //      hidden effects (snipe, statuses...) -> the moves the card newly
  //      enables are played for real and searched
  //   4. top plain moves are played for real (on-capture effects, passives)
  //      and re-scored
  //   5. the opponent's cards are tried against our best options
  async function pick(snapshot, { timeMs = 3000, includeCards = true, maxCardProbes = 24, cardShare = 0.2 } = {}) {
    const start = now(), end = start + timeMs;
    const at = (f) => start + timeMs * f;
    const root = await prepareRoot(snapshot, { includeCards, maxCardProbes, cardDeadline: at(cardShare), probeMs: Math.min(900, timeMs * 0.08) });
    if (!root.ok) return root;
    const { session, input, byKey, learned, actor, cardActions, query } = root;
    const hasMoves = input.rootMoves.length > 0;
    const rootSignature = signature(input);
    const rootMoveKeys = new Set(input.rootMoves.map((m) => `${m.from}-${m.to}`));
    const haveCards = cardActions.length > 0;
    // When the opponent still holds cards, keep a larger share for following
    // their possible card turns against our best options.
    const oppCards = holdsCards(snapshot, other(actor));
    const T = oppCards ? { base: haveCards ? 0.28 : 0.38, cards: 0.42, verify: 0.52 } : { base: haveCards ? 0.45 : 0.6, cards: 0.65, verify: 0.85 };
    // a longer card-listing share (draft probe) shifts the later stages
    if (cardShare !== 0.2) for (const k of Object.keys(T)) T[k] = cardShare + (T[k] - 0.2) * (1 - cardShare) / 0.8;

    // 2. plain moves
    let base = null;
    if (hasMoves) {
      input.timeMs = Math.max(100, at(T.base) - now());
      const r = engine.search(input);
      if (r.ok && r.move) base = r;
    }

    // 3. cards
    const cards = [], hidden = [];
    for (let i = 0; i < cardActions.length; i++) {
      const stop = at(T.cards), left = stop - now();
      if (left < 40) break;
      const per = Math.max(40, left / (cardActions.length - i));
      const action = cardActions[i];
      let branch = query.successors.get(action);
      if (!branch && isSpell(action)) {
        try {
          const b = session.forkForAi();
          if ((await applyCanonicalAiCandidate(b, action)).ok) { branch = b; query.successors.set(action, b); }
        } catch { branch = null; }
      }
      if (!branch) continue;
      const label = isSpell(action) ? `${SPELL_NAMES[action.intent.payload.promotion] ?? action.intent.payload.promotion} ${action.intent.payload.to}` : cardLabel(snapshot, actor, action.intent);
      try {
        const s = await scoreAfterCard(branch, actor, learned, per, { rootSignature });
        if (!s) continue;
        if (!s.invisible) { cards.push({ action, ...s, label }); continue; }
        // Hidden effect: what can we do now that we could not before?
        const enabled = canonicalAiMoveCandidates(branch, { canContinue: () => true }).actions
          .filter(isMove)
          .filter((a) => !rootMoveKeys.has(`${sqOf(a.intent.payload.from)}-${sqOf(a.intent.payload.to)}`));
        if (!enabled.length) { hidden.push(label); continue; }
        // Captures first; at most three are played for real.
        const board = branch.snapshot({ includeHistory: false }).game.position.board;
        const target = (a) => board[8 - Number(a.intent.payload.to[1])]?.[a.intent.payload.to.charCodeAt(0) - 97];
        enabled.sort((a, b) => (target(b) ? 1 : 0) - (target(a) ? 1 : 0));
        let best = null;
        for (const move of enabled.slice(0, 3)) {
          const r = await exactAfterMove(branch, move, actor, learned, Math.max(40, per / 3));
          if (r && (!best || r.score > best.score)) best = { ...r, follow: move.intent.payload };
        }
        if (best) cards.push({ action, score: best.score, depth: best.depth, exact: true, label: `${label} → ${best.follow.from}${best.follow.to}` });
        else hidden.push(label);
      } catch { /* skip a card the engine cannot read */ }
    }
    cards.sort((a, b) => b.score - a.score);

    // 4. top plain moves played for real
    const options = base
      ? await verifyRanked(session, base.rootScores.map((r) => ({ action: byKey.get(r.key), score: r.score, exact: r.exact })), actor, learned, at(T.verify))
      : [];
    const bestMoveScore = options.length ? options[0].score : -Infinity;

    // Best card, if it clearly beats the best plain move (cards are one-shot).
    // Its score must be measured the same way as the moves': a card that
    // keeps the turn is followed by our best move, played for real.
    for (const card of cards.slice(0, 2)) {
      if (Number.isFinite(bestMoveScore) && card.score <= bestMoveScore + CARD_MARGIN) break;
      let check = card;
      const b = query.successors.get(card.action);
      const shallow = (card.depth ?? 0) < Math.min(5, (base?.depth ?? 0) - 2);
      if ((!card.exact || shallow) && now() < end) {
        try {
          const sameTurn = b.snapshot({ includeHistory: false }).game.position.turn === actor;
          if (sameTurn) {
            const follow = await bestVerifiedFollowUp(b, actor, learned, Math.min(end, now() + Math.max(150, (end - now()) / 2)));
            // No answer in time: keep the first score rather than dropping the card.
            check = follow ? { ...card, score: follow.score, label: `${card.label} → ${follow.move}` } : card;
          } else {
            const r = await scoreAfterCard(b, actor, learned, Math.max(60, Math.min(800, (end - now()) / 3)), { exact: true });
            check = r ? { ...card, ...r } : card;
          }
        } catch { check = card; }
      }
      if (!Number.isFinite(bestMoveScore) || check.score > bestMoveScore + CARD_MARGIN) {
        const passes = b.snapshot({ includeHistory: false }).game.position.turn !== actor;
        options.push({ kind: "card", action: card.action, score: check.score, label: check.label, branch: passes ? b : null, exact: true });
        break;
      }
    }

    // 5. opponent card replies against our options (best first)
    // (time is kept back for the final safety check below)
    const safetyReserve = Math.min(1200, timeMs * 0.2);
    // Opponent card probes (a card with a target, e.g. desperado, is one
    // probe per target): more when there is more time.
    const oppProbes = timeMs >= 9000 ? 32 : timeMs >= 5000 ? 16 : 8;
    const cardEnd = end - safetyReserve;
    options.sort((a, b) => b.score - a.score);
    const counters = [];
    for (const opt of options) {
      if (now() > cardEnd - 30) break;
      if (!opt.branch) continue;
      try {
        const share = counters.length === 0 && opt === options[0] ? 2 / 3 : 1 / 2;
        const threat = await opponentCardThreat(opt.branch, actor, learned, Math.min(cardEnd, now() + Math.max(80, (cardEnd - now()) * share)), oppProbes);
        if (threat && threat.score < opt.score) {
          counters.push({ option: opt.label ?? `${opt.action.intent.payload.from}${opt.action.intent.payload.to}`, before: opt.score, after: threat.score, by: threat.label });
          opt.score = threat.score;
        }
      } catch { /* skip */ }
    }
    options.sort((a, b) => b.score - a.score);

    // 6. Last safety net, answered by the game itself: does this action let
    // the opponent win on their very next move, by any rule (king capture or
    // any special victory: herald, gomoku, penta check, ...)? If so, the next
    // option is checked instead.
    const immediateLosses = [];
    for (const opt of options) {
      if (now() > end + 300) break;
      if (!opt.branch && opt.kind === "move") {
        try {
          const b = session.forkForAi();
          if ((await applyCanonicalAiCandidate(b, opt.action)).ok) opt.branch = b;
        } catch { /* leave unchecked */ }
      }
      if (!opt.branch) continue; // e.g. a card that keeps our turn
      let verdict = null;
      try {
        verdict = await canonicalImmediateDefeat(opt.branch, actor, { maxProbes: 24, includeSetups: false, canContinue: () => now() < end + 300 });
      } catch { verdict = null; }
      if (!verdict?.loss) break;
      immediateLosses.push(opt.label ?? `${opt.action.intent.payload.from}${opt.action.intent.payload.to}`);
      opt.score = -MATE + 2;
    }
    options.sort((a, b) => b.score - a.score);
    const choiceOpt = options[0] ?? null;

    let candidate = choiceOpt?.action ?? null, score = choiceOpt?.score ?? -Infinity, choice = choiceOpt?.kind ?? "move", chosenCard = choiceOpt?.kind === "card" ? choiceOpt.label : null;
    if (!candidate) {
      // No plain move (e.g. a card response window): best evaluated card.
      if (cards[0]) { candidate = cards[0].action; score = cards[0].score; choice = "card"; chosenCard = cards[0].label; }
      else return { ok: false, reason: "nothing to play" };
    }

    // Actions this engine judged. Cards with effects it could not read at
    // all are left out, so the game's own AI keeps the say on those.
    const evaluated = [
      ...(base ? [...byKey.values()].map((a) => JSON.stringify(a.intent)) : []),
      ...cards.map((c) => JSON.stringify(c.action.intent))
    ];
    return {
      ok: true,
      candidate, score, choice, chosenCard,
      depth: base?.depth ?? cards[0]?.depth ?? 0,
      nodes: base?.nodes ?? 0,
      ms: Math.round(now() - start),
      baseScore: base ? base.score : null,
      cards: cards.slice(0, 8).map((c) => ({ card: c.label, score: c.score, depth: c.depth })),
      cardsAvailable: cardActions.length,
      invisibleCards: hidden,
      topMoves: options.filter((o) => o.kind === "move").map((o) => ({ move: `${o.action.intent.payload.from}${o.action.intent.payload.to}`, engine: o.engineScore, real: o.realScore, final: o.score })),
      counters,
      immediateLosses,
      limitsLearned: root.limits,
      prepTiming: root.timing,
      friendlyCaptures: [0, 1].map((c) => ({ kinds: [...activeEat.kinds[c]], extraMove: activeEat.extra[c] })),
      captureBans: activeCapBans.map((b) => `${b.by ? "black" : "white"} ${b.a} x ${b.t}`),
      ruleError: root.ruleError ?? null,
      evaluated,
      learnedKinds: Object.fromEntries([...learned].map(([k, v]) => [k, v.capture.length + v.quiet.length]))
    };
  }

  // Validation helper (tools/validate-moves.cjs): engine input with the
  // game's legal moves as root list, without cards.
  async function buildInput(snapshot) {
    const root = await prepareRoot(snapshot, { includeCards: false, maxCardProbes: 0, cardDeadline: 0 });
    if (!root.ok) return root;
    return { ok: true, input: root.input, byKey: root.byKey, session: root.session, actions: root.query.actions };
  }

  // Draft-time probe on the real draft state: for each offered choice, a
  // copy of the game makes that pick with the game's own rules (passive
  // cards take effect for real), any other pending picks are made with the
  // first choice, the actor is put to move, and pick() scores the position.
  // Returns per-card scores and gains over the worst choice.
  async function draftProbe(snapshot, actor, _ids, { perMs = 400, deadline = Infinity } = {}) {
    const g0 = snapshot.game;
    const offer = g0?.cardState?.draft?.offer;
    if (g0?.status !== "DRAFTING" || !offer?.choices?.length) return { ok: false, reason: "not drafting" };
    const tStart = now();
    const scores = {};
    for (const choice of offer.choices) {
      if (now() > deadline) { scores[choice.cardId] = { fail: "out of time" }; continue; }
      const t0 = now();
      try {
        const s = await CanonicalEditorSession.restoreForAi(snapshot);
        const r = await s.dispatch(actor, { schemaVersion: 1, kind: "draft_pick", payload: { offerId: offer.offerId, choiceId: choice.choiceId } });
        if (!r.ok) { scores[choice.cardId] = { fail: `pick ${r.code}` }; continue; }
        for (let k = 0; k < 4 && s.snapshot({ includeHistory: false }).game.status === "DRAFTING"; k++) {
          const who = s.snapshot({ includeHistory: false }).game.cardState.draft.pickingColor;
          const q = s.draftChoices(who);
          if (!q.ok || !q.choices.length) break;
          await s.dispatch(who, { schemaVersion: 1, kind: "draft_pick", payload: { offerId: q.offerId, choiceId: q.choices[0].choiceId } });
        }
        let ss = await prepareCanonicalAiSearchSnapshot(s.searchSnapshot());
        if (ss.game.status !== "ACTIVE") { scores[choice.cardId] = { fail: `status ${ss.game.status}` }; continue; }
        if (ss.game.position.turn !== actor) {
          const flipped = structuredClone(ss);
          flipped.game.position.turn = actor;
          if (typeof flipped.game.turn === "string") flipped.game.turn = actor;
          ss = await prepareCanonicalAiSearchSnapshot(flipped);
        }
        const p = await pick(ss, { timeMs: perMs, includeCards: true, maxCardProbes: 12 });
        scores[choice.cardId] = p.ok
          ? { score: p.score, card: p.choice === "card" ? p.chosenCard : null, ms: Math.round(now() - t0) }
          : { fail: p.reason };
      } catch (e) {
        scores[choice.cardId] = { fail: String(e?.message || e) };
      }
    }
    const vals = Object.values(scores).filter((v) => typeof v.score === "number").map((v) => v.score);
    if (vals.length < 2) return { ok: false, reason: "fewer than two choices scored", scores };
    const worst = Math.min(...vals);
    const gains = {};
    for (const [id, v] of Object.entries(scores)) gains[id] = typeof v.score === "number" ? { gain: v.score - worst, card: v.card } : v;
    return { ok: true, ms: Math.round(now() - tStart), gains };
  }

  // opponentCardThreat is exposed for tools/ (diagnostics).
  return { pick, buildInput, opponentCardThreat, prepareRoot, draftProbe };
}

if (typeof module !== "undefined" && module.exports) module.exports = acbFastAdapterModule;
else if (typeof globalThis !== "undefined") globalThis.acbFastAdapterModule = acbFastAdapterModule;
