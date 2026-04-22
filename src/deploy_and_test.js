/**
 * deploy_and_test.js — End-to-end integration test (pure JavaScript).
 *
 * This script simulates the complete protocol flow without touching any
 * blockchain.  It verifies that all components (R1CS, QAP, KZG) compose
 * correctly before moving to on-chain testing.
 *
 * Run with:  node src/deploy_and_test.js
 */

import {
  A as A_matrix,
  B as B_matrix,
  C as C_matrix,
  computeWitness,
  checkR1CS,
} from "./r1cs.js";
import { r1csToQAP, computeQAPPolynomials } from "./qap.js";
import { trustedSetup, commit, prove, verify, tauG2Affine } from "./kzg.js";
import { CURVE_ORDER } from "./field.js";
import { polyEval } from "./polynomial.js";
// FIELD_PRIME from bn128.js = G1 group order (n = ...617)
// G1_Q below is the G1 coordinate field prime (q = ...583 = CURVE_ORDER)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toHex(n) {
  return "0x" + n.toString(16).padStart(64, "0");
}

function section(title) {
  console.log(`\n${"=".repeat(64)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(64)}`);
}

function ok(label) {
  console.log(`  [PASS] ${label}`);
}

function fail(label) {
  console.error(`  [FAIL] ${label}`);
  process.exit(1);
}

// G1 coordinate field prime q (EIP-196 "p") = CURVE_ORDER from field.js = ...583
const G1_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

function onCurve(x, y) {
  // Check point is on y^2 = x^3 + 3 mod q (standard EIP-196 alt_bn128 curve)
  const lhs = y * y % G1_Q;
  const rhs = (x * x % G1_Q * x % G1_Q + 3n) % G1_Q;
  return lhs === rhs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test cases
// ─────────────────────────────────────────────────────────────────────────────

const TEST_CASES = [
  { x: 3n,   desc: "x=3, y=9" },
  { x: 5n,   desc: "x=5, y=25" },
  { x: 100n, desc: "x=100, y=10000" },
  { x: 1n,   desc: "x=1, y=1" },
];

const TAU = 7n;
const CHALLENGE_Z = 42n;

async function runTest(testCase) {
  const { x, desc } = testCase;
  console.log(`\n  -- Test: ${desc} --`);

  // 1. Compute witness
  const w = computeWitness(x);
  const y = w[2];

  // 2. R1CS check
  if (!checkR1CS(w)) fail(`R1CS check for ${desc}`);
  ok(`R1CS satisfied: x*x = y  (x=${x}, y=${y})`);

  // 3. QAP
  const numConstraints = A_matrix.length;
  const { aPolys, bPolys, cPolys, t } = r1csToQAP(
    A_matrix, B_matrix, C_matrix, numConstraints
  );
  const { Ax, Bx, Cx, Hx } = computeQAPPolynomials(w, aPolys, bPolys, cPolys, t);
  ok(`QAP divisibility check passed  (H(x) = [${Hx.join(",")}])`);

  // Manual check: A(k)*B(k) = C(k) for k=1,2
  for (let k = 1n; k <= 2n; k++) {
    const Ak = polyEval(Ax, k);
    const Bk = polyEval(Bx, k);
    const Ck = polyEval(Cx, k);
    const prod = (Ak * Bk) % CURVE_ORDER;
    if (prod !== Ck) fail(`A(${k})*B(${k}) != C(${k}) for ${desc}`);
  }
  ok("QAP evaluation points: A(k)*B(k) = C(k) for k=1,2");

  // 4. KZG setup
  const srs = trustedSetup(4, TAU);

  // 5. Prove
  const proofData = prove(Ax, CHALLENGE_Z, srs);

  // 6. Check commitment is on standard alt_bn128 curve
  if (!onCurve(proofData.commitment.x, proofData.commitment.y)) {
    fail(`Commitment not on alt_bn128 curve for ${desc}`);
  }
  ok("Commitment is on standard alt_bn128 curve (Fp-correct)");

  // 7. Verify (off-chain pairing)
  const valid = verify(Ax, proofData.z, proofData.y_eval, srs);
  if (!valid) fail(`KZG verification for ${desc}`);
  ok(`KZG proof verified: A(${CHALLENGE_Z}) = ${proofData.y_eval}`);

  // 8. Tampered y_eval should fail
  const wrongYEval = (proofData.y_eval + 1n) % CURVE_ORDER;
  const tamperedValid = verify(Ax, proofData.z, wrongYEval, srs);
  if (tamperedValid) fail(`Tampered y_eval should have failed for ${desc}`);
  ok("Tampered y_eval correctly rejected");

  return proofData;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  section("zk-SNARK End-to-End Integration Test");

  for (const tc of TEST_CASES) {
    await runTest(tc);
  }

  // ── Print deployment artifacts for x=3 ────────────────────────────────────
  section("Deployment Artifacts (x=3, y=9)");

  const x = 3n;
  const w = computeWitness(x);
  const numConstraints = A_matrix.length;
  const { aPolys, bPolys, cPolys, t } = r1csToQAP(
    A_matrix, B_matrix, C_matrix, numConstraints
  );
  const { Ax } = computeQAPPolynomials(w, aPolys, bPolys, cPolys, t);
  const srs = trustedSetup(4, TAU);
  const proofData = prove(Ax, CHALLENGE_Z, srs);
  const tauG2 = tauG2Affine(srs);

  const artifact = {
    x: toHex(x),
    y: toHex(w[2]),
    commitment: {
      x: toHex(proofData.commitment.x),
      y: toHex(proofData.commitment.y),
    },
    z:      toHex(proofData.z),
    y_eval: toHex(proofData.y_eval),
    proof: {
      x: toHex(proofData.proof.x),
      y: toHex(proofData.proof.y),
    },
    tauG2: {
      x1: toHex(tauG2.x1),
      x0: toHex(tauG2.x0),
      y1: toHex(tauG2.y1),
      y0: toHex(tauG2.y0),
    },
  };

  console.log("\nProof JSON for Foundry test:");
  console.log(JSON.stringify(artifact, null, 2));

  console.log("\nFoundry test constructor args:");
  console.log(`  tauG2X1 = ${tauG2.x1}`);
  console.log(`  tauG2X0 = ${tauG2.x0}`);
  console.log(`  tauG2Y1 = ${tauG2.y1}`);
  console.log(`  tauG2Y0 = ${tauG2.y0}`);

  console.log("\nVerifier.sol verifyKZG calldata:");
  console.log(`    commitment.x = ${proofData.commitment.x}`);
  console.log(`    commitment.y = ${proofData.commitment.y}`);
  console.log(`    z            = ${proofData.z}`);
  console.log(`    y_eval       = ${proofData.y_eval}`);
  console.log(`    pi.x         = ${proofData.proof.x}`);
  console.log(`    pi.y         = ${proofData.proof.y}`);

  section("How to Run On-Chain");
  console.log(`
  1. Install Foundry:
       curl -L https://foundry.paradigm.xyz | bash && foundryup

  2. Install JS dependencies:
       npm install

  3. Build contracts:
       forge build

  4. Run Foundry tests:
       forge test -vvv

  5. Start local Anvil node:
       anvil

  6. Deploy:
       forge create contracts/Verifier.sol:KZGVerifier \\
         --constructor-args \\
           ${tauG2.x1} \\
           ${tauG2.x0} \\
           ${tauG2.y1} \\
           ${tauG2.y0} \\
         --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \\
         --rpc-url http://localhost:8545

  7. Generate a fresh proof:
       node src/prover.js 7
  `);

  section("All Tests PASSED");
}

main().catch((err) => {
  console.error("\n[ERROR]", err.message);
  console.error(err.stack);
  process.exit(1);
});
