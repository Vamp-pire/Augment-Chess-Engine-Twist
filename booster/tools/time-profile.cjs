// Where does a move's time go? Runs pick() on corpus positions and reports,
// per stage (prep, base search, cards, verify, card check, opponent threat,
// safety), the average ms, and how much of the whole is the fast engine
// versus the game's own rule code. Compares worker variants:
//   orig     the site's worker as served
//   speed    + speed-patches.js (what the extension uses)
//   both     + the Twist make-fast-worker patches whose anchors still match
//
//   node tools/time-profile.cjs <worker.js> [--corpus test-data/corpus-2.jsonl.gz] [--n 12] [--ms 3000]
//        [--variants orig,speed,both] [--twist D:/증강체스엔진/tools/site-parity/make-fast-worker.js] [--cards 1]
// --helpers N: N helper threads judge cards and move checks in parallel.
// --cards 1: only positions where the side to move holds a card.
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const { loadGame } = require("./harness.cjs");
const { applySpeedPatches } = require("../speed-patches.js");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const workerPath = args[0];
const corpus = opt("corpus", [path.join(__dirname, "..", "test-data", "corpus-2.jsonl.gz"), "D:/증강체스엔진/booster/test-data/corpus-2.jsonl.gz"].find((p) => fs.existsSync(p)));
const N = Number(opt("n", 12)), ms = Number(opt("ms", 3000)), needCards = opt("cards", "0") === "1";
const variants = opt("variants", "orig,speed,both").split(",");
const helpers = Number(opt("helpers", 0));
const twistPath = opt("twist", "D:/증강체스엔진/tools/site-parity/make-fast-worker.js");

function twistPatches(src) {
  let PATCHES = [];
  try { ({ PATCHES } = require(path.resolve(twistPath))); } catch { return { code: src, applied: [], skipped: ["(make-fast-worker.js not found)"] }; }
  const applied = [], skipped = [];
  const count = (h, n) => { let c = 0, i = 0; while ((i = h.indexOf(n, i)) !== -1) { c++; i += n.length; } return c; };
  for (const p of PATCHES) {
    const pairs = [[p.find, p.replace], ...(p.also || [])];
    if (pairs.every(([f]) => count(src, f) === 1)) { for (const [f, r] of pairs) src = src.replace(f, () => r); applied.push(p.name); }
    else skipped.push(p.name);
  }
  return { code: src, applied, skipped };
}

function codeFor(v, src) {
  if (v === "orig") return { code: src, note: "" };
  const sp = applySpeedPatches(src);
  if (v === "speed") return { code: sp.code, note: `speed ${sp.applied.length} applied, ${sp.skipped.length} skipped` };
  const tw = twistPatches(sp.code);
  return { code: tw.code, note: `speed ${sp.applied.length} + twist ${tw.applied.join(",") || "-"}${tw.skipped.length ? ` (skipped ${tw.skipped.join(",")})` : ""}` };
}

(async () => {
  const src = fs.readFileSync(workerPath, "utf8").replace(/\r\n/g, "\n");
  const lines = zlib.gunzipSync(fs.readFileSync(corpus)).toString().split("\n").filter(Boolean);
  const step = Math.max(1, Math.floor(lines.length / (N * 4)));
  const out = {};
  for (const v of variants) {
    const { code, note } = codeFor(v, src);
    const { game } = loadGame(workerPath, { patchedCode: code });
    if (helpers > 0) { const { installHelpers, stopHelpers } = require("./node-helpers.cjs"); stopHelpers(); installHelpers({ workerPath, patchedCode: code }); }
    const agg = { n: 0, total: 0, engine: 0, depth: 0, cardsScored: 0, cardsAvail: 0, verified: 0, stage: {}, prep: {} };
    let used = 0;
    for (let i = 0; i < lines.length && used < N; i += step) {
      let snap;
      try { snap = await game.prepareCanonicalAiSearchSnapshot(JSON.parse(lines[i])); } catch { continue; }
      if (snap.game.status !== "ACTIVE") continue;
      if (needCards) {
        const turn = snap.game.position?.turn ?? snap.game.turn;
        const inv = snap.game.cardState?.inventories?.[turn] ?? snap.game.cards?.inventories?.[turn];
        const held = JSON.stringify(inv ?? "").match(/AVAILABLE/g)?.length ?? 0;
        if (!held) continue;
      }
      const t0 = performance.now();
      let r;
      try { r = await game.adapter.pick(snap, { timeMs: ms, includeCards: true, maxCardProbes: 64, noHelper: true, helpers, rawSnapshot: JSON.parse(lines[i]) }); } catch (e) { continue; }
      const wall = performance.now() - t0;
      if (!r?.ok) continue;
      used++;
      agg.n++; agg.total += wall; agg.engine += r.engineMs ?? 0; agg.depth += r.depth ?? 0;
      agg.cardsScored += r.cards?.length ?? 0; agg.verified += (r.topMoves ?? []).filter((m) => m.real !== null).length; agg.cardsAvail += r.cardsAvailable ?? 0;
      for (const [k, x] of Object.entries(r.stageTiming ?? {})) agg.stage[k] = (agg.stage[k] || 0) + x;
      for (const [k, x] of Object.entries(r.prepTiming ?? {})) agg.prep[k] = (agg.prep[k] || 0) + x;
      process.stdout.write(`\r${v} ${used}/${N}`);
    }
    out[v] = agg;
    const a = (x) => Math.round(x / Math.max(1, agg.n));
    console.log(`\n== ${v} (${note || "as served"}) positions ${agg.n}, budget ${ms} ms`);
    console.log(`   wall ${a(agg.total)} ms, engine ${a(agg.engine)} ms (${Math.round(100 * agg.engine / Math.max(1, agg.total))}%), rule code ${a(agg.total - agg.engine)} ms, depth ${(agg.depth / Math.max(1, agg.n)).toFixed(2)}, moves checked ${(agg.verified / Math.max(1, agg.n)).toFixed(1)}, cards scored ${(agg.cardsScored / Math.max(1, agg.n)).toFixed(1)}/${(agg.cardsAvail / Math.max(1, agg.n)).toFixed(1)}`);
    console.log(`   stages: ${Object.entries(agg.stage).map(([k, x]) => `${k} ${a(x)}`).join(", ")}`);
    console.log(`   prep:   ${Object.entries(agg.prep).map(([k, x]) => `${k} ${a(x)}`).join(", ")}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
