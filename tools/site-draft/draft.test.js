// Plain-node tests for tools/site-draft/draft.js. Run: node tools/site-draft/draft.test.js
// Optional: --quiet.
"use strict";
process.env.SELFPLAY_SITE_DRAFT = "mix"; // for the worker-level checks at the bottom (module reads it at load)
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const draftLib = require("./draft.js");
const { createDrafter, DATA } = draftLib;
const worker = require("../../selfplay-worker-merged.js");
const { makeRng } = worker;

let passed = 0;
const notes = [];
function check(name, fn) {
  try { fn(); passed++; if (!process.argv.includes("--quiet")) console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name + "\n     " + (e && e.message)); process.exitCode = 1; }
}

const drafter = createDrafter({ enginePool: worker.SELFPLAY_CARD_POOL });
const cat = (id) => DATA.cards.find((c) => c.id === id).category;
const dealMany = (mode, n, seed0 = 1, d = drafter) => Array.from({ length: n }, (_, i) => d.deal(makeRng(seed0 + i * 7919), mode));
function hasExcl(ids) {
  const s = new Set(ids);
  for (const g of DATA.mutuallyExclusiveGroups) if (g.filter((x) => s.has(x)).length > 1) return g;
  for (const [a, b] of DATA.pawnDirectionConflicts) if (s.has(a) && s.has(b)) return [a, b];
  return null;
}

// ---- sizes ----
check("normal decks are 3 + 3 cards", () => { for (const r of dealMany("normal", 2000)) { assert.strictEqual(r.decks.white.length, 3); assert.strictEqual(r.decks.black.length, 3); } });
check("chaos decks are 6 + 6 cards", () => { for (const r of dealMany("chaos", 2000)) { assert.strictEqual(r.decks.white.length, 6); assert.strictEqual(r.decks.black.length, 6); } });
check("grand decks are 6 + 6 cards", () => { for (const r of dealMany("grand", 2000)) { assert.strictEqual(r.decks.white.length, 6); assert.strictEqual(r.decks.black.length, 6); } });

// ---- duplicates / exclusions ----
for (const mode of ["normal", "chaos", "grand"]) {
  check(mode + ": no duplicate cards (within a hand, and across the two hands)", () => {
    for (const r of dealMany(mode, 2000, 5)) {
      const all = [...r.decks.white, ...r.decks.black];
      assert.strictEqual(new Set(all).size, all.length, JSON.stringify(r.decks));
    }
  });
  check(mode + ": mutual exclusion respected (" + (mode === "grand" ? "per player's own hand" : "across both hands, like the site's selectedCardIds") + ")", () => {
    for (const r of dealMany(mode, 3000, 9)) {
      const sets = mode === "grand" ? [r.decks.white, r.decks.black] : [[...r.decks.white, ...r.decks.black]];
      for (const ids of sets) { const bad = hasExcl(ids); assert.ok(!bad, "exclusive pair " + bad + " in " + JSON.stringify(r.decks)); }
    }
  });
  check(mode + ": never drafts RULE / GUN / shotgun-king / deleted / engine-unsupported cards", () => {
    const ok = new Set(drafter.universe.cards.map((c) => c.id));
    for (const r of dealMany(mode, 1000, 13)) for (const id of [...r.decks.white, ...r.decks.black]) assert.ok(ok.has(id), id);
    assert.ok(!ok.has("shotgun-king"));
    for (const c of DATA.cards) if (c.isRule) assert.ok(!ok.has(c.id));
  });
}
check("grand: at most ONE exclusive-opening card (big-rook/london-system/horde) per player", () => {
  const ex = new Set(DATA.exclusiveOpeningIds);
  for (const r of dealMany("grand", 4000, 21)) for (const color of ["white", "black"]) assert.ok(r.decks[color].filter((x) => ex.has(x)).length <= 1);
});
check("active rule blocks: monochrome-chess bans horse-riding/horde, macho-chess bans reverse-pawns (forced rule)", () => {
  // ruleProb=1 with a drafter restricted to a single rule at a time
  for (const [rule, banned] of [["monochrome-chess", ["horse-riding", "horde"]], ["macho-chess", ["reverse-pawns"]]]) {
    const d = createDrafter({ enginePool: worker.SELFPLAY_CARD_POOL, ruleProb: { normal: 1, chaos: 1, grand: 1 }, engineRuleIds: [rule] });
    for (const mode of ["normal", "chaos", "grand"]) for (const r of dealMany(mode, 1500, 33, d)) {
      assert.strictEqual(r.ruleId, rule);
      for (const id of [...r.decks.white, ...r.decks.black]) assert.ok(!banned.includes(id), rule + " must exclude " + id);
    }
  }
});

// ---- normal/chaos offer structure ----
check("normal: every offer shows 3 cards with the site's category plan; deck = the 1 pick per phase", () => {
  for (const r of dealMany("normal", 1500, 41)) {
    assert.strictEqual(r.offers.length, 6);
    for (const o of r.offers) {
      assert.strictEqual(o.choices.length, 3);
      assert.strictEqual(o.taken.length, 1);
      assert.ok(o.choices.includes(o.taken[0]));
      const cats = o.choices.map(cat);
      if (o.phase === "OPENING") assert.ok(cats.every((c) => ["OPENING", "MIDDLE", "PIECE"].includes(c)));
      if (o.phase === "MIDDLE") { assert.strictEqual(cats.filter((c) => c === "PIECE").length, 1); assert.strictEqual(cats.filter((c) => c === "MIDDLE").length, 2); }
      if (o.phase === "END") assert.ok(cats.every((c) => ["MIDDLE", "END"].includes(c)));
    }
    const wt = r.offers.filter((o) => o.color === "white").map((o) => o.taken[0]);
    assert.deepStrictEqual(wt, r.decks.white);
  }
});
check("chaos: every offer is 3 bundles of 2; one bundle (2 cards) taken per phase; 3 phases -> 6 cards", () => {
  for (const r of dealMany("chaos", 2500, 51)) {
    assert.strictEqual(r.offers.length, 6);
    for (const o of r.offers) {
      assert.strictEqual(o.choices.length, 6);
      assert.strictEqual(o.bundles.length, 3);
      for (const b of o.bundles) {
        assert.strictEqual(b.length, 2);
        assert.ok(!(cat(b[0]) === "OPENING" && cat(b[1]) === "OPENING"), "two OPENING cards in one bundle: " + b);
        assert.ok(!(b.includes("democracy") && b.includes("queens-gambit")), "forbidden bundle pair: " + b);
      }
      assert.ok(o.bundles.some((b) => b[0] === o.taken[0] && b[1] === o.taken[1]));
      assert.strictEqual(o.taken.length, 2);
    }
  }
});

// ---- grand ----
check("grand: 28-card site pool (4/10/7/7), black picks first and colors strictly alternate, 12 picks", () => {
  for (const r of dealMany("grand", 1500, 61)) {
    assert.strictEqual(r.pool.length, 28);
    const bycat = {}; for (const id of r.pool) bycat[cat(id)] = (bycat[cat(id)] || 0) + 1;
    assert.deepStrictEqual(bycat, { OPENING: 4, MIDDLE: 10, PIECE: 7, END: 7 }, JSON.stringify(bycat));
    assert.strictEqual(new Set(r.pool).size, 28);
    assert.strictEqual(r.picks.length, 12);
    r.picks.forEach((p, i) => { assert.strictEqual(p.order, i + 1); assert.strictEqual(p.color, i % 2 === 0 ? "black" : "white"); assert.ok(r.pool.includes(p.cardId)); });
    assert.strictEqual(r.picks[0].color, "black");
    assert.strictEqual(new Set(r.picks.map((p) => p.cardId)).size, 12);
  }
});
check("grand: SELFPLAY_GRAND_POOL=24 gives a 24-card pool (owner's number), same pick rules", () => {
  const d24 = createDrafter({ enginePool: worker.SELFPLAY_CARD_POOL, grandPool: "24" });
  const sizes = d24.grandSizes;
  assert.strictEqual(Object.values(sizes).reduce((a, b) => a + b, 0), 24);
  for (const r of dealMany("grand", 800, 71, d24)) { assert.strictEqual(r.pool.length, 24); assert.strictEqual(r.picks.length, 12); assert.strictEqual(r.picks[0].color, "black"); }
  notes.push("grand pool 24 category split: " + JSON.stringify(sizes));
});
check("grand: pool has no cards that conflict at pool level (democracy/queens-gambit, london/big-rook, big-rook/big-bishop)", () => {
  for (const r of dealMany("grand", 3000, 81)) {
    const s = new Set(r.pool);
    for (const [a, b] of DATA.grandPoolConflicts) assert.ok(!(s.has(a) && s.has(b)), a + "+" + b);
    assert.ok(!hasExcl(r.pool), "pool contains an exclusive pair " + hasExcl(r.pool));
  }
});

// ---- probabilities ----
const N_RULE = 20000;
const measured = {};
for (const [mode, p] of [["normal", 0.4], ["chaos", 0.4], ["grand", 0.2]]) {
  check("rule-card probability " + mode + " ~ " + p + " over " + N_RULE + " draws", () => {
    let hit = 0;
    const d = createDrafter({ enginePool: worker.SELFPLAY_CARD_POOL });
    for (let i = 0; i < N_RULE; i++) if (d.deal(makeRng(1000003 + i * 31 + (mode === "chaos" ? 15485863 : mode === "grand" ? 32452843 : 0)), mode).ruleId) hit++;
    const ph = hit / N_RULE;
    measured[mode] = ph;
    const tol = 4 * Math.sqrt(p * (1 - p) / N_RULE);
    assert.ok(Math.abs(ph - p) < tol, mode + " measured " + ph + " expected " + p + " +-" + tol);
  });
}
check("rule cards are uniform over the engine-implemented rules (forced rule, 20000 draws, chi-square)", () => {
  const d = createDrafter({ enginePool: worker.SELFPLAY_CARD_POOL, ruleProb: { normal: 1, chaos: 1, grand: 1 } });
  const cnt = new Map(); const k = d.rules.usable.length;
  for (let i = 0; i < N_RULE; i++) { const r = d.deal(makeRng(7 + i * 17), "normal").ruleId; cnt.set(r, (cnt.get(r) || 0) + 1); }
  assert.strictEqual(cnt.size, k);
  const exp = N_RULE / k; let chi = 0; for (const v of cnt.values()) chi += (v - exp) ** 2 / exp;
  const df = k - 1; const limit = df + 5 * Math.sqrt(2 * df);
  measured.ruleChi = { chi, df, limit };
  assert.ok(chi < limit, `chi2 ${chi} >= ${limit}`);
  for (const r of drafter.rules.dropped) assert.ok(!cnt.has(r));
});
function chiUniform(counts, total) {
  const k = counts.length; const exp = total / k; let chi = 0; for (const v of counts) chi += (v - exp) ** 2 / exp;
  const df = k - 1; return { chi, df, limit: df + 5 * Math.sqrt(2 * df), maxDev: Math.max(...counts.map((v) => Math.abs(v - exp) / exp)) };
}
check("equal weights: a single-card draw from OPENING+MIDDLE+PIECE is uniform per card (chi-square)", () => {
  const cats = ["OPENING", "MIDDLE", "PIECE"]; const pool = cats.flatMap((c) => drafter.byCat[c]);
  const cnt = new Map(pool.map((c) => [c.id, 0])); const n = pool.length * 400; const rng = makeRng(99);
  for (let i = 0; i < n; i++) { const [c] = drafter.drawPhase("OPENING", 1, new Set(), new Set(), rng); cnt.set(c.id, cnt.get(c.id) + 1); }
  const r = chiUniform([...cnt.values()], n); measured.uniformOpening = { cards: pool.length, ...r };
  assert.ok(r.chi < r.limit, JSON.stringify(r));
});
check("equal weights: single-card END draw (MIDDLE+END) and picks from a 3-card offer are uniform", () => {
  const pool = [...drafter.byCat.MIDDLE, ...drafter.byCat.END];
  const cnt = new Map(pool.map((c) => [c.id, 0])); const n = pool.length * 400; const rng = makeRng(123);
  for (let i = 0; i < n; i++) { const [c] = drafter.drawPhase("END", 1, new Set(), new Set(), rng); cnt.set(c.id, cnt.get(c.id) + 1); }
  const r = chiUniform([...cnt.values()], n); measured.uniformEnd = { cards: pool.length, ...r };
  assert.ok(r.chi < r.limit, JSON.stringify(r));
  // taken index within a 3-card normal offer is uniform
  const idx = [0, 0, 0]; let m = 0;
  for (const d of dealMany("normal", 6000, 555)) for (const o of d.offers) { idx[o.choices.indexOf(o.taken[0])]++; m++; }
  const r2 = chiUniform(idx, m); measured.pickIndex = { counts: idx, ...r2 };
  assert.ok(r2.chi < r2.limit, JSON.stringify(r2));
});
check("no star weighting: high-star and low-star cards are drawn equally often", () => {
  const cat2 = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "site-rules", "card-catalog.json"), "utf8"));
  const pool = [...drafter.byCat.OPENING, ...drafter.byCat.MIDDLE, ...drafter.byCat.PIECE].filter((c) => cat2[c.effect]);
  const hi = pool.filter((c) => cat2[c.effect].stars >= 4).map((c) => c.id); const lo = pool.filter((c) => cat2[c.effect].stars <= 2).map((c) => c.id);
  assert.ok(hi.length > 3 && lo.length > 3);
  const cnt = new Map(); const rng = makeRng(2024); const n = 60000;
  for (let i = 0; i < n; i++) { const [c] = drafter.drawPhase("OPENING", 1, new Set(), new Set(), rng); cnt.set(c.id, (cnt.get(c.id) || 0) + 1); }
  const avg = (ids) => ids.reduce((a, id) => a + (cnt.get(id) || 0), 0) / ids.length;
  const ratio = avg(hi) / avg(lo); measured.hiLoRatio = ratio;
  assert.ok(Math.abs(ratio - 1) < 0.1, "hi/lo star frequency ratio " + ratio);
});

// ---- determinism / pairing / data parity ----
check("same rng seed -> same deal (all modes)", () => {
  for (const mode of ["normal", "chaos", "grand"]) for (const s of [1, 2, 3, 4242]) assert.deepStrictEqual(drafter.deal(makeRng(s), mode), drafter.deal(makeRng(s), mode));
});
check("worker: makeInitialState (SELFPLAY_SITE_DRAFT=mix) is identical for the same seed -> colour-swapped match pairs share decks + rule", () => {
  const sig = (seed) => { const st = worker.makeInitialState(makeRng(seed)); return JSON.stringify({ d: st.deckSlots, b: st.board, i: st.siteDraftInfo, r: st.additionalRuleCards || null }); };
  const modes = new Set();
  for (let i = 0; i < 60; i++) { const seed = 1000000 + i * 7919; assert.strictEqual(sig(seed), sig(seed)); modes.add(worker.makeInitialState(makeRng(seed)).siteDraftInfo.mode); }
  assert.strictEqual(modes.size, 3, "mix should hit all three modes: " + [...modes]);
});
check("worker: deckSlots hold engine effects from SELFPLAY_CARD_POOL only, sizes 3/6", () => {
  const pool = new Set(worker.SELFPLAY_CARD_POOL);
  for (let i = 0; i < 200; i++) { const st = worker.makeInitialState(makeRng(50 + i)); const m = st.siteDraftInfo.mode; for (const c of ["white", "black"]) { assert.strictEqual(st.deckSlots[c].length, m === "normal" ? 3 : 6); for (const card of st.deckSlots[c]) assert.ok(pool.has(card.effect)); } }
});
check("draft-data.json engine rule list matches engine-merged.js WORKER_RULE_TICKET_CANDIDATES", () => {
  const eng = fs.readFileSync(path.join(__dirname, "..", "..", "engine-merged.js"), "utf8");
  const em = /const WORKER_RULE_TICKET_CANDIDATES = \[([\s\S]*?)\n  \];/.exec(eng);
  const ids = [...em[1].matchAll(/\{ id: "([a-z0-9-]+)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(ids, DATA.engineRuleCandidates.map((r) => r.id));
});
check("draft-data.json provenance hash matches the bundle on disk (re-run extract-draft-data.js if this fails)", () => {
  const p = path.join(__dirname, "..", "..", "site-oracle", DATA.provenance.bundleFile);
  if (!fs.existsSync(p)) { notes.push("bundle not on disk; provenance hash not re-checked"); return; }
  assert.strictEqual(require("crypto").createHash("sha256").update(fs.readFileSync(p)).digest("hex"), DATA.provenance.bundleSha256);
});

console.log("\n" + passed + " checks passed" + (process.exitCode ? ", SOME FAILED" : ""));
console.log("measured:", JSON.stringify(measured));
for (const n of notes) console.log("note:", n);
