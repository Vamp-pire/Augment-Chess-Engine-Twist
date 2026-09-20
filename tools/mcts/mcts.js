// Experimental PUCT/MCTS search for the Augment Chess engine (track C1). Opt-in only:
// nothing in the default engine path uses this. Value = tanh(eval/400) from the mover's
// view; prior = softmax of the engine's actionOrderingScore. Random card outcomes are
// sampled once and treated as fixed (no chance nodes). Cards are free actions, so the
// same colour can move several times in a row: perspective always comes from state.turn.
const path = require("path");
const engine = require(path.join(__dirname, "..", "..", "engine-merged.js"));

const VALUE_SCALE = 400;
const clone = (a) => (typeof structuredClone === "function" ? structuredClone(a) : JSON.parse(JSON.stringify(a)));

function terminalValue(state) {
  // value from the perspective of state.turn
  if (!state.winner || state.winner === "draw") return 0;
  return state.winner === state.turn ? 1 : -1;
}

function createMctsSearch(options = {}) {
  const cfg = {
    sims: 200,
    cpuct: 1.5,
    priorTemp: 1.0,      // softmax over z-scored ordering scores; higher = flatter
    useBudget: false,    // if true, opts.budgetMs also caps the search (wall clock)
    evalFn: null,        // (state, color) => centipawn-like; default engine.evaluateState
    rootSafety: true,
    ...options
  };
  const evalFn = cfg.evalFn || engine.evaluateState;

  function makeNode(state) {
    return { state, turn: state.turn, terminal: state.mode === "gameover", expanded: false, actions: null, priors: null, children: null, N: null, n: 0, W: 0, value: 0 };
  }

  function computePriors(state, actions, color) {
    const s = actions.map((a) => { const v = engine.actionOrderingScore(a, state, color); return Number.isFinite(v) ? v : 0; });
    const mean = s.reduce((x, y) => x + y, 0) / s.length;
    const sd = Math.sqrt(s.reduce((x, y) => x + (y - mean) * (y - mean), 0) / s.length) || 1;
    const z = s.map((v) => (v - mean) / sd / cfg.priorTemp);
    const mx = Math.max(...z);
    const e = z.map((v) => Math.exp(v - mx));
    const sum = e.reduce((x, y) => x + y, 0);
    return e.map((v) => v / sum);
  }

  // Expand a node (generate actions, priors, static value). Returns value from node.turn's view.
  function expand(node) {
    node.expanded = true;
    if (node.terminal) { node.value = terminalValue(node.state); return node.value; }
    const color = node.turn;
    const actions = engine.generateActions(node.state, color);
    if (!actions.length) { node.terminal = true; node.value = -1; return -1; } // no legal action: loss
    node.actions = actions;
    node.children = new Array(actions.length).fill(null);
    node.N = new Float64Array(actions.length);
    node.priors = computePriors(node.state, actions, color);
    node.value = Math.tanh(evalFn(node.state, color) / VALUE_SCALE);
    return node.value;
  }

  // sign converting child.turn's value into parent.turn's perspective
  const sign = (parent, child) => (parent.turn === child.turn ? 1 : -1);

  function childOf(node, i) {
    if (node.children[i]) return node.children[i];
    const next = engine.cloneState(node.state);
    const applied = engine.applyAction(next, clone(node.actions[i]), node.turn);
    node.children[i] = applied && applied.ok ? makeNode(next) : { illegal: true };
    return node.children[i];
  }

  function qOf(node, i) {
    const c = node.children[i];
    if (!c || c.illegal || !c.n) return null;
    return sign(node, c) * (c.W / c.n);
  }

  function pick(node, allowed) {
    let total = 0;
    for (let i = 0; i < node.N.length; i += 1) total += node.N[i];
    const sq = Math.sqrt(total + 1);
    let best = -1, bestU = -Infinity;
    for (let i = 0; i < node.N.length; i += 1) {
      if (allowed && !allowed[i]) continue;
      const c = node.children[i];
      if (c && c.illegal) continue;
      const q = qOf(node, i);
      const u = (q === null ? node.value - 0.1 : q) + cfg.cpuct * node.priors[i] * sq / (1 + node.N[i]);
      if (u > bestU) { bestU = u; best = i; }
    }
    return best;
  }

  function simulate(root, allowedRoot) {
    const trail = [];
    let node = root;
    let value; // from node.turn's perspective
    for (;;) {
      if (!node.expanded) { value = expand(node); break; }
      if (node.terminal) { value = node.value; break; }
      const i = pick(node, node === root ? allowedRoot : null);
      if (i < 0) { value = node.value; break; }
      const child = childOf(node, i);
      if (child.illegal) continue; // now skipped by pick
      trail.push([node, i, child]);
      node = child;
    }
    node.W += value; node.n += 1;
    let v = value;
    for (let k = trail.length - 1; k >= 0; k -= 1) {
      const [parent, i, child] = trail[k];
      v = sign(parent, child) * v;
      parent.N[i] += 1;
      parent.W += v; parent.n += 1;
    }
  }

  function search(state, actions, color, opts = {}) {
    const t0 = Date.now();
    const acts = actions && actions.length ? actions : engine.generateActions(state, color);
    const empty = (a) => ({ action: a, score: 0, completedDepth: 0, nodes: 0, cutoffs: 0, candidates: [] });
    if (!acts.length) return empty(null);
    // apply every root action once (also feeds the safety check its afterState)
    const after = acts.map((a) => {
      const next = engine.cloneState(state);
      const ap = engine.applyAction(next, clone(a), color);
      return ap && ap.ok ? next : null;
    });
    const legal = acts.map((_, i) => i).filter((i) => after[i]);
    if (!legal.length) return empty(acts[0]);
    // decisive win: play it now
    for (const i of legal) {
      if (engine.actionDecisivelyWins(state, acts[i], color, after[i])) {
        return { action: acts[i], score: 1e6, completedDepth: 0, nodes: 1, cutoffs: 0, candidates: [{ action: acts[i], score: 1e6, visits: 0 }] };
      }
    }
    let safe = legal;
    if (cfg.rootSafety) {
      const ok = legal.filter((i) => !engine.rootCandidateAllowsImmediateDecisiveReply(after[i], color));
      if (ok.length) safe = ok;
    }
    if (safe.length === 1) {
      return { action: acts[safe[0]], score: 0, completedDepth: 0, nodes: 1, cutoffs: 0, candidates: [{ action: acts[safe[0]], score: 0, visits: 0 }] };
    }

    const root = makeNode(state);
    root.turn = color;
    root.expanded = true;
    root.actions = acts;
    root.children = after.map((s) => (s ? makeNode(s) : { illegal: true }));
    root.N = new Float64Array(acts.length);
    root.priors = computePriors(state, acts, color);
    root.value = Math.tanh(evalFn(state, color) / VALUE_SCALE);
    const allowed = new Array(acts.length).fill(false);
    for (const i of safe) allowed[i] = true;
    let ps = 0; for (const i of safe) ps += root.priors[i];
    for (let i = 0; i < acts.length; i += 1) root.priors[i] = allowed[i] ? root.priors[i] / ps : 0;

    const sims = Number(opts.sims) || cfg.sims;
    const budgetMs = cfg.useBudget ? Number(opts.budgetMs) || 0 : 0;
    let done = 0;
    while (done < sims) {
      if (budgetMs && done > 0 && Date.now() - t0 >= budgetMs) break;
      simulate(root, allowed);
      done += 1;
    }

    let bestI = safe[0];
    for (const i of safe) if (root.N[i] > root.N[bestI] || (root.N[i] === root.N[bestI] && root.priors[i] > root.priors[bestI])) bestI = i;
    const toScore = (q) => VALUE_SCALE * Math.atanh(Math.max(-0.999, Math.min(0.999, q)));
    const candidates = safe.map((i) => { const q = qOf(root, i); return { action: acts[i], score: toScore(q === null ? root.value : q), visits: root.N[i] }; });
    const qb = qOf(root, bestI);
    return { action: acts[bestI], score: toScore(qb === null ? root.value : qb), completedDepth: 0, nodes: done, cutoffs: 0, candidates, ms: Date.now() - t0 };
  }

  return { search, config: cfg };
}

module.exports = { createMctsSearch };
