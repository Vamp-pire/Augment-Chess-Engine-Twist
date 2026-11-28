// Engine speed changes must not change what the engine plays: with a fixed
// node budget (no clock), the old and the new engine must return the same
// move, score, depth and node count on every corpus position. Also reports
// the speed (nodes per second) of each.
//
//   node tools/engine-equiv.cjs <worker.js> --old <old fast-engine.js> [--new fast-engine.js]
//        [--corpus ...jsonl.gz] [--n 40] [--nodes 60000] [--opts '{"kingSafety":true}']
"use strict";
const zlib = require("zlib"), fs = require("fs"), path = require("path");
const { loadGame } = require("./harness.cjs");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const oldPath = opt("old"), newPath = opt("new", path.join(__dirname, "..", "fast-engine.js"));
const corpus = opt("corpus", [path.join(__dirname, "..", "test-data", "corpus-2.jsonl.gz"), "D:/증강체스엔진/booster/test-data/corpus-2.jsonl.gz"].find((p) => fs.existsSync(p)));
const N = Number(opt("n", 40)), nodes = Number(opt("nodes", 60000)), extra = JSON.parse(opt("opts", "{}"));

(async () => {
  const { game } = loadGame(args[0]);
  const OLD = require(path.resolve(oldPath))(), NEW = require(path.resolve(newPath))();
  const lines = zlib.gunzipSync(fs.readFileSync(corpus)).toString().split("\n").filter(Boolean);
  const step = Math.max(1, Math.floor(lines.length / (N * 2)));
  let used = 0, diff = 0, tOld = 0, tNew = 0, nOld = 0, nNew = 0;
  const key = (r) => `${r.ok}|${r.move ? `${r.move.from}-${r.move.to}-${r.move.promo ?? ""}` : "-"}|${r.score}|${r.depth}|${r.nodes}`;
  for (let i = 0; i < lines.length && used < N; i += step) {
    let input;
    try {
      const snap = await game.prepareCanonicalAiSearchSnapshot(JSON.parse(lines[i]));
      if (snap.game.status !== "ACTIVE") continue;
      const b = await game.adapter.buildInput(snap);
      if (!b.ok || b.input.rootMoves.length < 2) continue;
      input = b.input;
    } catch { continue; }
    used++;
    const run = (E) => { const t = performance.now(); const r = E.search({ ...input, ...extra, timeMs: 600000, maxNodes: nodes, freshTT: true }); return [r, performance.now() - t]; };
    // alternate the order so neither side always gets the warm caches
    const [[ro, to], [rn, tn]] = used % 2 ? [run(OLD), run(NEW)] : [run(OLD), run(NEW)].reverse().reverse();
    tOld += to; tNew += tn; nOld += ro.nodes || 0; nNew += rn.nodes || 0;
    if (key(ro) !== key(rn)) { diff++; console.log(`\nDIFF line ${i}: old ${key(ro)} / new ${key(rn)}`); }
    process.stdout.write(`\r${used}/${N}`);
  }
  console.log(`\npositions ${used}, node budget ${nodes}: ${diff} differ`);
  console.log(`old ${Math.round(nOld / tOld)}k nodes/s, new ${Math.round(nNew / tNew)}k nodes/s (x${(nNew / tNew / (nOld / tOld)).toFixed(2)})`);
  process.exit(diff ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
