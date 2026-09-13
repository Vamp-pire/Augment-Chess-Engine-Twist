import("./site-engine.mjs").then((mod) => {
  const { state, pawnMoves, canCaptureTarget } = mod;
  console.log("turn:", state.turn);
  console.log("pawnMoves(6,4,white):", JSON.stringify(pawnMoves(6, 4, "white")));
  process.exit(0);
}).catch((e) => {
  console.error("ORACLE ERROR", e);
  process.exit(1);
});
setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 15000);
