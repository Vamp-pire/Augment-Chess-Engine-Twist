import("./site-engine.mjs").then((mod) => {
  const { isRoyalIdentityPiece, isRoyalLikePiece } = mod;
  function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    console.log((pass ? "PASS" : "FAIL") + "  " + name + "  actual=" + JSON.stringify(actual) + " expected=" + JSON.stringify(expected));
    return pass;
  }
  let fails = 0;
  // disarm/severance/inertia/fanaticalRitual all gate on isRoyalIdentityPiece (narrow) -- vip should be allowed
  if (!check("isRoyalIdentityPiece(vip) - vip is a valid disarm/severance/inertia target", isRoyalIdentityPiece({ type: "vip" }), false)) fails++;
  if (!check("isRoyalIdentityPiece(king)", isRoyalIdentityPiece({ type: "king" }), true)) fails++;
  if (!check("isRoyalLikePiece(vip) - vip should NOT count for sacrifice/cleanupSacrifice exclusion", isRoyalLikePiece({ type: "vip" }), false)) fails++;
  if (!check("isRoyalLikePiece(merchant)", isRoyalLikePiece({ type: "merchant" }), true)) fails++;
  console.log("TOTAL FAILS", fails);
  process.exit(fails ? 1 : 0);
}).catch((e) => { console.error("ORACLE ERROR", e); process.exit(2); });
setTimeout(() => { console.error("TIMEOUT"); process.exit(3); }, 20000);
