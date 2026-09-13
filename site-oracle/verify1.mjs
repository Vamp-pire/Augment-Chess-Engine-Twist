import("./site-engine.mjs").then((mod) => {
  const { isDefeatRoyalPiece, isRoyalLikePiece, isDesperadoTargetCandidate, hasRoyalCommandCaptureAccess, socialismSuppressesRoyalCommand, royalShield, state } = mod;

  const results = [];
  function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, pass, actual, expected });
  }

  // isDefeatRoyalPiece: merchant/timeTraveler/vampireLord should NOT be decisive
  check("isDefeatRoyalPiece(merchant)", isDefeatRoyalPiece({ type: "merchant" }), false);
  check("isDefeatRoyalPiece(timeTraveler)", isDefeatRoyalPiece({ type: "timeTraveler" }), false);
  check("isDefeatRoyalPiece(vampireLord)", isDefeatRoyalPiece({ type: "vampireLord" }), false);
  check("isDefeatRoyalPiece(vip)", isDefeatRoyalPiece({ type: "vip" }), true);
  check("isDefeatRoyalPiece(king)", isDefeatRoyalPiece({ type: "king" }), true);
  check("isDefeatRoyalPiece(darkWizard)", isDefeatRoyalPiece({ type: "darkWizard" }), true);

  // isRoyalLikePiece: vip should NOT be included, merchant/timeTraveler/vampireLord SHOULD
  check("isRoyalLikePiece(vip)", isRoyalLikePiece({ type: "vip" }), false);
  check("isRoyalLikePiece(merchant)", isRoyalLikePiece({ type: "merchant" }), true);
  check("isRoyalLikePiece(king)", isRoyalLikePiece({ type: "king" }), true);

  // isDesperadoTargetCandidate: bigBishop excluded, timeTraveler/vampireLord allowed
  check("desperado(bigBishop)", isDesperadoTargetCandidate({ color: "white", type: "bigBishop" }, 0, 0, "white"), false);
  check("desperado(timeTraveler)", isDesperadoTargetCandidate({ color: "white", type: "timeTraveler" }, 0, 0, "white"), true);
  check("desperado(vampireLord)", isDesperadoTargetCandidate({ color: "white", type: "vampireLord" }, 0, 0, "white"), true);
  check("desperado(vip)", isDesperadoTargetCandidate({ color: "white", type: "vip" }, 0, 0, "white"), false);

  // socialismSuppressesRoyalCommand + hasRoyalCommandCaptureAccess interaction
  const src = { socialism: { white: 1 } };
  check("socialismSuppresses(knight, socialism=1)", socialismSuppressesRoyalCommand({ type: "knight", color: "white" }, src), true);
  check("socialismSuppresses(merchant, socialism=1)", socialismSuppressesRoyalCommand({ type: "merchant", color: "white" }, src), true);
  check("socialismSuppresses(king, socialism=1)", socialismSuppressesRoyalCommand({ type: "king", color: "white" }, src), false);
  check("socialismSuppresses(crown, socialism=1)", socialismSuppressesRoyalCommand({ type: "crown", color: "white" }, src), false);
  check("royalCommandAccess(knight+royalCommand, socialism=1)", hasRoyalCommandCaptureAccess({ type: "knight", color: "white", royalCommand: true }, src), false);
  check("royalCommandAccess(crownBearer, socialism=1)", hasRoyalCommandCaptureAccess({ type: "knight", color: "white", crownBearer: true }, src), true);
  check("royalCommandAccess(knight+royalCommand, no socialism)", hasRoyalCommandCaptureAccess({ type: "knight", color: "white", royalCommand: true }, { socialism: {} }), true);

  // royalShield: scarecrow excluded
  state.board = Array.from({ length: 8 }, () => Array(8).fill(null));
  state.board[3][3] = { color: "white", type: "scarecrow", id: "s1" };
  state.turn = "white";
  const r1 = royalShield();
  check("royalShield with only scarecrow -> no eligible piece", r1.ok, false);

  let failCount = 0;
  results.forEach((r) => {
    console.log((r.pass ? "PASS" : "FAIL") + "  " + r.name + "  actual=" + JSON.stringify(r.actual) + " expected=" + JSON.stringify(r.expected));
    if (!r.pass) failCount++;
  });
  console.log("TOTAL", results.length, "FAILS", failCount);
  process.exit(failCount ? 1 : 0);
}).catch((e) => {
  console.error("ORACLE ERROR", e);
  process.exit(2);
});
setTimeout(() => { console.error("TIMEOUT"); process.exit(3); }, 20000);
