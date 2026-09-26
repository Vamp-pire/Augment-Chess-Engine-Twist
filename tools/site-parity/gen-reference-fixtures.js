#!/usr/bin/env node
// Reference fixtures generated from the SITE's real rules code (.cache/real-worker.js, wrapped by common.js;
// --worker=fast uses the byte-identical .cache/real-worker-fast.js). Never engine-merged.js.
// Purpose: gold standard for the Rust port (Accelerate repo, tests/differential/fixtures/site-reference-v1/).
//
//   node gen-reference-fixtures.js --out=<dir> [--seed=20260926] [--worker=orig|fast]
//        [--per-piece=1] [--per-card=1] [--playouts=16] [--plies=120] [--max-applied=3] [--card-applied=2] [--constructed-gameover=12] [--sample-plies=5,15,31]
//        [--generator-commit=<sha>]           (default: `git rev-parse HEAD` of the Twist repo)
//   node gen-reference-fixtures.js --verify=<dir> [--worker=orig|fast]
//        replays every fixture (legal actions + every applied action) against the chosen worker, 0 mismatches expected
//   node gen-reference-fixtures.js --serve [--worker=..]
//        line protocol identical to run-differential.js (candidate mode): a stand-in candidate backed by the site worker
//
// Output (all deterministic: same seed + same worker bundle => byte-identical files; no timestamps):
//   pieces.jsonl, cards.jsonl, playouts.jsonl, gameover.jsonl   one fixture per line, oracle-v1 compatible:
//     {id, source, seed, oracle:"site", color, state, expected:{legalActions:[sorted normalised keys],
//       applied:[{action, key, ok, result, signature, stateDelta}], nondeterministic:[{action,key,ok}],
//       skippedNondeterministic, terminal:{mode,winner}}}
//   meta.json    seed, generator commit, site bundle hashes, counts, coverage, file sha256
// Extensions over oracle-v1 (run-differential.js ignores unknown keys): applied[].result (applyAction return value,
// normalised), applied[].stateDelta (resulting state as a delta against the input state, see README), expected.nondeterministic.
//
// Randomness: the worker uses Math.random in a few card paths. Math.random is replaced by seeded streams; an applied action
// is only recorded in expected.applied when its result (return value + full state) is identical under 4 different random
// streams. Otherwise it goes into expected.nondeterministic (legality is still checked through legalActions, the outcome is not).
const fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process");
const argv = process.argv.slice(2);
const arg = (name, def) => { const a = argv.find((x) => x === "--" + name || x.startsWith("--" + name + "=")); if (!a) return def; return a.includes("=") ? a.slice(a.indexOf("=") + 1) : true; };
const workerKind = arg("worker", "orig");
const C = require("./common.js"); // loads .cache/real-worker.js
let oracle = C.real;
if (workerKind === "fast") oracle = require(path.join(__dirname, ".cache", "real-worker-fast.js"));
else if (workerKind !== "orig") throw new Error("--worker must be orig|fast");
if (workerKind === "fast" && oracle === C.real) throw new Error("fast worker resolved to the original module");
const { ALL_TYPES } = require(path.join(__dirname, "..", "..", "nnue", "encode.js"));

const realRandom = Math.random;
const rngMaker = C.rngMaker;
const clone = (o) => JSON.parse(JSON.stringify(o));
const strip = (o) => { if (o && typeof o === "object") { delete o.id; delete o.instanceId; delete o.pieceId; for (const k in o) strip(o[k]); } return o; };
const normAction = (a) => JSON.stringify(strip(clone(a)));
const J = JSON.stringify;
const RANDOM_STREAMS = [1, 2, 3, 4].map((s) => () => rngMaker(0x9e3779b1 * s + 12345));
let randomCalls = 0; // how often the worker actually consumed Math.random while generating/applying (reported in meta.json)
function withRandom(mk, fn) { const g = mk(); Math.random = () => { randomCalls++; return g(); }; try { return fn(); } finally { Math.random = realRandom; } }
const DET_RANDOM = () => { const g = rngMaker(424242); return () => { randomCalls++; return g(); }; }; // the stream used while advancing playouts

// Piece types: encode.js ALL_TYPES plus the types parity-playout.js seeds onto boards (camel is not in ALL_TYPES)
const SPECIAL = ["amazon","cardinal","grasshopper","hook","camel","berserker","thief","paladin","octopus","clockwork","brutus","checker","campfire","princess","scarecrow","slime","trickster"];
const PIECES = [...new Set([...ALL_TYPES, ...SPECIAL])];
const STANDARD = ["pawn", "knight", "bishop", "rook", "queen"];
const CARDS = [...new Set(C.POOL)]; // POOL lists 240 entries, 239 distinct
const seedFor = (base, k) => ((base * 7919 + k * 104729) >>> 0) || 1;

// ---------------------------------------------------------------- state construction (same recipe as oracle-v1)
function baseState(board, decks, color, rng) {
  const st = oracle.cloneState({});
  st.board = clone(board); st.mode = "play"; st.turn = color; st.actionsRemaining = 1;
  st.deckSlots = clone(decks); st.captures = { white: [], black: [] }; st.aiSearchNoCards = false;
  st.turnsTaken = { white: Math.floor(rng() * 20), black: Math.floor(rng() * 20) };
  st.moveCount = st.turnsTaken.white + st.turnsTaken.black;
  st.castlingCanceled = { white: rng() < 0.5, black: rng() < 0.5 };
  st.parrotMovement = { white: null, black: null };
  if (st.board.some((row) => row.some((p) => p?.type === "campfire"))) st.hasCampfire = true;
  oracle.setWorkerBoardDimensions(st);
  return st;
}
const emptyBoard = () => Array.from({ length: 8 }, () => Array(8).fill(null));
function placeRandom(b, type, color, rng) {
  for (let t = 0; t < 60; t++) {
    const r = Math.floor(rng() * 8), c = Math.floor(rng() * 8);
    if (b[r][c]) continue;
    if (type === "pawn" && (r === 0 || r === 7)) continue;
    b[r][c] = { type, color, moved: rng() < 0.5 };
    return [r, c];
  }
  return null;
}
const randomOtherType = (rng) => (rng() < 0.3 ? STANDARD[Math.floor(rng() * STANDARD.length)] : PIECES[Math.floor(rng() * PIECES.length)]);
function makeBoard(rng, mustType, minN = 4, spread = 9) {
  const b = emptyBoard();
  placeRandom(b, "king", "white", rng); placeRandom(b, "king", "black", rng);
  let pos = null, mustColor = null;
  if (mustType && mustType !== "king") { mustColor = rng() < 0.5 ? "white" : "black"; pos = placeRandom(b, mustType, mustColor, rng); }
  const n = minN + Math.floor(rng() * spread);
  for (let i = 0; i < n; i++) placeRandom(b, randomOtherType(rng), rng() < 0.5 ? "white" : "black", rng);
  return { board: b, mustPos: pos, mustColor };
}
const cardObj = (color, effect, k, rng) => ({ id: effect, instanceId: `${color}-${effect}-${k}`, effect, stars: 1 + Math.floor(rng() * 5), used: false, recovering: false });
function makeDecks(rng, mustCard, mustColor, minWant = 3) {
  const decks = { white: [], black: [] };
  for (const col of ["white", "black"]) {
    const used = new Set(); const want = minWant + Math.floor(rng() * 3);
    if (mustCard && col === mustColor) { used.add(mustCard); decks[col].push(cardObj(col, mustCard, 0, rng)); }
    for (let k = 1; decks[col].length < want && k < 40; k++) {
      const e = CARDS[Math.floor(rng() * CARDS.length)];
      if (used.has(e)) continue; used.add(e); decks[col].push(cardObj(col, e, k, rng));
    }
  }
  return decks;
}
function startBoard(rng) {
  const back = ["rook","knight","bishop","queen","king","bishop","knight","rook"];
  const b = emptyBoard();
  for (const [col, br, pr] of [["black", 0, 1], ["white", 7, 6]]) for (let c = 0; c < 8; c++) { b[pr][c] = { type: "pawn", color: col, moved: false }; b[br][c] = { type: back[c], color: col, moved: false }; }
  const extra = 3 + Math.floor(rng() * 4);
  for (let k = 0; k < extra; k++) { const t = PIECES[Math.floor(rng() * PIECES.length)], c = Math.floor(rng() * 8); const col = rng() < 0.5 ? "white" : "black"; const r = col === "white" ? 5 : 2; if (!b[r][c] && t !== "king") b[r][c] = { type: t, color: col, moved: false }; }
  return b;
}

// ---------------------------------------------------------------- oracle answers
function signature(st) {
  const cell = (p) => p ? [p.type, p.color, !!p.moved, !!p.shielded, !!p.frozen, !!p.witchTrial, p.witchTrial?.countBy || "", p.frozenByCard?.countBy || "", !!p.recurrence, !!p.defected, p.hp ?? "", p.promotionRushUntil ?? ""].join(":") : "-";
  const bd = st.board.map((row) => row.map(cell));
  const decks = { white: [], black: [] };
  for (const c of ["white", "black"]) decks[c] = (st.deckSlots?.[c] || []).map((k) => `${k.effect}:${k.used ? 1 : 0}:${k.recovering ? 1 : 0}`);
  return {
    mode: st.mode, winner: st.winner || "", turn: st.turn, actionsRemaining: st.actionsRemaining, board: bd, decks,
    turnsTaken: st.turnsTaken || null, moveCount: st.moveCount ?? null,
    pendingScarecrows: (st.pendingScarecrows || []).map((e) => [e.row, e.col, !!e.reserved, e.remainingOwnTurns ?? "", e.by || ""]),
    pendingGales: (st.pendingGales || []).map((e) => [e.color, e.remainingOwnTurns ?? "", e.triggerTurn ?? ""]),
    othello: st.othelloPending || null, reversal: st.reversal || null,
    platform: st.platformRule ? [st.platformRule.enabled, st.platformRule.cadence || "", st.platformRule.nextAt, st.platformRule.countUnit] : null
  };
}
// JSON has no shared references; 2x2 pieces are re-joined by cloneState (by id) or by anchor (see oracle-v1's rehydrate).
function rehydrate(json) {
  const st = oracle.cloneState({});
  Object.assign(st, clone(json));
  st.board = oracle.cloneState(clone(json)).board;
  const byAnchor = new Map();
  for (const row of st.board) for (let c = 0; c < row.length; c++) {
    const p = row[c];
    if (!p || p.id || !Number.isInteger(p.anchorRow) || !Number.isInteger(p.anchorCol)) continue;
    const key = p.type + "|" + p.color + "|" + p.anchorRow + "|" + p.anchorCol;
    if (byAnchor.has(key)) row[c] = byAnchor.get(key); else byAnchor.set(key, p);
  }
  oracle.setWorkerBoardDimensions(st);
  return st;
}
// Legal actions: raw list + normalised sorted unique keys. Returns null when the list depends on Math.random.
function legalList(st, color) {
  let first = null;
  for (const mk of RANDOM_STREAMS.slice(0, 2)) {
    const raw = withRandom(mk, () => oracle.generateActions(oracle.cloneState(st), color));
    const keys = [...new Set(raw.map(normAction))].sort();
    if (!first) first = { raw, keys };
    else if (J(first.keys) !== J(keys)) return null;
  }
  return first;
}
// Apply under one random stream on a fresh rehydrated copy; result = {ok, res(normalised return value), signature, state}.
function applyOnce(json, action, color, mk) {
  const copy = rehydrate(json);
  let res;
  try { res = withRandom(mk, () => oracle.applyAction(copy, clone(action), color)); } catch (e) { return { threw: String(e && e.message) }; }
  const nres = strip(clone(res));
  return { ok: !!res.ok, res: nres, signature: res.ok ? signature(copy) : null, state: res.ok ? clone(copy) : null };
}
// Deterministic across all RANDOM_STREAMS? then {det:true, ...} else {det:false, ok}.
function applyStable(json, action, color) {
  const rs = RANDOM_STREAMS.map((mk) => applyOnce(json, action, color, mk));
  if (rs.some((r) => r.threw !== undefined)) return { det: false, threw: true, ok: false };
  const ref = J([rs[0].ok, rs[0].res, rs[0].state]);
  if (rs.every((r) => J([r.ok, r.res, r.state]) === ref)) return { det: true, ...rs[0] };
  return { det: false, ok: rs.every((r) => r.ok === rs[0].ok) ? rs[0].ok : null };
}
// State delta (result state relative to the input state). Node = {"=":v} replace | {"o":{key:node},"d":[deleted keys]} object patch | {"a":{index:node}} same-length array patch.
const canon = (x) => J(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, kk) => ((o[kk] = v[kk]), o), {}) : v)); // key-order independent
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
function stateDiff(a, b) {
  if (canon(a) === canon(b)) return undefined;
  if (isObj(a) && isObj(b)) {
    const o = {}, d = [];
    for (const k of Object.keys(b)) { const n = k in a ? stateDiff(a[k], b[k]) : { "=": b[k] }; if (n !== undefined) o[k] = n; }
    for (const k of Object.keys(a)) if (!(k in b)) d.push(k);
    const r = {}; if (Object.keys(o).length) r.o = o; if (d.length) r.d = d;
    return r;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    const o = {}; for (let i = 0; i < a.length; i++) { const n = stateDiff(a[i], b[i]); if (n !== undefined) o[i] = n; }
    return { a: o };
  }
  return { "=": b };
}
function stateApply(a, n) {
  if (n === undefined) return a;
  if ("=" in n) return n["="];
  if (n.a) { const r = a.slice(); for (const i of Object.keys(n.a)) r[i] = stateApply(a[i], n.a[i]); return r; }
  const r = { ...a };
  for (const k of n.d || []) delete r[k];
  for (const k of Object.keys(n.o || {})) r[k] = k in a ? stateApply(a[k], n.o[k]) : n.o[k]["="];
  return r;
}
// picks(raw) -> ordered raw actions to try; forced = extra actions always included first
function answer(stJson, color, picks, maxApplied) {
  const json = clone(stJson);
  const st = rehydrate(json);
  const ll = legalList(st, color);
  if (!ll) return null;
  const applied = [], nondet = [];
  let skipped = 0;
  const seen = new Set();
  for (const a of picks(ll.raw)) {
    const key = normAction(a);
    if (seen.has(key)) continue; seen.add(key);
    if (applied.length >= maxApplied) break;
    const r = applyStable(json, a, color);
    if (r.threw) { skipped++; continue; }
    if (!r.det) { nondet.push({ action: clone(a), key, ok: r.ok }); skipped++; continue; }
    const item = { action: clone(a), key, ok: r.ok, result: r.res, signature: r.signature };
    if (r.ok) { item.stateDelta = stateDiff(json, r.state) || {}; if (canon(stateApply(json, item.stateDelta)) !== canon(r.state)) throw new Error("stateDelta does not round trip"); }
    applied.push(item);
  }
  return { legalActions: ll.keys, applied, nondeterministic: nondet, skippedNondeterministic: skipped, terminal: { mode: st.mode, winner: st.winner || "" } };
}
function sampleActions(raw, rng, preferred, maxApplied) {
  const pref = raw.filter(preferred), rest = raw.filter((a) => !preferred(a));
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  return shuffle(pref.slice()).slice(0, Math.ceil(maxApplied / 2)).concat(shuffle(rest.slice()).slice(0, maxApplied)).slice(0, maxApplied);
}

// ---------------------------------------------------------------- generation
function generate() {
  const seed = Number(arg("seed", 20260926));
  const perPiece = Number(arg("per-piece", 1)), perCard = Number(arg("per-card", 1));
  const playouts = Number(arg("playouts", 16)), plies = Number(arg("plies", 120)), maxApplied = Number(arg("max-applied", 3)), cardApplied = Number(arg("card-applied", 2)), builtTarget = Number(arg("constructed-gameover", 12));
  const outDir = arg("out", null);
  if (!outDir) throw new Error("--out=<dir> required");
  const files = { "pieces.jsonl": [], "cards.jsonl": [], "playouts.jsonl": [], "gameover.jsonl": [] };
  const counters = { "pieces.jsonl": 0, "cards.jsonl": 0, "playouts.jsonl": 0, "gameover.jsonl": 0 };
  const idPrefix = { "pieces.jsonl": "piece", "cards.jsonl": "card", "playouts.jsonl": "playout", "gameover.jsonl": "gameover" };
  const cov = { pieces: {}, cards: {} };
  PIECES.forEach((t) => (cov.pieces[t] = { fixtures: 0, legalActionsFrom: 0, applied: 0 }));
  CARDS.forEach((c) => (cov.cards[c] = { inHand: 0, positionsWithCardAction: 0, appliedDeterministic: 0, appliedNondeterministic: 0 }));
  const stats = { mathRandomCallsByWorker: 0, droppedLegalNondeterministic: 0, appliedTotal: 0, appliedOk: 0, appliedNotOk: 0, nondeterministicTotal: 0, gameoverStates: 0, appliedEndingGame: 0, positions: 0 };
  const winners = { white: 0, black: 0, other: 0 };
  const push = (file, source, st, color, ans) => {
    if (!ans) { stats.droppedLegalNondeterministic++; return false; }
    const f = { id: idPrefix[file] + "-" + String(++counters[file]).padStart(5, "0"), source, seed, oracle: "site", color, state: clone(st), expected: ans };
    files[file].push(f);
    stats.positions++;
    const present = new Set(); st.board.forEach((row) => row.forEach((p) => { if (p) present.add(p.type); }));
    present.forEach((ty) => { if (cov.pieces[ty]) cov.pieces[ty].fixtures++; });
    const typeAt = (pos) => (pos && st.board[pos.row] && st.board[pos.row][pos.col] ? st.board[pos.row][pos.col].type : null);
    const froms = new Set();
    ans.legalActions.forEach((k) => { const a = JSON.parse(k); const t = typeAt(a.from); if (t && cov.pieces[t]) froms.add(k + "|" + t); });
    froms.forEach((x) => { cov.pieces[x.split("|").pop()].legalActionsFrom++; });
    ans.applied.forEach((it) => {
      stats.appliedTotal++; it.ok ? stats.appliedOk++ : stats.appliedNotOk++;
      const t = typeAt(it.action.from); if (t && cov.pieces[t]) cov.pieces[t].applied++;
      if (it.action.type === "card" && cov.cards[it.action.cardId]) cov.cards[it.action.cardId].appliedDeterministic++;
      if (it.ok && it.signature.mode === "gameover") stats.appliedEndingGame++;
    });
    ans.nondeterministic.forEach((it) => { stats.nondeterministicTotal++; if (it.action.type === "card" && cov.cards[it.action.cardId]) cov.cards[it.action.cardId].appliedNondeterministic++; });
    if (ans.terminal.mode === "gameover") { stats.gameoverStates++; winners[ans.terminal.winner === "white" || ans.terminal.winner === "black" ? ans.terminal.winner : "other"]++; }
    const cardsHere = new Set(ans.legalActions.map((k) => JSON.parse(k)).filter((a) => a.type === "card").map((a) => a.cardId));
    cardsHere.forEach((c) => { if (cov.cards[c]) cov.cards[c].positionsWithCardAction++; });
    ["white", "black"].forEach((col) => (st.deckSlots?.[col] || []).forEach((k) => { if (cov.cards[k.effect]) cov.cards[k.effect].inHand++; }));
    return true;
  };

  // 1) pieces: one balanced block per piece type
  let rng = rngMaker(seedFor(seed, 1));
  for (const type of PIECES) {
    for (let k = 0; k < perPiece; k++) {
      const { board, mustPos, mustColor } = makeBoard(rng, type);
      const color = mustColor && rng() < 0.7 ? mustColor : (rng() < 0.5 ? "white" : "black");
      const st = baseState(board, makeDecks(rng, null, null), color, rng);
      const isTarget = (a) => mustPos && a.from && a.from.row === mustPos[0] && a.from.col === mustPos[1];
      push("pieces.jsonl", "piece:" + type, st, color, answer(st, color, (raw) => sampleActions(raw, rng, isTarget, maxApplied), maxApplied));
    }
  }
  // 2) cards: one balanced block per card id; retry boards until the card yields an action
  rng = rngMaker(seedFor(seed, 2));
  for (const card of CARDS) {
    for (let k = 0; k < perCard; k++) {
      let st, color;
      for (let attempt = 0; attempt < 40; attempt++) {
        color = rng() < 0.5 ? "white" : "black";
        const { board } = makeBoard(rng, null, 3, 5);
        st = baseState(board, makeDecks(rng, card, color, 2), color, rng);
        const legal = withRandom(RANDOM_STREAMS[0], () => oracle.generateActions(oracle.cloneState(st), color));
        if (legal.some((a) => a.type === "card" && a.cardId === card)) break;
      }
      const isCard = (a) => a.type === "card" && a.cardId === card;
      push("cards.jsonl", "card:" + card, st, color, answer(st, color, (raw) => sampleActions(raw, rng, isCard, cardApplied), cardApplied));
    }
  }
  // 2b) the one random-dependent card path in the worker (applyFiveLocalCard: brutus picks a random own rook): boards with 3 own rooks
  for (let k = 0; k < 2; k++) {
    const color = k ? "black" : "white";
    const b = emptyBoard();
    placeRandom(b, "king", "white", rng); placeRandom(b, "king", "black", rng);
    for (let i = 0; i < 3; i++) placeRandom(b, "rook", color, rng);
    for (let i = 0; i < 3; i++) placeRandom(b, randomOtherType(rng), rng() < 0.5 ? "white" : "black", rng);
    const st = baseState(b, makeDecks(rng, "brutus", color, 2), color, rng);
    const isCard = (a) => a.type === "card" && a.cardId === "brutus";
    push("cards.jsonl", "card:brutus:random-rook", st, color, answer(st, color, (raw) => sampleActions(raw, rng, isCard, cardApplied), cardApplied));
  }
  // 3) playouts + 4) game-over: seeded random games from the standard start (+ special pieces); every 4th ply sampled
  rng = rngMaker(seedFor(seed, 3));
  const rngG = rngMaker(seedFor(seed, 4));
  const SAMPLE_PLIES = new Set(String(arg("sample-plies", "5,15,31")).split(",").map(Number));
  for (let g = 0; g < playouts; g++) {
    const st = baseState(startBoard(rng), makeDecks(rng, null, null), "white", rng);
    st.turnsTaken = { white: 0, black: 0 }; st.moveCount = 0; st.castlingCanceled = { white: false, black: false };
    const mkPlay = DET_RANDOM();
    for (let p = 0; p < plies && st.mode !== "gameover"; p++) {
      const color = st.turn;
      const ll = legalList(st, color);
      if (!ll) { stats.droppedLegalNondeterministic++; break; }
      if (!ll.raw.length) break;
      if (SAMPLE_PLIES.has(p)) push("playouts.jsonl", `playout:${g}:${p}`, st, color, answer(st, color, (r2) => sampleActions(r2, rng, (a) => a.type === "card", maxApplied), maxApplied));
      const cards = ll.raw.filter((a) => a.type === "card");
      const act = cards.length && rng() < 0.3 ? cards[Math.floor(rng() * cards.length)] : ll.raw[Math.floor(rng() * ll.raw.length)];
      const before = clone(st);
      Math.random = mkPlay;
      let r; try { r = oracle.applyAction(st, clone(act), color); } finally { Math.random = realRandom; }
      if (!r.ok) break;
      if (st.mode === "gameover") {
        // the position right before the ending action (ending action forced into applied) and the terminal position itself
        push("gameover.jsonl", `gameover:playout:${g}`, before, color, answer(before, color, (r2) => [act].concat(sampleActions(r2, rngG, () => false, maxApplied)), maxApplied));
        push("gameover.jsonl", `terminal:playout:${g}`, st, st.turn, answer(st, st.turn, (r2) => sampleActions(r2, rngG, () => false, maxApplied), maxApplied));
      }
    }
  }
  // 4b) constructed king-capture boards: random sparse boards where some legal action ends the game
  let built = 0;
  for (let attempt = 0; attempt < 4000 && built < builtTarget; attempt++) {
    const { board } = makeBoard(rngG, null);
    const color = rngG() < 0.5 ? "white" : "black";
    const st = baseState(board, makeDecks(rngG, null, null), color, rngG);
    const ll = legalList(st, color); if (!ll) continue;
    const enders = ll.raw.filter((a) => { if (a.type === "card") return false; const r = applyOnceFast(st, a, color); return r && r.mode === "gameover"; });
    if (!enders.length) continue;
    const ok = push("gameover.jsonl", "gameover:constructed", st, color, answer(st, color, (r2) => enders.concat(sampleActions(r2, rngG, () => false, maxApplied)), Math.max(maxApplied, Math.min(enders.length, 3) + 1)));
    if (ok) {
      built++;
      const afterKey = files["gameover.jsonl"][files["gameover.jsonl"].length - 1].expected.applied.find((x) => x.ok && x.signature.mode === "gameover");
      if (afterKey) { const ts = stateApply(files["gameover.jsonl"][files["gameover.jsonl"].length - 1].state, afterKey.stateDelta); push("gameover.jsonl", "terminal:constructed", ts, ts.turn, answer(ts, ts.turn, (r2) => sampleActions(r2, rngG, () => false, maxApplied), maxApplied)); }
    }
  }
  function applyOnceFast(st, a, color) { const copy = oracle.cloneState(st); const r = withRandom(RANDOM_STREAMS[0], () => oracle.applyAction(copy, clone(a), color)); return r.ok ? copy : null; }

  stats.mathRandomCallsByWorker = randomCalls;
  fs.mkdirSync(outDir, { recursive: true });
  const sums = {}, counts = {};
  for (const [name, arr] of Object.entries(files)) {
    const text = arr.map((f) => J(f)).join("\n") + "\n";
    fs.writeFileSync(path.join(outDir, name), text);
    sums[name] = { sha256: crypto.createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), fixtures: arr.length };
    const bySrc = {}; arr.forEach((f) => { const k = f.source.split(":")[0]; bySrc[k] = (bySrc[k] || 0) + 1; }); counts[name] = bySrc;
  }
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, "last-seen.json"), "utf8"));
  let commit = arg("generator-commit", null);
  if (!commit) { try { commit = cp.execSync("git rev-parse HEAD", { cwd: __dirname }).toString().trim(); } catch (e) { commit = "unknown"; } }
  const workerFile = path.join(__dirname, ".cache", "real-worker.js");
  const zeroCardAction = CARDS.filter((c) => !cov.cards[c].positionsWithCardAction);
  const noApplied = CARDS.filter((c) => !cov.cards[c].appliedDeterministic && !cov.cards[c].appliedNondeterministic);
  const meta = {
    format: "oracle-v1 superset (see README.md)",
    seed, params: { perPiece, perCard, playouts, plies, maxApplied, cardApplied, constructedGameover: builtTarget, samplePlies: [...SAMPLE_PLIES] },
    generator: { repo: "Vamp-pire/Augment-Chess-Engine-Twist", path: "tools/site-parity/gen-reference-fixtures.js", commit },
    site: { mainBundle: site.mainBundle, mainBundleBytes: site.mainBundleBytes, aiWorkerSha256: site.aiWorkerSha256, aiWorkerBytes: site.aiWorkerBytes, updateLogVersion: site.updateLogVersion },
    realWorkerJsSha256: crypto.createHash("sha256").update(fs.readFileSync(workerFile)).digest("hex"),
    files: sums, fixturesBySource: counts, stats, terminalWinners: winners,
    coverage: {
      pieceTypesInPool: PIECES.length, pieceTypesWithFixture: PIECES.filter((t) => cov.pieces[t].fixtures).length,
      pieceTypesWithApplied: PIECES.filter((t) => cov.pieces[t].applied).length,
      cardIdsInPool: CARDS.length,
      cardIdsInHand: CARDS.filter((c) => cov.cards[c].inHand).length,
      cardIdsWithLegalCardAction: CARDS.length - zeroCardAction.length,
      cardIdsWithAppliedDeterministic: CARDS.filter((c) => cov.cards[c].appliedDeterministic).length,
      cardIdsWithAppliedNondeterministicOnly: CARDS.filter((c) => !cov.cards[c].appliedDeterministic && cov.cards[c].appliedNondeterministic).length,
      cardIdsNeverProducingCardAction: zeroCardAction,
      cardIdsNeverApplied: noApplied,
      pieces: cov.pieces, cards: cov.cards
    }
  };
  fs.writeFileSync(path.join(outDir, "meta.json"), J(meta, null, 1) + "\n");
  console.log(`worker=${workerKind} positions=${stats.positions} applied=${stats.appliedTotal} nondeterministic=${stats.nondeterministicTotal} dropped=${stats.droppedLegalNondeterministic}`);
  for (const [n, s] of Object.entries(sums)) console.log(`  ${n}: ${s.fixtures} fixtures, ${s.bytes} bytes`);
  const cv = meta.coverage;
  console.log(`pieces ${cv.pieceTypesWithFixture}/${cv.pieceTypesInPool} on board, ${cv.pieceTypesWithApplied} applied; cards ${cv.cardIdsInHand}/${cv.cardIdsInPool} in hand, ${cv.cardIdsWithLegalCardAction} with legal card action, ${cv.cardIdsWithAppliedDeterministic} applied deterministic, ${cv.cardIdsWithAppliedNondeterministicOnly} nondeterministic only; gameover states ${stats.gameoverStates}, applied-ending-game ${stats.appliedEndingGame}`);
}

// ---------------------------------------------------------------- verify / serve
function readFixtures(dir) {
  const out = [];
  for (const n of ["pieces.jsonl", "cards.jsonl", "playouts.jsonl", "gameover.jsonl"]) {
    const p = path.join(dir, n); if (!fs.existsSync(p)) continue;
    fs.readFileSync(p, "utf8").split("\n").filter(Boolean).forEach((l) => out.push(JSON.parse(l)));
  }
  return out;
}
function verify(dir) {
  const fx = readFixtures(dir);
  let bad = 0, applied = 0, nd = 0, ndLegal = 0;
  for (const f of fx) {
    let ok = true, why = "";
    const st = rehydrate(f.state);
    const ll = legalList(st, f.color);
    if (!ll || J(ll.keys) !== J(f.expected.legalActions)) { ok = false; why = "legalActions"; }
    for (const it of f.expected.applied) {
      applied++;
      const r = applyStable(f.state, it.action, f.color);
      if (!r.det || r.ok !== it.ok || J(r.res) !== J(it.result) || J(r.signature) !== J(it.signature) || (it.ok && canon(r.state) !== canon(stateApply(f.state, it.stateDelta)))) { ok = false; why = why || "applied " + it.key.slice(0, 80); }
    }
    for (const it of f.expected.nondeterministic) { nd++; if (!new Set(f.expected.legalActions).has(it.key)) ndLegal++; }
    if (!ok) { bad++; if (bad <= 8) console.log("MISMATCH", f.id, f.source, why); }
  }
  console.log(`verified ${fx.length} fixtures (${applied} applied actions with full result+state delta, ${nd} nondeterministic actions listed, ${ndLegal} of those not in legalActions) against worker=${workerKind}: ${bad} mismatches`);
  process.exit(bad ? 1 : 0);
}
function serve() {
  const rl = require("readline").createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let req; try { req = JSON.parse(line); } catch (e) { process.stdout.write(J({ error: "bad json" }) + "\n"); return; }
    try {
      const ll = legalList(rehydrate(req.state), req.color);
      const applied = (req.actions || []).map((a) => { const r = applyOnce(req.state, a, req.color, RANDOM_STREAMS[0]); return { ok: r.ok, signature: r.signature }; });
      process.stdout.write(J({ id: req.id, legalActions: ll ? ll.keys : [], applied }) + "\n");
    } catch (e) { process.stdout.write(J({ id: req.id, error: String((e && e.message) || e) }) + "\n"); }
  });
}
const v = arg("verify", null);
if (arg("serve", false)) serve(); else if (v) verify(v); else generate();
