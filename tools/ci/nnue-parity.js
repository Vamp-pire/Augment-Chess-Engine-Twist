// The browser extension (extension/engine.js + extension/nnue.js) must produce
// exactly the same NNUE score as the Node training pipeline (nnue/encode.js +
// nnue/forward.js) for every shipped model; otherwise trained weights are
// meaningless in the extension. Fails on any difference above 1e-9.
//
// 2026-09-30: models can now be "legacy" (5509-wide) or "fullstate" (15239-
// wide: FULL_PIECE_STATE=1 + STAR_TOTAL_FEATURES=1) -- see extension/nnue.js's
// LAYOUT_PRESETS comment. encode.js reads those two env vars at require()
// time, so this loads it TWICE under different env (clearing the require
// cache in between) to get a `legacy` and a `fullstate` encodeBoard/
// INPUT_SIZE side by side, and picks whichever matches each model's `dims`.
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

const encodePath = path.join(ROOT, "nnue", "encode.js");
function loadEncodeAs(dims) {
  delete require.cache[require.resolve(encodePath)];
  const prevFull = process.env.FULL_PIECE_STATE, prevStar = process.env.STAR_TOTAL_FEATURES;
  if (dims === "fullstate") { process.env.FULL_PIECE_STATE = "1"; process.env.STAR_TOTAL_FEATURES = "1"; }
  else { delete process.env.FULL_PIECE_STATE; delete process.env.STAR_TOTAL_FEATURES; }
  const mod = require(encodePath);
  if (prevFull === undefined) delete process.env.FULL_PIECE_STATE; else process.env.FULL_PIECE_STATE = prevFull;
  if (prevStar === undefined) delete process.env.STAR_TOTAL_FEATURES; else process.env.STAR_TOTAL_FEATURES = prevStar;
  return mod;
}
// Loaded unconditionally (cheap) so a "fullstate" model added later is
// covered without touching this file again.
const ENCODERS = { legacy: loadEncodeAs("legacy"), fullstate: loadEncodeAs("fullstate") };
const { forward, loadWeights } = require(path.join(ROOT, "nnue", "forward.js"));

if (ext.INPUT_SIZE !== ENCODERS.legacy.INPUT_SIZE) {
  console.error(`FAIL: input size extension(legacy)=${ext.INPUT_SIZE} training(legacy)=${ENCODERS.legacy.INPUT_SIZE}`);
  process.exit(1);
}

let x = 99 >>> 0; const rng = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
const TYPES = ["pawn","knight","bishop","rook","queen","amazon","cardinal","hook","camel","berserker","paladin","octopus","clockwork","parrot","campfire","princess","hedgehog","siren","trickster","merchant","idol","colossus"];
const CARDS = ["campfire","reversal","scarecrow","othello","gale","freeze","witchTrial","thief","paladin","brutus","royalShield","zugzwang","highlander","metal"];

// `dims === "fullstate"` sprinkles a handful of per-piece state fields (a
// subset of extension/nnue.js's BOOL_FIELDS/NUMERIC_FIELDS/ENUM_FIELD_VALUES)
// onto pieces, so the fullstate attribute-plane block actually gets
// exercised instead of comparing all-zero blocks on both sides.
function extraStateFor(dims) {
  if (dims !== "fullstate") return undefined;
  const extra = {};
  if (rng() < 0.3) extra.frozen = true;
  if (rng() < 0.3) extra.shielded = true;
  if (rng() < 0.3) extra.protected = true;
  if (rng() < 0.3) extra.hp = 1 + Math.floor(rng() * 4);
  if (rng() < 0.3) extra.capturesMade = Math.floor(rng() * 3);
  if (rng() < 0.3) extra.poisonStunTurns = Math.floor(rng() * 3);
  if (rng() < 0.3) extra.monoShade = rng() < 0.5 ? "light" : "dark";
  if (rng() < 0.3) extra.hiddenFrom = rng() < 0.5 ? "white" : "black";
  return extra;
}
function board(dims) {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const put = (t, c) => {
    for (let k = 0; k < 40; k++) {
      const r = Math.floor(rng()*8), col = Math.floor(rng()*8);
      // `moved: true` explicit (not left undefined) so node's encodeBoard --
      // which reads the ATTR "moved" bool straight off this raw board object
      // -- and the extension's single live-state view -- which reads the
      // SAME field off st.board after conversion below -- agree; encode.js's
      // OWN makeState() defaults an unset `moved` to true only for the
      // separate evaluateStateComponents() view, not for the ATTR block, so
      // leaving it unset here would (correctly) disagree between the two.
      if (!b[r][col] && !(t === "pawn" && (r === 0 || r === 7))) { b[r][col] = { t, c, moved: true, ...extraStateFor(dims) }; return; }
    }
  };
  put("king","white"); put("king","black");
  const n = 4 + Math.floor(rng()*10);
  for (let i = 0; i < n; i++) put(TYPES[Math.floor(rng()*TYPES.length)], rng()<0.5?"white":"black");
  return b;
}

(async () => {
  let maxDiff = 0, n = 0;
  for (const model of Object.keys(ext.MODELS)) {
    const dims = ext.MODELS[model].dims || "legacy";
    const enc = ENCODERS[dims];
    const expectedSize = ext.inputSizeFor(model);
    if (expectedSize !== enc.INPUT_SIZE) {
      console.error(`FAIL: ${model} (dims=${dims}) input size extension=${expectedSize} training=${enc.INPUT_SIZE}`);
      process.exit(1);
    }
    ext.setModel(model, { persist: false }); await ext.ensureLoaded(model); await new Promise((r) => setTimeout(r, 50));
    const w = loadWeights(EXT + ext.MODELS[model].file);
    for (let i = 0; i < 60; i++) {
      const bd = board(dims), mover = rng()<0.5?"white":"black", deck = { white: [], black: [] };
      for (const col of ["white","black"]) for (let k = 0; k < 3; k++) { const e = CARDS[Math.floor(rng()*CARDS.length)]; deck[col].push({ id: e, effect: e, used: false, recovering: false }); }
      const nodeIn = enc.encodeBoard(bd, mover, deck); if (nodeIn === null) continue;
      // Spread every extra field verbatim (not just type/color) so fullstate
      // attribute planes see the same per-piece state on both sides -- same
      // pattern as nnue/encode.js's own makeState().
      const st = engine.cloneState({});
      st.board = bd.map((row) => row.map((p) => {
        if (!p) return null;
        const { t, c, ...rest } = p;
        return { ...rest, type: t, color: c, moved: rest.moved !== undefined ? rest.moved : true };
      }));
      st.mode = "play"; st.deckSlots = JSON.parse(JSON.stringify(deck)); st.captures = { white: [], black: [] }; st.aiSearchNoCards = true; engine.setWorkerBoardDimensions(st);
      const es = ext.evaluate(st, mover); if (es === null) { console.error(`FAIL: extension returned null for a non-terminal position (model=${model})`); process.exit(1); }
      maxDiff = Math.max(maxDiff, Math.abs(forward(w, nodeIn) - es)); n++;
    }
  }
  console.log(`nnue-parity: ${n} scores over ${Object.keys(ext.MODELS).length} models, max diff ${maxDiff}`);
  if (maxDiff > 1e-9) { console.error("FAIL: extension and training scores differ"); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
