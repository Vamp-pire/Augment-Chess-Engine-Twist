import("./site-engine.mjs").then((mod) => {
  const { canCaptureTarget, frontlineResponseBlocksCapture, primeMinisterHasDiagonalCapturePath, isEncouraged } = mod;

  function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    console.log((pass ? "PASS" : "FAIL") + "  " + name + "  actual=" + JSON.stringify(actual) + " expected=" + JSON.stringify(expected));
    return pass;
  }
  let fails = 0;

  // canCaptureTarget: monster attacker vs scarecrow target should be blocked
  if (!check("canCaptureTarget monster->scarecrow", canCaptureTarget("white", { color: "black", type: "scarecrow" }, "monster", { color: "white", type: "monster" }), false)) fails++;
  // monster attacker vs darkWizard target should be blocked
  if (!check("canCaptureTarget monster->darkWizard", canCaptureTarget("white", { color: "black", type: "darkWizard" }, "monster", { color: "white", type: "monster" }), false)) fails++;
  // protected scarecrow should still be capturable
  if (!check("canCaptureTarget ->protected scarecrow", canCaptureTarget("white", { color: "black", type: "scarecrow", protected: true }, "rook", { color: "white", type: "rook" }), true)) fails++;
  // protected non-scarecrow should be blocked
  if (!check("canCaptureTarget ->protected knight", canCaptureTarget("white", { color: "black", type: "knight", protected: true }, "rook", { color: "white", type: "rook" }), false)) fails++;
  // captureRestriction immune blocks
  if (!check("canCaptureTarget ->captureRestriction immune", canCaptureTarget("white", { color: "black", type: "knight", captureRestriction: "immune" }, "rook", { color: "white", type: "rook" }), false)) fails++;
  // captureRestriction royal-only blocks non-royal attacker
  if (!check("canCaptureTarget ->royal-only vs rook attacker", canCaptureTarget("white", { color: "black", type: "knight", captureRestriction: "royal-only" }, "rook", { color: "white", type: "rook" }), false)) fails++;
  // guard ability target always blocked (guard piece has ability type guard via type itself)
  if (!check("canCaptureTarget ->guard type target", canCaptureTarget("white", { color: "black", type: "guard" }, "rook", { color: "white", type: "rook" }), false)) fails++;
  // frontlineResponseBlocksCapture: hook attacker always bypasses
  if (!check("frontlineResponseBlocksCapture hook attacker", frontlineResponseBlocksCapture(true, { type: "rook" }, { row: 0, col: 0 }, { row: 5, col: 5 }, "hook"), true)) fails++;
  // frontlineResponseBlocksCapture: non-aligned non-hook attacker not blocked
  if (!check("frontlineResponseBlocksCapture non-aligned", frontlineResponseBlocksCapture(true, { type: "rook" }, { row: 0, col: 0 }, { row: 5, col: 6 }, "bishop"), false)) fails++;
  // frontlineResponseBlocksCapture: aligned (same row) blocks
  if (!check("frontlineResponseBlocksCapture aligned row", frontlineResponseBlocksCapture(true, { type: "rook" }, { row: 3, col: 0 }, { row: 3, col: 6 }, "bishop"), true)) fails++;

  console.log("TOTAL FAILS", fails);
  process.exit(fails ? 1 : 0);
}).catch((e) => { console.error("ORACLE ERROR", e); process.exit(2); });
setTimeout(() => { console.error("TIMEOUT"); process.exit(3); }, 20000);
