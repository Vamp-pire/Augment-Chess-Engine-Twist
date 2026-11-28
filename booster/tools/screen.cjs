// Quick screen before a cloud A/B (minutes, local): on corpus positions,
// each engine searches for --ms; reported are the average completed depth,
// nodes, and how often its move matches a reference move (the B engine with
// --ref-ms, much longer). An engine change that loses depth AND agreement is
// not worth a cloud run.
//
//   node booster/tools/screen.cjs <worker.js> --a booster/fast-engine.js --b booster/baseline/0.16.1/fast-engine.js
//        [--corpus booster/test-data/corpus-2.jsonl.gz] [--n 40] [--ms 500] [--ref-ms 4000] [--a-opts '{"kingSafety":true}']
"use strict";
const zlib = require("zlib"), fs = require("fs"), path = require("path");
const { loadGame } = require("./harness.cjs");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const workerPath = args[0];
const aPath = opt("a", path.join(__dirname, "..", "fast-engine.js")), bPath = opt("b", path.join(__dirname, "..", "baseline", "0.16.1", "fast-engine.js"));
const corpus = opt("corpus", path.join(__dirname, "..", "test-data", "corpus-2.jsonl.gz"));
const N = Number(opt("n", 40)), ms = Number(opt("ms", 500)), refMs = Number(opt("ref-ms", 4000));
const aOpts = JSON.parse(opt("a-opts", "{}")), bOpts = JSON.parse(opt("b-opts", "{}"));

(async () => {
  const { game } = loadGame(workerPath);
  const A = require(path.resolve(aPath))(), B = require(path.resolve(bPath))(), REF = require(path.resolve(bPath))();
  const lines = zlib.gunzipSync(fs.readFileSync(corpus)).toString().split("\n").filter(Boolean);
  const step = Math.max(1, Math.floor(lines.length / (N * 2)));
  const agg = { a: { d: 0, n: 0, hit: 0 }, b: { d: 0, n: 0, hit: 0 } };
  let used = 0;
  for (let i = 0; i < lines.length && used < N; i += step) {
    let input;
    try {
      const snap = await game.prepareCanonicalAiSearchSnapshot(JSON.parse(lines[i]));
      if (snap.game.status !== "ACTIVE") continue;
      const b = await game.adapter.buildInput(snap);
      if (!b.ok || b.input.rootMoves.length < 2) continue;
      input = b.input;
    } catch { continue; }
    const ref = REF.search({ ...input, ...bOpts, timeMs: refMs, freshTT: true });
    if (!ref.ok || !ref.move || Math.abs(ref.score) > 90000) continue; // forced wins tell nothing
    used++;
    const key = (r) => (r.move ? `${r.move.from}-${r.move.to}-${r.move.promo ?? ""}` : "-");
    const ra = A.search({ ...input, ...aOpts, timeMs: ms, freshTT: true });
    const rb = B.search({ ...input, ...bOpts, timeMs: ms, freshTT: true });
    for (const [k, r] of [["a", ra], ["b", rb]]) { if (!r.ok) continue; agg[k].d += r.depth; agg[k].n += r.nodes; agg[k].hit += key(r) === key(ref) ? 1 : 0; }
    process.stdout.write(`\r${used}/${N}`);
  }
  console.log(`\npositions ${used}, ${ms} ms each, reference: B at ${refMs} ms`);
  for (const k of ["a", "b"]) console.log(`${k === "a" ? "A " + aPath : "B " + bPath}\n   depth ${(agg[k].d / used).toFixed(2)}, nodes ${Math.round(agg[k].n / used / 1000)}k, matches reference ${agg[k].hit}/${used}`);
})().catch((e) => { console.error(e); process.exit(1); });
