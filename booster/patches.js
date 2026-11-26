// Runtime patch for the game's own canonicalAiWorker script.
// No game code ships with this extension: the worker the site serves is
// fetched as usual and only these text insertions/replacements are applied.
// If any anchor is missing or appears twice (the game was updated), the
// patch is refused and the original worker runs unchanged.
//
// The fast engine (fast-engine.js) and its adapter (fast-adapter.js) are
// injected into the worker scope. Before the game's own search, the fast
// engine searches the board deeply among the game's legal moves; its move is
// used unless the game's search found an immediate win (incl. special
// victories) or chose a card. The game's own safety check still runs last.
(function (root) {
  "use strict";

  // The game abandons the worker after 10 s (AI_DEFAULT_FAILSAFE_MS). Its own
  // stages end at fixed times measured from its timer start: the search by
  // timeLimitMs (3.5 s), the safety check by safetyTimeLimitMs/dangerTimeLimitMs
  // (6.5 / 8.5 s, only in dangerous positions). The fast engine runs INSIDE
  // that window (after the timer starts), so the whole answer still ends by
  // ~8.5 s; when it runs longer than the search stage, the game's own search
  // simply gets no time and its safety check keeps whatever is left.
  const LEVELS = Object.freeze({
    boost: { timeMul: 1, nodeMul: 4, minNodes: 2048, cardMul: 1.5, minDepth: 3, maxDepth: 8, qNodes: 48, partial: true, fast: true, fastMs: 4500, fastShare: 1.3, cardProbes: 24 },
    max: { timeMul: 1, nodeMul: 8, minNodes: 6000, cardMul: 2, minDepth: 3, maxDepth: 8, qNodes: 64, partial: true, fast: true, fastMs: 7500, fastShare: 2.2, cardProbes: 40 },
    // deep: like max, plus extraMs for the new engine. The page script
    // (inject.js) lengthens the game's worker timer by the same amount and
    // marks the request with acbExtraMs; without that mark nothing changes.
    deep: { timeMul: 1, nodeMul: 8, minNodes: 6000, cardMul: 2, minDepth: 3, maxDepth: 8, qNodes: 64, partial: true, fast: true, fastMs: 7500, fastShare: 2.2, cardProbes: 64, extraMs: 5000 },
    // auto: like deep, but the page sets each move's time from the clock
    // (acbExtraMs up to 25 s on top of 7.5 s) and a soft limit (acbSoft):
    // the search stops early when the next depth would not finish or the
    // best move is settled, so easy moves save clock for hard ones.
    auto: { timeMul: 1, nodeMul: 8, minNodes: 6000, cardMul: 2, minDepth: 3, maxDepth: 8, qNodes: 64, partial: true, fast: true, fastMs: 7500, fastShare: 2.2, cardProbes: 64, extraMs: 25000, auto: true }
  });

  const PATCHES = [
    [
      "thinking-time",
      "const totalMs = Math.max(1, data.timeLimitMs ?? 2e3);",
      "const totalMs = Math.max(1, (data.timeLimitMs ?? 2e3) * __ACB.timeMul);"
    ],
    [
      "search-depth",
      "      depth: data.depth,",
      "      depth: Math.max(data.depth ?? 2, __ACB.minDepth),"
    ],
    [
      "node-budget",
      "      maxNodes: data.maxNodes,",
      "      maxNodes: Math.max((data.maxNodes ?? 256) * __ACB.nodeMul, __ACB.minNodes),"
    ],
    [
      "card-probes",
      "      maxCardProbes: data.maxCardProbes,",
      "      maxCardProbes: Math.round((data.maxCardProbes ?? 128) * __ACB.cardMul),"
    ],
    [
      // Capture/recapture check at each leaf was limited to 4 nodes.
      "quiescence-nodes",
      "{ left: 4 }",
      "{ left: __ACB.qNodes }"
    ],
    [
      "depth-cap",
      "Math.min(6, Math.trunc(depth) || 1)",
      "Math.min(__ACB.maxDepth, Math.trunc(depth) || 1)"
    ],
    [
      // Track which root moves finished at the current depth.
      "layer-tracking",
      "      let best = null, value2 = -Infinity, finished = !root.truncated, layerPreferredScore;",
      "      let best = null, value2 = -Infinity, finished = !root.truncated, layerPreferredScore;\n      const __acbDone = new Set();"
    ],
    [
      "layer-tracking-mark",
      "        ranks.set(candidate, rankedScore);",
      "        ranks.set(candidate, rankedScore);\n        __acbDone.add(candidate);"
    ],
    [
      // When time runs out mid-depth, keep a deeper result if the previous
      // best move was re-searched at this depth and another move beat it.
      "keep-partial-depth",
      "        if (completedDepth === 0 && best) {",
      "        if (best && (completedDepth === 0 || __ACB.partial && __acbDone.has(selected2) && best !== selected2)) {"
    ],
    [
      // Fast engine + adapter live inside the worker scope.
      "fast-inject",
      '  registerAiSearchWorker("canonical", runCanonicalAiSearch);',
      // Also answers draft probes from the page (inject.js): "what would each
      // offered card be worth if the AI held it now?"
      (src) => `  const __acbFastAdapter = (${src.adapter})((${src.engine})());
  self.addEventListener("message", async (event) => {
    const d = event.data;
    if (d?.type === "acb-opp-list") {
      // helper copy: the opponent's moves for the main AI worker
      let result;
      try { result = await __acbFastAdapter.oppHelperTask(await prepareCanonicalAiSearchSnapshot(d.snapshot), d.color); }
      catch (error) { result = { ok: false, reason: String(error?.message || error) }; }
      self.postMessage({ type: "acb-opp-list-result", id: d.id, result });
      return;
    }
    if (d?.type === "acb-draft-playout") {
      let result;
      try { result = await __acbFastAdapter.draftPlayoutOne(await prepareCanonicalAiSearchSnapshot(d.snapshot), d.actor, d.choiceId, { plies: d.plies, perMs: d.perMs, deadline: performance.now() + d.budgetMs }); }
      catch (error) { result = { ok: false, reason: String(error?.message || error) }; }
      self.postMessage({ type: "acb-draft-playout-result", id: d.id, result });
      return;
    }
    if (d?.type !== "acb-draft-probe") return;
    let result;
    try {
      const snap = await prepareCanonicalAiSearchSnapshot(d.snapshot);
      result = await __acbFastAdapter.draftProbe(snap, d.actor, d.cardIds, { perMs: d.perMs, deadline: performance.now() + d.budgetMs });
    } catch (error) {
      result = { ok: false, reason: String(error?.message || error) };
    }
    self.postMessage({ type: "acb-draft-probe-result", id: d.id, result });
  });
  registerAiSearchWorker("canonical", runCanonicalAiSearch);`
    ],
    [
      // Fast search first, but inside the game's own time budget so the whole
      // answer still arrives before the game's 10 s failsafe.
      "fast-run",
      "    data = { ...data, snapshot: await prepareCanonicalAiSearchSnapshot(data.snapshot) };\n    const started = now();",
      `    data = { ...data, snapshot: await prepareCanonicalAiSearchSnapshot(data.snapshot) };
    const started = now();
    let __acbFast = null, __acbFastUsed = false;
    if (__ACB.fast) {
      try {
        const __acbExtra = Math.max(0, Math.min(__ACB.extraMs ?? 0, Number(data.acbExtraMs) || 0));
        // A watchdog clipped by the clock shows in the danger limit (timeoutMs - 250):
        // then the whole move must fit inside it.
        const __acbClipped = Number.isFinite(data.dangerTimeLimitMs) && data.dangerTimeLimitMs < (data.timeLimitMs ?? 3500) + 5e3;
        const __acbMs = Math.min(__acbClipped ? Math.max(150, data.dangerTimeLimitMs - 1200) : Infinity, Math.min(__ACB.fastMs, Math.max(150, (data.timeLimitMs ?? 2e3) * __ACB.fastShare)) + __acbExtra);
        __acbFast = await __acbFastAdapter.pick(data.snapshot, { timeMs: __acbMs, includeCards: true, maxCardProbes: __ACB.cardProbes, softFrac: __ACB.auto && Number(data.acbSoft) > 0 ? Number(data.acbSoft) : null });
      } catch (error) {
        __acbFast = { ok: false, reason: String(error?.message || error) };
      }
    }`
    ],
    [
      // Use the fast engine's choice (move or card) unless the game found an
      // immediate win (special victories included), or the game chose an
      // action the fast engine did not get to evaluate.
      "fast-choose",
      "    const preferred = result2.preferredOutcome;",
      `    const __acbOrigKey = JSON.stringify(result2.candidate?.intent ?? null);
    const __acbKnowsOrig = !result2.candidate || result2.candidate.intent?.kind === "piece_move" || (__acbFast?.evaluated ?? []).includes(__acbOrigKey);
    const __acbAllLost = __acbFast?.ok && __acbFast.score <= -999000 && result2.candidate;
    if (__acbFast?.ok && __acbFast.candidate && !result2.terminalWin && !__acbAllLost && (__acbKnowsOrig || __acbFast.score > 900000)) {
      result2 = { ...result2, candidate: __acbFast.candidate, plannedContinuation: void 0 };
      __acbFastUsed = true;
    }
    const preferred = result2.preferredOutcome;`
    ],
    [
      "fast-report",
      '      algorithm: "shared-policy-4",',
      `      algorithm: "shared-policy-4",
      acbFast: __acbFast ? { ok: __acbFast.ok, used: __acbFastUsed, choice: __acbFast.choice, chosenCard: __acbFast.chosenCard ?? null, depth: __acbFast.depth, nodes: __acbFast.nodes, ms: __acbFast.ms, score: __acbFast.score, baseScore: __acbFast.baseScore, cards: __acbFast.cards, cardsAvailable: __acbFast.cardsAvailable, reason: __acbFast.reason, move: __acbFast.candidate?.intent?.payload ?? null, learned: __acbFast.learnedKinds, topMoves: __acbFast.topMoves, counters: __acbFast.counters, ruleError: __acbFast.ruleError ?? null } : null,`
    ]
  ];

  function fastSources() {
    const engine = root.acbFastEngineModule, adapter = root.acbFastAdapterModule;
    if (typeof engine !== "function" || typeof adapter !== "function") return null;
    return { engine: engine.toString(), adapter: adapter.toString() };
  }

  function patchWorker(text, level, sources = fastSources()) {
    const cfg = LEVELS[level];
    if (!cfg) return { ok: false, error: `unknown level: ${level}` };
    if (!sources) return { ok: false, error: "fast engine sources not loaded" };
    let out = text;
    // speed patches first (optional: missing anchors are skipped)
    let speed = { applied: [], skipped: [] };
    if (cfg.speed !== false && root.__acbSpeedPatches) {
      speed = root.__acbSpeedPatches.applySpeedPatches(out);
      out = speed.code;
    }
    for (const [name, find, replacement] of PATCHES) {
      const first = out.indexOf(find);
      if (first < 0) return { ok: false, error: `patch "${name}": anchor missing (game updated?)` };
      if (out.indexOf(find, first + find.length) >= 0) return { ok: false, error: `patch "${name}": anchor not unique` };
      const rep = typeof replacement === "function" ? replacement(sources) : replacement;
      out = out.slice(0, first) + rep + out.slice(first + find.length);
    }
    return { ok: true, code: `const __ACB = Object.freeze(${JSON.stringify(cfg)});\n${out}`, speedApplied: speed.applied, speedSkipped: speed.skipped };
  }

  const api = { LEVELS, PATCHES, patchWorker };
  if (typeof module !== "undefined" && module.exports) {
    // Node tools: load the engine sources from the files next to this one.
    const path = require("path");
    root.acbFastEngineModule ??= require(path.join(__dirname, "fast-engine.js"));
    root.acbFastAdapterModule ??= require(path.join(__dirname, "fast-adapter.js"));
    root.__acbSpeedPatches ??= require(path.join(__dirname, "speed-patches.js"));
    module.exports = api;
  } else {
    root.__acbPatchWorker = patchWorker;
    root.__acbLevelExtraMs = (level) => LEVELS[level]?.extraMs ?? 0;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
