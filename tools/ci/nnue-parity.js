// The browser extension (extension/engine.js + extension/nnue.js) must produce
// exactly the same NNUE score as the Node training pipeline (nnue/encode.js +
// nnue/forward.js) for both shipped models; otherwise trained weights are
// meaningless in the extension. Fails on any difference above 1e-9.
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const EXT = path.join(ROOT, "extension") + path.sep;
globalThis.self = globalThis; globalThis.addEventListener = () => {};
globalThis.document = { documentElement: { dataset: { augExtBase: EXT } } };
const store = {}; globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
globalThis.fetch = async (p) => ({ json: async () => JSON.parse(fs.readFileSync(p, "utf8")) });
new Function(fs.readFileSync(EXT + "engine.js", "utf8"))();
new Function(fs.readFileSync(EXT + "nnue.js", "utf8"))();
const ext = globalThis.__augNNUE, engine = globalThis.AugmentEngine;
const { encodeBoard, INPUT_SIZE } = require(path.join(ROOT, "nnue", "encode.js"));
const { forward, loadWeights } = require(path.join(ROOT, "nnue", "forward.js"));
if (ext.INPUT_SIZE !== INPUT_SIZE) { console.error(`FAIL: input size extension=${ext.INPUT_SIZE} training=${INPUT_SIZE}`); process.exit(1); }
let x = 99 >>> 0; const rng = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
const TYPES = ["pawn","knight","bishop","rook","queen","amazon","cardinal","hook","camel","berserker","paladin","octopus","clockwork","parrot","campfire","princess","hedgehog","siren","trickster","merchant","idol","colossus"];
const CARDS = ["campfire","reversal","scarecrow","othello","gale","freeze","witchTrial","thief","paladin","brutus","royalShield","zugzwang","highlander","metal"];
function board() { const b = Array.from({ length: 8 }, () => Array(8).fill(null)); const put = (t, c) => { for (let k = 0; k < 40; k++) { const r = Math.floor(rng()*8), col = Math.floor(rng()*8); if (!b[r][col] && !(t === "pawn" && (r === 0 || r === 7))) { b[r][col] = { t, c }; return; } } }; put("king","white"); put("king","black"); const n = 4 + Math.floor(rng()*10); for (let i = 0; i < n; i++) put(TYPES[Math.floor(rng()*TYPES.length)], rng()<0.5?"white":"black"); return b; }
(async () => {
  let maxDiff = 0, n = 0;
  for (const model of Object.keys(ext.MODELS)) {
    ext.setModel(model, { persist: false }); await ext.ensureLoaded(model); await new Promise((r) => setTimeout(r, 50));
    const w = loadWeights(EXT + ext.MODELS[model].file);
    for (let i = 0; i < 60; i++) {
      const bd = board(), mover = rng()<0.5?"white":"black", deck = { white: [], black: [] };
      for (const col of ["white","black"]) for (let k = 0; k < 3; k++) { const e = CARDS[Math.floor(rng()*CARDS.length)]; deck[col].push({ id: e, effect: e, used: false, recovering: false }); }
      const nodeIn = encodeBoard(bd, mover, deck); if (nodeIn === null) continue;
      const st = engine.cloneState({}); st.board = bd.map((row) => row.map((p) => p ? { type: p.t, color: p.c, moved: true } : null)); st.mode = "play"; st.deckSlots = JSON.parse(JSON.stringify(deck)); st.captures = { white: [], black: [] }; st.aiSearchNoCards = true; engine.setWorkerBoardDimensions(st);
      const es = ext.evaluate(st, mover); if (es === null) { console.error("FAIL: extension returned null for a non-terminal position"); process.exit(1); }
      maxDiff = Math.max(maxDiff, Math.abs(forward(w, nodeIn) - es)); n++;
    }
  }
  console.log(`nnue-parity: ${n} scores over ${Object.keys(ext.MODELS).length} models, max diff ${maxDiff}`);
  if (maxDiff > 1e-9) { console.error("FAIL: extension and training scores differ"); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
