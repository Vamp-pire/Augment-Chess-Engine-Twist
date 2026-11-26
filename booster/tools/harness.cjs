// Loads the game's worker in Node with the fast engine and adapter injected
// into its scope, and exposes the pieces tools need.
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const engineModule = require(path.join(__dirname, "..", "fast-engine.js"));
const adapterModule = require(path.join(__dirname, "..", "fast-adapter.js"));

const ANCHOR = '  registerAiSearchWorker("canonical", runCanonicalAiSearch);';

function loadGame(workerPath, { patchedCode = null, adapterPath = null, enginePath = null } = {}) {
  const engineSrc = enginePath ? require(path.resolve(enginePath)).toString() : engineModule.toString();
  const adapterSrc = adapterPath ? require(path.resolve(adapterPath)).toString() : adapterModule.toString();
  let code = patchedCode ?? fs.readFileSync(workerPath, "utf8");
  const i = code.indexOf(ANCHOR);
  if (i < 0 || code.indexOf(ANCHOR, i + 1) >= 0) throw new Error("worker anchor missing");
  const expose = `  globalThis.__acbGame = {
    adapter: (${adapterSrc})((${engineSrc})()),
    CanonicalEditorSession, canonicalAiMoveCandidates, applyCanonicalAiCandidate,
    prepareCanonicalAiSearchSnapshot, projectCanonicalLocalSession, canonicalImmediateDefeat, canonicalAiActionCandidates,
    createGameConfiguration: typeof createGameConfiguration === "function" ? createGameConfiguration : null,
    cardDefinition: typeof betaPublicCardDefinitionV19 === "function" ? betaPublicCardDefinitionV19 : null
  };\n`;
  code = code.slice(0, i) + expose + code.slice(i);
  const listeners = [], posted = [];
  globalThis.self = {
    addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
    postMessage: (m) => posted.push(m)
  };
  vm.runInThisContext(code, { filename: "worker.js" });
  return { game: globalThis.__acbGame, listeners, posted };
}

function revive(text) {
  return JSON.parse(text, (key, v) => {
    if (!v || typeof v !== "object" || !("__acb" in v)) return v;
    switch (v.__acb) {
      case "Map": return new Map(v.v);
      case "Set": return new Set(v.v);
      case "Date": return new Date(v.v);
      case "undef": return undefined;
      case "num": return Number(v.v);
      default: return v;
    }
  });
}

module.exports = { loadGame, revive, engineModule, adapterModule };
