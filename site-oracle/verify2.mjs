import("./site-engine.mjs").then((mod) => {
  const { isDefeatRoyalPiece, isRoyalIdentityPiece, isDesperadoTargetCandidate } = mod;

  function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    console.log((pass ? "PASS" : "FAIL") + "  " + name + "  actual=" + JSON.stringify(actual) + " expected=" + JSON.stringify(expected));
    return pass;
  }

  let fails = 0;
  // regencyHeir on a non-royal-type piece (e.g. merchant/queen) marked as heir
  if (!check("isDefeatRoyalPiece(merchant+regencyHeir)", isDefeatRoyalPiece({ type: "merchant", regencyHeir: true }), true)) fails++;
  if (!check("isDefeatRoyalPiece(queen+regencyHeir)", isDefeatRoyalPiece({ type: "queen", regencyHeir: true }), true)) fails++;
  if (!check("isDefeatRoyalPiece(merchant, no regencyHeir)", isDefeatRoyalPiece({ type: "merchant" }), false)) fails++;
  if (!check("isRoyalIdentityPiece(vip)", isRoyalIdentityPiece({ type: "vip" }), false)) fails++;
  if (!check("isRoyalIdentityPiece(vip+regencyHeir)", isRoyalIdentityPiece({ type: "vip", regencyHeir: true }), true)) fails++;
  if (!check("desperado(merchant+regencyHeir) should be excluded", isDesperadoTargetCandidate({ color: "white", type: "merchant", regencyHeir: true }, 0, 0, "white"), false)) fails++;

  console.log("FAILS", fails);
  process.exit(fails ? 1 : 0);
}).catch((e) => { console.error("ORACLE ERROR", e); process.exit(2); });
setTimeout(() => { console.error("TIMEOUT"); process.exit(3); }, 20000);
