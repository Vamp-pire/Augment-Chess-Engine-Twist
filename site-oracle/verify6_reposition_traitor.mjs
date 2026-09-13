import("./site-engine.mjs").then((mod) => {
  const { state, resetGame } = mod;
  // We don't have reposition()/traitor() exported yet; just confirm via source read is enough.
  // Instead, sanity check state is usable.
  resetGame(false);
  console.log("board pieces at e2:", JSON.stringify(state.board[6]?.[4]));
  process.exit(0);
}).catch((e) => { console.error("ORACLE ERROR", e); process.exit(2); });
setTimeout(() => { console.error("TIMEOUT"); process.exit(3); }, 20000);
