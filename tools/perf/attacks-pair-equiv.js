// Pairwise equivalence of attacksSquare / workerBestCaptureThreat / hangingMaterialRisk / evaluateStateComponents: tools/perf/engine-orig.js vs engine-merged.js
// (every attacker piece x every board cell; real positions, random-action walks, random exotic boards). Exit code 1 on any difference.
// usage: node tools/perf/attacks-pair-equiv.js [NREAL=300] [NEWPATH] [SEED] [MODE=all|real|walk|exotic] [NWALK=150] [NEXOTIC=300]
globalThis.self = globalThis; globalThis.addEventListener = () => {};
const fs = require("fs");
const SP = __dirname, ROOT = require("path").join(__dirname, "..", ".."), TMP = require("os").tmpdir();
const NEWP = process.argv[3] || ROOT + "/engine-merged.js";
function load(src, name) {
  let t = fs.readFileSync(src, "utf8");
  const inj = `module.exports.__T = { attacksSquare, attacksSquareRaw, workerBestCaptureThreat, hangingMaterialRisk, evaluateStateComponents, forEachPiece, withMemo(board, fn){ const prev=ATTACK_MEMO; ATTACK_MEMO = { board, map: new Map(), pieces: null, cols: -1, rows: -1, dimCols: -1, campfire: -1, encouraged: new Map(), ranged: new Map(), attackers: new Map() }; try { return fn(); } finally { ATTACK_MEMO = prev; } } };`;
  const marker = 'if (typeof module !== "undefined") module.exports = globalThis.__engineMerged;';
  if (!t.includes(marker)) throw new Error("marker");
  t = t.replace(marker, () => marker + "\n" + inj);
  const out = TMP + "/attacks-pair-equiv-" + process.pid + "-" + name + ".js"; fs.writeFileSync(out, t); return require(out);
}
const O = load(SP + "/engine-orig.js", "old"), N = load(NEWP, "new");
const OT = O.__T, NT = N.__T;
const lines = fs.readFileSync(ROOT + "/data/experiments/selfplay-data.merged-engine-16cards-local-2026-09-15.jsonl", "utf8").split("\n").filter(Boolean);
let seed = (+process.argv[4] || 12345) >>> 0; const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const ri = (n) => Math.floor(rng() * n);
function mkReal(e, rec, cards, turn) {
  const s = e.cloneState({}); s.board = rec.board.map(r => r.map(p => p ? { type: p.t, color: p.c, moved: true } : null)); s.mode = "play"; s.turn = turn;
  s.deckSlots = { white: rec.deckSlots?.white || [], black: rec.deckSlots?.black || [] }; s.captures = { white: [], black: [] }; s.aiSearchNoCards = !cards; s.turnsTaken = { white: 10, black: 10 }; s.actionsRemaining = 1; s.moveCount = 20; s.castlingCanceled = { white: true, black: true }; e.setWorkerBoardDimensions(s); return s;
}
function rs(k) { let z = (k * 2654435761 + 1) >>> 0; Math.random = () => ((z = (z * 1664525 + 1013904223) >>> 0) / 4294967296); }
const stats = { states: 0, pairs: 0, threats: 0, risk: 0, eval: 0, diffs: 0, errs: 0, falsyNonFalse: 0 };
const samples = [];
function diff(msg) { stats.diffs++; if (samples.length < 8) samples.push(msg); }
function safe(f) { try { return f(); } catch (x) { stats.errs++; return "ERR:" + x.message; } }
function descP(p) { return p ? p.type + ":" + p.color : "-"; }
function norm(v) { if (typeof v === 'string' && v.startsWith('ERR:')) return v; if (v === true) return 'T'; if (!v) { if (v !== false) stats.falsyNonFalse++; return 'F'; } return 'truthy:' + String(v); }
function compare(so, sn, tag) {
  stats.states++;
  const rows = so.board.length, cols = Math.max(...so.board.map(r => r.length));
  const lo = [], ln = []; OT.forEachPiece(so, (p, r, c) => lo.push([p, r, c])); NT.forEachPiece(sn, (p, r, c) => ln.push([p, r, c]));
  if (lo.length !== ln.length) { diff(tag + " piece list len"); return; }
  const runA = (T, s, list, memo) => { const out = []; const body = () => { for (const [p, r, c] of list) for (let tr = 0; tr < rows; tr++) for (let tc = 0; tc < cols; tc++) out.push(norm(safe(() => T.attacksSquare(s, p, r, c, tr, tc)))); return out; }; return memo ? T.withMemo(s, body) : body(); };
  const ao = runA(OT, so, lo, true), an = runA(NT, sn, ln, true), aoR = runA(OT, so, lo, false), anR = runA(NT, sn, ln, false);
  stats.pairs += ao.length * 4;
  for (let i = 0; i < ao.length; i++) { if (ao[i] !== an[i] || ao[i] !== aoR[i] || ao[i] !== anR[i]) { { const pi = Math.floor(i / (rows * cols)), rem = i % (rows * cols); const [pp, pr, pc] = lo[pi]; const tt = so.board[Math.floor(rem / cols)][rem % cols]; diff(tag + " attacks idx " + i + " " + [ao[i], an[i], aoR[i], anR[i]] + " attacker " + JSON.stringify(pp) + "@" + pr + "," + pc + " target " + JSON.stringify(tt) + "@" + Math.floor(rem / cols) + "," + (rem % cols)); } break; } }
  const runB = (T, s, list, memo) => { const out = []; const body = () => { for (let rep = 0; rep < 2; rep++) for (const [p, r, c] of list) { const t = safe(() => T.workerBestCaptureThreat(s, p, r, c)); out.push(typeof t === "string" ? t : t ? [descP(t.piece), t.row, t.col].join(",") : "null"); } return out; }; return memo ? T.withMemo(s, body) : body(); };
  for (const memo of [true, false]) { const bo = runB(OT, so, lo, memo), bn = runB(NT, sn, ln, memo); stats.threats += bo.length; for (let i = 0; i < bo.length; i++) if (bo[i] !== bn[i]) { diff(tag + " threat memo=" + memo + " idx " + i + " " + bo[i] + " vs " + bn[i]); break; } }
  for (const col of ["white", "black"]) {
    const ho = safe(() => OT.hangingMaterialRisk(so, col)), hn = safe(() => NT.hangingMaterialRisk(sn, col)); stats.risk++; if (!Object.is(ho, hn)) diff(tag + " risk " + col + " " + ho + " vs " + hn);
    const eo = safe(() => JSON.stringify(OT.evaluateStateComponents(so, col))), en = safe(() => JSON.stringify(NT.evaluateStateComponents(sn, col))); stats.eval++; if (eo !== en) { let ks = ""; try { const a = JSON.parse(eo), b = JSON.parse(en); ks = Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(k => k + ":" + JSON.stringify(a[k]) + "/" + JSON.stringify(b[k])).join(" "); } catch (x) { ks = String(eo).slice(0, 100) + "|" + String(en).slice(0, 100); } diff(tag + " eval " + col + " " + ks); }
  }
}
const NREAL = +process.argv[2] || 300;
const mode = process.argv[5] || "all";
const step = Math.floor(lines.length / NREAL);
const walkStates = [];
if (mode === "all" || mode === "real" || mode === "walk") {
  for (let k = 0, i = 0; k < NREAL && i < lines.length; k++, i += step) {
    const rec = JSON.parse(lines[i]);
    const cards = k % 2 === 0, turn = k % 4 < 2 ? "white" : "black";
    if (mode !== "walk") { const so = mkReal(O, rec, cards, turn), sn = mkReal(N, rec, cards, turn); compare(so, sn, "real#" + i + (cards ? "+cards" : "") + turn); }
    if (k % 3 === 0) walkStates.push([rec, cards, turn]);
  }
}
if (mode === "all" || mode === "walk") {
  const NW = +process.argv[6] || 150; let wcount = 0, desync = 0;
  for (let w = 0; w < NW && walkStates.length; w++) {
    const [rec, cards, turn] = walkStates[w % walkStates.length];
    let so = mkReal(O, rec, cards, turn), sn = mkReal(N, rec, cards, turn), col = turn;
    const steps = 1 + ri(24);
    for (let st = 0; st < steps; st++) {
      let ao, an; try { rs(w * 1000 + st); ao = O.generateActions(so, col); rs(w * 1000 + st); an = N.generateActions(sn, col); } catch (x) { break; }
      if (!ao.length || ao.length !== an.length) { if (ao.length !== an.length) diff("walk action count " + ao.length + " vs " + an.length); break; }
      const cardIdx = []; ao.forEach((a, i) => { if (a.type !== "move") cardIdx.push(i); });
      const idx = cardIdx.length && rng() < 0.35 ? cardIdx[ri(cardIdx.length)] : ri(ao.length);
      rs(w * 1000 + st + 7); const ro = safe(() => O.applyAction(so, JSON.parse(JSON.stringify(ao[idx])), col)); rs(w * 1000 + st + 7); const rn = safe(() => N.applyAction(sn, JSON.parse(JSON.stringify(an[idx])), col));
      if (typeof ro === "string" || typeof rn === "string") break;
      if (so.mode === "gameover" || sn.mode === "gameover") break;
      if (JSON.stringify(so) !== JSON.stringify(sn)) { desync++; break; }
      col = so.turn || (col === "white" ? "black" : "white");
      if (st % 3 === 2 || st === steps - 1) { compare(so, sn, "walk" + w + "@" + st); wcount++; }
    }
  }
  console.log("walk compares", wcount, "desynced walks (state differs between the two engines before compare, stopped)", desync);
}
if (mode === "all" || mode === "exotic") {
  const NX = +process.argv[7] || 300;
  const TYPES = ["pawn", "knight", "bishop", "rook", "queen", "amazon", "cardinal", "grasshopper", "hook", "camel", "alfil", "berserker", "thief", "paladin", "octopus", "clockwork", "brutus", "checker", "campfire", "princess", "hedgehog", "undead", "siren", "trickster", "slime", "scarecrow", "merchant", "cannon", "eagle", "magicGirl", "colossus", "bigRook", "bigBishop", "wall", "guard", "recruiter", "missionary", "siegeRam", "knightmaster", "assassin", "royalKnight", "shotgunKing", "darkWizard", "vampireLord", "timeTraveler", "fanatic", "protestant", "lobster", "bat", "jester", "primeMinister", "vip", "crown", "man", "reaper", "dragon", "alibaba", "ferz", "pegasus", "unicorn", "idol", "wizard", "herald", "standardBearer", "squire", "bear", "coffin", "monster", "windmill", "checkerKing", "king"];
  const PROPS = [p => { p.frozen = true }, p => { p.staked = { remaining: 2 } }, p => { p.poisonStunTurns = 1 }, p => { p.basicTraining = true }, p => { p.crownBearer = true }, p => { p.royalCommand = true }, p => { p.shielded = true }, p => { p.hp = 2; p.maxHp = 2 }, p => { p.potionManner = true; p.coolGuyCapturedLast = true }, p => { p.repositionSecondMove = true }, p => { p.freshNoCaptureUntil = 99 }, p => { p.cardNoCaptureUntil = 99 }, p => { p.quantumNoCaptureUntil = 99 }, p => { p.undergroundBunker = true; p.hp = 3 }, p => { p.tricksterMoveType = ["queen", "rook", "knight", "campfire", "guard", "bishop", "siegeRam"][ri(7)] }, p => { p.protected = true }, p => { p.metalized = true }, p => { p.captureRestriction = ["immune", "royal-only"][ri(2)] }, p => { p.regencyHeir = true }, p => { p.bearMoveLockedUntilTurn = 99 }, p => { p.potionBasicTraining = true; p.basicTraining = true }, p => { p.submerged = true }, p => { p.frenzy = true }, p => { p.editorRoyal = true }, p => { p.potionSaturation = true; p.capturesMade = 5 }, p => { p.windmillMode = "rook" }, p => { p.darkMagicCircle = true }, p => { p.ammo = 3 }, p => { p.nullification = true }, p => { p.outpostProtected = true }];
  const FLAGS = [s => { s.killerKing = { white: true, black: true } }, s => { s.imperialStudies = { white: true, black: true } }, s => { s.vanguard = { white: true, black: true } }, s => { s.reversal = { white: true, black: true } }, s => { s.highGround = [{ row: ri(8), col: ri(8) }, { row: ri(8), col: ri(8) }, { row: ri(8), col: ri(8) }] }, s => { s.retreat = { white: true, black: true } }, s => { s.pawnConversion = { white: true } }, s => { s.kingKnight = { white: true, black: true } }, s => { s.cornerKick = { white: true, black: true } }, s => { s.hillKing = { white: true, black: true } }, s => { s.bishopSnipe = { white: true, black: true } }, s => { s.diceLocks = { white: { type: ["rook", "king", "pawn", "queen"][ri(4)], remaining: 2 } } }, s => { s.manner = { white: true }; s.coolGuy = rng() < 0.5 }, s => { s.freeMoveCaptureLock = { black: true } }, s => { s.quantumPending = { white: true } }, s => { s.highway = true }, s => { s.initiative = { white: { startTurn: 0, limit: 99 } } }, s => { s.socialism = { white: 1, black: 1 } }, s => { s.genevaConvention = { white: true, black: true } }, s => { s.frontlineResponse = { white: true, black: true } }, s => { s.royalCommand = { white: { turn: 0, until: 99 }, black: { turn: 0, until: 99 } } }, s => { s.saturationRule = true }, s => { s.effects = { pawnReverse: { white: 2 } } }, s => { s.vanguardDiagonalOnly = false; s.vanguard = { white: true, black: true } }, s => { s.overtake = { white: true } }, s => { s.armistice = { active: true } }, s => { s.monochromeChess = true }, s => { s.collapsed = true; s.collapseDepth = 1 }, s => { s.diceLocks = { black: { type: "king", remaining: 1 } } }, s => { s.pendingPortals = [{ cells: [{ row: 3, col: 3 }, { row: 4, col: 4 }] }] }, s => { s.portalRule = true }, s => { s.portalRule = { enabled: true } }, s => { s.portalRule = { enabled: true, cells: [{ row: 1, col: 1 }, { row: 6, col: 6 }] } }, s => { s.knightInjury = { white: true, black: true } }, s => { s.kingDead = { white: true, black: true }; s.regency = { white: true, black: true } }, s => { s.kingKnight = { white: true, black: true }; s.kingDead = { white: true, black: true }; s.regency = { white: true, black: true } }, s => { s.hillKing = { white: true, black: true }; s.kingKnight = { white: true, black: true } }, s => { s.royalKnightKing = { white: true, black: true } }, s => { s.effects = { pawnReverse: { white: 1, black: 1 } } }, s => { s.vanguardDiagonalOnly = false }, s => { s.bishopSnipe = { white: false, black: true } }, s => { s.cornerKick = { white: false } }, s => { s.highGround = [{ row: 3, col: 3 }, { row: 3, col: 4 }, { row: 4, col: 3 }, { row: 4, col: 4 }] }];
  for (let n = 0; n < NX; n++) {
    const b = Array.from({ length: 8 }, () => Array(8).fill(null));
    const put = (t, c) => { for (let k = 0; k < 40; k++) { const r = ri(8), col = ri(8); if (!b[r][col] && !(t === "pawn" && (r === 0 || r === 7))) { const p = { type: t, color: t === "wall" ? null : c, moved: rng() < 0.5 }; if (rng() < 0.35) { const q = 1 + ri(2); for (let z = 0; z < q; z++) PROPS[ri(PROPS.length)](p); } b[r][col] = p; return; } } };
    put("king", "white"); put("king", "black");
    const cnt = 4 + ri(22); for (let k = 0; k < cnt; k++) put(rng() < 0.5 ? ["pawn", "pawn", "knight", "rook", "bishop", "queen", "knightmaster", "campfire", "standardBearer", "guard", "recruiter"][ri(11)] : TYPES[ri(TYPES.length)], rng() < 0.5 ? "white" : "black");
    const flagIdx = []; const nf = ri(5); for (let k = 0; k < nf; k++) flagIdx.push(ri(FLAGS.length));
    const withCards = rng() < 0.6; const drec = JSON.parse(lines[ri(lines.length)]); const decks = { white: drec.deckSlots?.white || [], black: drec.deckSlots?.black || [] };
    const seedSave = seed; const turn = rng() < 0.5 ? "white" : "black";
    const build = (e) => { seed = seedSave; const s = e.cloneState({}); s.board = JSON.parse(JSON.stringify(b)); s.mode = "play"; s.turn = turn; s.actionsRemaining = 1; s.deckSlots = JSON.parse(JSON.stringify(decks)); s.captures = { white: [], black: [] }; s.aiSearchNoCards = !withCards; s.turnsTaken = { white: 10, black: 10 }; s.moveCount = 20; flagIdx.forEach(i => FLAGS[i](s)); e.setWorkerBoardDimensions(s); return s; };
    const so = build(O), sn = build(N);
    compare(so, sn, "exotic#" + n + " flags" + flagIdx);
    seed = (seedSave * 7 + 13) >>> 0;
  }
}
console.log(JSON.stringify(stats)); samples.forEach(s => console.log("DIFF", s));
for (const n of ["old", "new"]) { try { fs.unlinkSync(TMP + "/attacks-pair-equiv-" + process.pid + "-" + n + ".js"); } catch (x) {} }
process.exit(stats.diffs ? 1 : 0);
