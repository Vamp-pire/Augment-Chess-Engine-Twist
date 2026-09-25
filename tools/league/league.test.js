// Synthetic-data test of league.js. Run: node tools/league/league.test.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const S = require("./stats.js");
const L = require("./league.js");

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(777);
function game(E, d) { const dd = Math.min(d, 2 * Math.min(E, 1 - E)), u = rand(); return u < E - dd / 2 ? 1 : u < E + dd / 2 ? 0.5 : 0; }
function match(eloA, eloB, pairs, d) { // synthetic pair histogram and W/D/L for A vs B
  const hist = [0, 0, 0, 0, 0]; let w = 0, dr = 0, l = 0;
  for (let i = 0; i < pairs; i += 1) {
    const g1 = game(S.scoreFromElo(eloA - eloB), d), g2 = game(S.scoreFromElo(eloA - eloB), d);
    hist[Math.round((g1 + g2) * 2)] += 1;
    for (const g of [g1, g2]) { if (g === 1) w += 1; else if (g === 0) l += 1; else dr += 1; }
  }
  return { hist, w, dr, l };
}
function result(a, b, m, extra) {
  return Object.assign({ modelA: a, modelB: b, participantA: a, participantB: b, wins: m.w, draws: m.dr, losses: m.l, pairs: m.hist.reduce((x, y) => x + y, 0), pairHistogram: m.hist, settings: { handicap: 0 } }, extra || {});
}

const truth = { "handcoded/d3": 0, "handcoded/d2": -90, "handcoded/d4": 70, "data:models/x.json/d3": 25, "data:models/y.json/d3": -30 };
const names = Object.keys(truth);

// 1) parameter recovery + CI coverage over repeated synthetic leagues (each pairing played in 2 runs, mixed orientation)
const R = 300; let inside = 0, total = 0, sumSq = 0;
for (let rep = 0; rep < R; rep += 1) {
  const results = [];
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) {
    for (let run = 0; run < 2; run += 1) {
      const [a, b] = run ? [names[j], names[i]] : [names[i], names[j]];
      results.push({ a, b, hist: match(truth[a], truth[b], 40, 0.45).hist, wins: 0, draws: 0, losses: 0 });
    }
  }
  const fitted = L.fit(L.aggregate(results), "handcoded/d3", 0);
  assert.strictEqual(fitted.ratings.length, names.length);
  for (const r of fitted.ratings) {
    if (r.anchor) continue;
    total += 1; sumSq += (r.elo - truth[r.name]) ** 2;
    if (r.ci95[0] <= truth[r.name] && truth[r.name] <= r.ci95[1]) inside += 1;
  }
}
const cover = inside / total, rmse = Math.sqrt(sumSq / total);
console.log(`synthetic league (${names.length} players, 10 pairings x 2 runs x 40 pairs, ${R} reps): rating RMSE ${rmse.toFixed(1)} Elo, 95% CI coverage ${(100 * cover).toFixed(1)}%`);
assert(cover > 0.92 && cover < 0.985, "league CI coverage " + cover);
assert(rmse < 25, "rmse " + rmse);

// 2) files on disk -> CLI, orientation pooling, unlinked participants, handicap filter, legacy files skipped
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "league-"));
let n = 0;
const put = (obj) => { fs.mkdirSync(path.join(dir, "run" + n), { recursive: true }); fs.writeFileSync(path.join(dir, "run" + n++, "match-result.json"), JSON.stringify(obj)); };
for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) put(result(names[i], names[j], match(truth[names[i]], truth[names[j]], 200, 0.45)));
put(result("island/d3", "island2/d3", match(0, 50, 50, 0.45)));
put(result("handcoded/d3", "handcoded/d2", match(0, -90, 50, 0.45), { settings: { handicap: 2 } }));
fs.writeFileSync(path.join(dir, "verdict.json"), JSON.stringify({ modelA: "x", aWins: 1 }));
const out = execFileSync(process.execPath, [path.join(__dirname, "league.js"), dir, "--json", path.join(dir, "out.json")], { encoding: "utf8" });
console.log(out);
const json = JSON.parse(fs.readFileSync(path.join(dir, "out.json"), "utf8"));
assert.strictEqual(json.anchor, "handcoded/d3");
assert.deepStrictEqual(json.unlinked.slice().sort(), ["island/d3", "island2/d3"]);
for (const r of json.ratings) assert(Math.abs(r.elo - truth[r.name]) < 3 * (r.se || 1) + 1, `${r.name}: ${r.elo} vs ${truth[r.name]}`);
assert(json.ratings[0].name === "handcoded/d4", "top rating is depth 4");
assert(json.ratings.find((r) => r.name === "handcoded/d3").elo === 0);
fs.rmSync(dir, { recursive: true, force: true });
console.log("league tests ok");
