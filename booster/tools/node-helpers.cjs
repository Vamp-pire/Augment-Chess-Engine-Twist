// Node stand-in for the browser's helper workers (fast-adapter.js helper
// pool): each helper is a worker_threads thread that loads the same game
// worker code, engine and adapter, and answers "acb-task" messages.
//
//   const { installHelpers } = require("./node-helpers.cjs");
//   installHelpers({ workerPath, patchedCode, enginePath, adapterPath });
"use strict";
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const path = require("path");

if (!isMainThread && workerData?.acbHelper) {
  const { loadGame } = require("./harness.cjs");
  const { workerPath, patchedCode, enginePath, adapterPath } = workerData;
  const { game } = loadGame(workerPath, { patchedCode, enginePath, adapterPath });
  parentPort.on("message", async (d) => {
    if (d?.type !== "acb-task") return;
    let result = null;
    try { result = await game.adapter.helperTask(d.task); } catch (e) { result = null; }
    parentPort.postMessage({ type: "acb-task-result", id: d.id, result });
  });
}

const threads = [];
function installHelpers(opts) {
  globalThis.__acbMakeHelper = () => {
    const w = new Worker(__filename, { workerData: { acbHelper: true, ...opts } });
    w.unref();
    threads.push(w);
    return {
      addEventListener: (type, fn) => w.on(type === "message" ? "message" : "error", type === "message" ? (data) => fn({ data }) : fn),
      postMessage: (m) => w.postMessage(m)
    };
  };
}
function stopHelpers() { for (const w of threads.splice(0)) w.terminate(); }

module.exports = { installHelpers, stopHelpers };
