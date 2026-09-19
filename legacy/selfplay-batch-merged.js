// Runs a small self-play smoke batch against engine-merged.js via
// selfplay-worker-merged.js (worker_threads), per the task's verification
// step. Zero exceptions expected.
const path = require("path");
const { Worker } = require("worker_threads");

const GAME_COUNT = Number(process.argv[2]) || 8;
const workerPath = path.join(__dirname, "selfplay-worker-merged.js");

function runOneGame(seed) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        searchDepth: 3,
        searchTimeMs: 200,
        maxPlies: 60,
        seed,
        flexibleBudget: true
      }
    });
    let settled = false;
    worker.on("message", (msg) => {
      settled = true;
      resolve(msg);
    });
    worker.on("error", (err) => {
      if (!settled) reject(err);
    });
    worker.on("exit", (code) => {
      if (!settled) reject(new Error(`worker exited with code ${code} before posting a result`));
    });
  });
}

(async () => {
  let failures = 0;
  for (let i = 0; i < GAME_COUNT; i++) {
    const seed = 1000 + i;
    try {
      const result = await runOneGame(seed);
      console.log(
        `game ${i} (seed ${seed}): outcome=${result.outcome} plies=${result.plies} ms=${result.ms}`
      );
    } catch (e) {
      failures += 1;
      console.log(`game ${i} (seed ${seed}) FAILED:`, e.stack || e.message || e);
    }
  }
  console.log(failures === 0 ? `\nALL ${GAME_COUNT} GAMES COMPLETED, ZERO EXCEPTIONS` : `\n${failures} GAME(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
