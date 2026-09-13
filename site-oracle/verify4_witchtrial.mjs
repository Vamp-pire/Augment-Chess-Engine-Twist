import("./site-engine.mjs").then((mod) => {
  const { resolveWitchTrialCapture } = mod;
  function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    console.log((pass ? "PASS" : "FAIL") + "  " + name + "  actual=" + JSON.stringify(actual) + " expected=" + JSON.stringify(expected));
    return pass;
  }
  let fails = 0;
  const piece = { type: "knight", color: "white", witchTrial: { by: "black", remaining: 1 } };
  const result = resolveWitchTrialCapture(piece, true);
  if (!check("resolveWitchTrialCapture returns true", result, true)) fails++;
  if (!check("piece.shielded set", piece.shielded, true)) fails++;
  if (!check("piece.protected NOT set", piece.protected, undefined)) fails++;
  if (!check("piece.witchTrial cleared", piece.witchTrial, undefined)) fails++;

  console.log("TOTAL FAILS", fails);
  process.exit(fails ? 1 : 0);
}).catch((e) => { console.error("ORACLE ERROR", e); process.exit(2); });
setTimeout(() => { console.error("TIMEOUT"); process.exit(3); }, 20000);
