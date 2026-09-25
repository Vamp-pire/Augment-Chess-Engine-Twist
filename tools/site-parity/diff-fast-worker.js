// Differential check: .cache/real-worker-fast.js (make-fast-worker.js output) vs the original
// .cache/real-worker.js. Plays the same seeded random games in both (Math.random reseeded
// identically before every call) and requires byte-identical results at every ply: the raw
// generateActions output (ids included), the full state JSON after generateActions and after
// applyAction, applyAction's return value, and thrown error messages. Phase 2 does the same on
// random sparse positions with random rule/piece flags, applying every legal action (<=40) to clones.
// Usage: [POSITIONS=4*GAMES] node diff-fast-worker.js [GAMES=300] [seed=1] [PLIES=120] [fastPath]
// Exit code 1 on any divergence.
const C = require("./common"); const path = require("path");
const orig = C.real;
const fast = require(path.resolve(process.argv[5] || path.join(__dirname, ".cache", "real-worker-fast.js")));
if (fast === orig) throw new Error("fast worker resolved to the original module");
const GAMES = Number(process.argv[2] || 300), SEED = Number(process.argv[3] || 1), PLIES = Number(process.argv[4] || 120);
const SPECIAL = ["amazon","cardinal","grasshopper","hook","camel","berserker","thief","paladin","octopus","clockwork","brutus","checker","campfire","princess","scarecrow","slime","trickster"];
function startBoard(rng) {
  const back = ["rook","knight","bishop","queen","king","bishop","knight","rook"];
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (const [col, br, pr] of [["black",0,1],["white",7,6]]) for (let c=0;c<8;c++){ b[pr][c]={type:"pawn",color:col,moved:false}; b[br][c]={type:back[c],color:col,moved:false}; }
  const extra = 3 + Math.floor(rng() * 4);
  for (let k = 0; k < extra; k++) { const t = SPECIAL[Math.floor(rng()*SPECIAL.length)], c = Math.floor(rng()*8); const col = rng()<0.5?"white":"black"; const r = col==="white"?5:2; if (!b[r][c]) b[r][c]={type:t,color:col,moved:false}; }
  return b;
}
const realRandom = Math.random;
function call(fn, seed) { // same Math.random stream for both engines; capture throw as a value
  Math.random = C.rngMaker(seed);
  try { return { v: fn() }; } catch (e) { return { err: String(e && e.message) }; } finally { Math.random = realRandom; }
}
const J = (x) => JSON.stringify(x);
let games = 0, plies = 0, cardPlies = 0, compared = 0, divergences = 0, errPlies = 0; const samples = [];
for (let g = 0; g < GAMES; g++) {
  const rng = C.rngMaker(SEED * 1000003 + g);
  const board = startBoard(rng), decks = C.makeDecks(rng, 4);
  const A = C.makeState(orig, board, decks, "white"), B = C.makeState(fast, board, decks, "white");
  games++;
  const fail = (what, p, a, b) => { divergences++; if (samples.length < 20) samples.push(`game ${g} ply ${p} ${what}\n  orig: ${String(a).slice(0, 300)}\n  fast: ${String(b).slice(0, 300)}`); };
  if (J(A) !== J(B)) { fail("initial state", 0, "", ""); continue; }
  for (let p = 0; p < PLIES; p++) {
    if (A.mode === "gameover") break;
    const col = A.turn, s = Math.floor(rng() * 4294967296);
    const la = call(() => orig.generateActions(A, col), s), lb = call(() => fast.generateActions(B, col), s);
    compared++;
    if (J(la) !== J(lb)) { fail("generateActions", p, J(la), J(lb)); break; }
    if (J(A) !== J(B)) { fail("state after generateActions", p, "", ""); break; }
    if (la.err) { errPlies++; break; }
    const acts = la.v;
    if (!acts.length) break;
    const cards = acts.filter((a) => a.type === "card");
    const i = (cards.length && rng() < 0.3) ? acts.indexOf(cards[Math.floor(rng() * cards.length)]) : Math.floor(rng() * acts.length);
    if (acts[i].type === "card") cardPlies++;
    const s2 = Math.floor(rng() * 4294967296);
    const ra = call(() => orig.applyAction(A, JSON.parse(J(acts[i])), col), s2), rb = call(() => fast.applyAction(B, JSON.parse(J(lb.v[i])), col), s2);
    plies++;
    if (J(ra) !== J(rb)) { fail("applyAction result", p, J(ra), J(rb)); break; }
    const ja = J(A), jb = J(B);
    if (ja !== jb) { let k = 0; while (ja[k] === jb[k]) k++; fail("state after applyAction", p, ja.slice(Math.max(0, k - 80), k + 120), jb.slice(Math.max(0, k - 80), k + 120)); break; }
    if (ra.err) { errPlies++; break; }
    if (!ra.v.ok) break;
  }
}
console.log(`playouts: games=${games} plies=${plies} (card plies=${cardPlies}) generateActions compared=${compared} thrown(both, identical)=${errPlies} divergences=${divergences}`);

// Phase 2: random sparse positions with random rule flags (reaches forced-extra-move, checker,
// macho/zugzwang/... paths random playouts rarely hit). Every legal action (up to 40) is applied to
// a fresh clone in both workers and compared.
const TYPES = ["pawn","knight","bishop","rook","queen","king","amazon","cardinal","pegasus","assassin","dragon","cannon","grasshopper","hook","herald","camel","alfil","ferz","eagle","berserker","magicGirl","thief","paladin","octopus","clockwork","brutus","checker","campfire","princess","hedgehog","undead","siren","trickster","slime","scarecrow","merchant","idol","parrot","guard","lobster","siegeRam","missionary","wizard","log","football","wall"];
const PIECE_FLAGS = ["fileSurgeSecondMove","rookLiftSecondMove","madHorseSecondMove","ironMonarchExtraMove","frenzyExtraMove","checkerChainCapture","desperado","ghost","loyalist","royalCommand","crownBearer","inertia","metalized","shielded","frozen","submerged","regencyHeir"];
const COLOR_FLAGS = ["zugzwang","democracy","bishopSnipe","cornerKick","hillKing","kingKnight","reversal","socialism","locustSwarm","magicGirlSurge","overtake","religiousVictory","racingKing","taunt","royalKnightKing","imperialStudies","pawnConversion","castlingCanceled"];
const GLOBAL_FLAGS = ["machoChess","monochromeChess","camouflageRule","collapsed"];
const POSITIONS = Number(process.env.POSITIONS || GAMES * 4);
let positions = 0, applied = 0, thrown = 0; const div0 = divergences;
for (let i = 0; i < POSITIONS; i++) {
  const rng = C.rngMaker(SEED * 7919 + 500009 + i);
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const place = (type, color) => { for (let t = 0; t < 30; t++) { const r = Math.floor(rng()*8), c = Math.floor(rng()*8); if (!b[r][c] && !(type === "pawn" && (r === 0 || r === 7))) { const p = { type, color, moved: rng() < 0.5 }; if (rng() < 0.3) p.id = `${color}-${type}-${i}-${r}-${c}`; if (rng() < 0.15) p[PIECE_FLAGS[Math.floor(rng()*PIECE_FLAGS.length)]] = true; if (rng() < 0.03) p.idolEncoreRestTurn = 0; b[r][c] = p; return; } } };
  place("king", "white"); place("king", "black");
  const n = 4 + Math.floor(rng() * 12);
  for (let k = 0; k < n; k++) place(TYPES[Math.floor(rng()*TYPES.length)], rng() < 0.5 ? "white" : "black");
  const decks = C.makeDecks(rng, 3), color = rng() < 0.5 ? "white" : "black";
  let A, B;
  try { A = C.makeState(orig, b, decks, color); B = C.makeState(fast, b, decks, color); } catch (e) { continue; }
  const flags = (st, r2) => {
    for (const f of COLOR_FLAGS) if (r2() < 0.06) st[f] = { white: r2() < 0.5 ? (f === "socialism" || f === "taunt" ? 2 : true) : false, black: r2() < 0.5 ? (f === "socialism" || f === "taunt" ? 2 : true) : false };
    for (const f of GLOBAL_FLAGS) if (r2() < 0.06) st[f] = true;
    st.turnsTaken = { white: Math.floor(r2() * 6), black: Math.floor(r2() * 6) }; st.moveCount = st.turnsTaken.white + st.turnsTaken.black;
  };
  const fs2 = Math.floor(rng() * 4294967296); flags(A, C.rngMaker(fs2)); flags(B, C.rngMaker(fs2));
  positions++;
  const fail = (what, a, b2) => { divergences++; if (samples.length < 20) samples.push(`position ${i} ${what}\n  orig: ${String(a).slice(0, 300)}\n  fast: ${String(b2).slice(0, 300)}`); };
  const s = Math.floor(rng() * 4294967296);
  const la = call(() => orig.generateActions(A, color), s), lb = call(() => fast.generateActions(B, color), s);
  if (J(la) !== J(lb)) { fail("generateActions", J(la), J(lb)); continue; }
  if (J(A) !== J(B)) { fail("state after generateActions", "", ""); continue; }
  if (la.err) { thrown++; continue; }
  const acts = la.v, step = Math.max(1, Math.ceil(acts.length / 40));
  for (let k = 0; k < acts.length; k += step) {
    const ca = orig.cloneState(A), cb = fast.cloneState(B), s2 = Math.floor(rng() * 4294967296);
    const ra = call(() => orig.applyAction(ca, JSON.parse(J(acts[k])), color), s2), rb = call(() => fast.applyAction(cb, JSON.parse(J(lb.v[k])), color), s2);
    applied++;
    if (J(ra) !== J(rb)) { fail(`applyAction #${k} result`, J(ra), J(rb)); break; }
    if (J(ca) !== J(cb)) { fail(`state after applyAction #${k}`, "", ""); break; }
    if (ra.err) thrown++;
    const na = call(() => orig.generateActions(ca, ca.turn), s2), nb = call(() => fast.generateActions(cb, cb.turn), s2);
    if (J(na) !== J(nb)) { fail(`generateActions after applyAction #${k}`, J(na), J(nb)); break; }
  }
}
console.log(`positions: ${positions} actions applied=${applied} (+ next-ply generateActions each) thrown(both, identical)=${thrown} divergences=${divergences - div0}`);
console.log(`TOTAL divergences=${divergences}`);
samples.forEach((s) => console.log(s));
process.exitCode = divergences ? 1 : 0;
