/**
 * prover.js — Main prover script for the x*x = y zk-SNARK.
 *
 * Run with:  node src/prover.js [secret_x]
 * Default secret: x = 3  (y = 9)
 *
 * Steps:
 *   1. Parse secret input x
 *   2. Compute witness w = [1, x, y]
 *   3. Verify R1CS constraint x*x = y holds
 *   4. Run KZG trusted setup (fixed tau=7 for demo)
 *   5. Convert R1CS -> QAP via Lagrange interpolation
 *   6. Compute QAP polynomials A(x), B(x), C(x), H(x)
 *   7. KZG-commit to A(x)
 *   8. Generate evaluation proof at challenge z=42
 *   9. Verify proof off-chain
 *  10. Print proof JSON and tau*G2 values for Solidity
 */

import {
  A as A_matrix,
  B as B_matrix,
  C as C_matrix,
  computeWitness,
  checkR1CS,
} from "./r1cs.js";
import { r1csToQAP, computeQAPPolynomials } from "./qap.js";
import { trustedSetup, prove, verify, tauG2Affine } from "./kzg.js";
import { CURVE_ORDER } from "./field.js";

// Fixed demo parameters
const TAU       = 7n;
const CHALLENGE_Z = 42n;

function toHex(n) {
  return "0x" + n.toString(16).padStart(64, "0");
}

async function main() {
  const xArg = process.argv[2];
  const x = xArg ? BigInt(xArg) : 3n;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  zk-SNARK Prover  |  x*x = y  |  x = ${x}`);
  console.log(`${"=".repeat(60)}\n`);

  // ── 1. Witness ────────────────────────────────────────────────────────────
  const witness = computeWitness(x);
  const [w0, w1, w2] = witness;
  console.log("Witness w = [1, x, y]:");
  console.log(`  w[0] = ${w0}  (constant)`);
  console.log(`  w[1] = ${w1}  (x, secret)`);
  console.log(`  w[2] = ${w2}  (y = x^2, public)\n`);

  // ── 2. R1CS check ────────────────────────────────────────────────────────
  if (!checkR1CS(witness)) {
    console.error("R1CS check FAILED");
    process.exit(1);
  }
  console.log("R1CS check: PASSED\n");

  // ── 3. Trusted setup ─────────────────────────────────────────────────────
  const srs = trustedSetup(4, TAU);
  console.log(`Trusted setup complete (tau = ${TAU}, SRS degree = 4)\n`);

  // ── 4. R1CS -> QAP ───────────────────────────────────────────────────────
  const numConstraints = A_matrix.length;
  const { aPolys, bPolys, cPolys, t } = r1csToQAP(
    A_matrix, B_matrix, C_matrix, numConstraints
  );

  console.log("QAP polynomials (column j of A, B, C interpolated over {1,2}):");
  for (let j = 0; j < 3; j++) {
    console.log(`  a_${j}(x) = [${aPolys[j]}]`);
    console.log(`  b_${j}(x) = [${bPolys[j]}]`);
    console.log(`  c_${j}(x) = [${cPolys[j]}]`);
  }
  console.log(`  t(x) = [${t}]  (target: (x-1)(x-2))\n`);

  // ── 5. QAP combined polynomials ───────────────────────────────────────────
  const { Ax, Bx, Cx, Hx } = computeQAPPolynomials(
    witness, aPolys, bPolys, cPolys, t
  );

  console.log("QAP combined polynomials (A(x) = sum_j w_j * a_j(x)):");
  console.log(`  A(x) = [${Ax}]`);
  console.log(`  B(x) = [${Bx}]`);
  console.log(`  C(x) = [${Cx}]`);
  console.log(`  H(x) = [${Hx}]  (A*B - C = H*t, no remainder)\n`);

  // ── 6. KZG commit + prove ─────────────────────────────────────────────────
  const proofData = prove(Ax, CHALLENGE_Z, srs);
  console.log(`KZG proof at z = ${CHALLENGE_Z}:`);
  console.log(`  A(z) = y_eval = ${proofData.y_eval}`);
  console.log(`  C = (${proofData.commitment.x}, ${proofData.commitment.y})`);
  console.log(`  pi = (${proofData.proof.x}, ${proofData.proof.y})\n`);

  // ── 7. Off-chain verification ─────────────────────────────────────────────
  const valid = verify(Ax, proofData.z, proofData.y_eval, srs);
  console.log(`Off-chain KZG verification: ${valid ? "PASSED" : "FAILED"}\n`);
  if (!valid) { process.exit(1); }

  // ── 8. Output ─────────────────────────────────────────────────────────────
  const tauG2 = tauG2Affine(srs);

  const proofJson = {
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
    publicY: toHex(witness[2]),
  };

  console.log("-".repeat(60));
  console.log("PROOF JSON:");
  console.log("-".repeat(60));
  console.log(JSON.stringify(proofJson, null, 2));

  console.log("\n" + "-".repeat(60));
  console.log("Solidity constructor args (tau*G2):");
  console.log("-".repeat(60));
  console.log(`  tauG2X1 = ${tauG2.x1}`);
  console.log(`  tauG2X0 = ${tauG2.x0}`);
  console.log(`  tauG2Y1 = ${tauG2.y1}`);
  console.log(`  tauG2Y0 = ${tauG2.y0}`);

  console.log("\n" + "-".repeat(60));
  console.log("Commands:");
  console.log("-".repeat(60));
  console.log("  forge build && forge test -vvv");
  console.log("  node src/deploy_and_test.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
