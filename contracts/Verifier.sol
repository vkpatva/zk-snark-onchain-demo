// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title KZGVerifier
 * @notice On-chain KZG polynomial commitment verifier using alt_bn128 precompiles.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING VERIFIED
 * ─────────────────────────────────────────────────────────────────────────────
 * The prover commits to the polynomial A(x) derived from the QAP of the
 * circuit x*x = y.  They then prove knowledge of an opening at a challenge
 * point z: A(z) = y_eval.
 *
 * A correct KZG proof means the prover knows a polynomial consistent with
 * satisfying the circuit constraints — i.e., they know a secret x such that
 * x² = y (the public statement).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PAIRING CHECK
 * ─────────────────────────────────────────────────────────────────────────────
 * Standard KZG verification:
 *   e(C - y·G1, G2) == e(π, τ·G2 - z·G2)
 *
 * Rearranged to avoid G2 scalar multiplication (EVM has no G2 ecMul):
 *   e(C - y·G1 + z·π, G2) == e(π, τ·G2)
 *
 * Derivation:
 *   e(C - y·G1, G2) == e(π, (τ-z)·G2)
 *   e(C - y·G1, G2) == e(π, τ·G2) · e(π, (-z)·G2)   (bilinearity)
 *   e(C - y·G1, G2) · e(π, z·G2) == e(π, τ·G2)
 *   e(C - y·G1, G2) · e(z·π, G2) == e(π, τ·G2)       (bilinearity)
 *   e(C - y·G1 + z·π, G2) == e(π, τ·G2)               (bilinearity)
 *
 * This only needs G1 operations: z·π is an ecMul on G1 (precompile 0x07).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVM PRECOMPILES USED
 * ─────────────────────────────────────────────────────────────────────────────
 * 0x06 (ecAdd)     : adds two G1 points
 *   input:  [x1, y1, x2, y2]  (4 × 32 bytes = 128 bytes)
 *   output: [x, y]             (2 × 32 bytes =  64 bytes)
 *
 * 0x07 (ecMul)     : scalar-multiplies a G1 point
 *   input:  [x, y, scalar]    (3 × 32 bytes =  96 bytes)
 *   output: [x, y]             (2 × 32 bytes =  64 bytes)
 *
 * 0x08 (ecPairing) : checks product of pairings == 1
 *   input:  n × [g1.x, g1.y, g2.x1, g2.x0, g2.y1, g2.y0]  (n × 192 bytes)
 *   output: [0 or 1]           (32 bytes)
 *
 * G2 point encoding for ecPairing (EIP-197):
 *   x = x1·u + x0   →  encoded as [x1, x0]  (imaginary first, real second)
 *   y = y1·u + y0   →  encoded as [y1, y0]
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHITELIST LOGIC
 * ─────────────────────────────────────────────────────────────────────────────
 * If the KZG proof verifies, the caller's address is added to a whitelist.
 * This demonstrates the "gate access" use case: only those who can prove
 * knowledge of a valid square root get whitelisted.
 */
contract KZGVerifier {
    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev G1 coordinate field prime q (EIP-196 "p") — used for y-negation in ecNeg.
    ///      G1 point coordinates x, y are in [0, q-1].
    ///      Note: this equals the "CURVE_ORDER" from field.js (= ...583),
    ///      NOT the "FIELD_PRIME" from the problem statement (= ...617).
    ///      The naming in the problem statement is inverted relative to EIP-196.
    uint256 constant FIELD_PRIME =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;

    /// @dev G1 generator x-coordinate
    uint256 constant G1X = 1;
    /// @dev G1 generator y-coordinate
    uint256 constant G1Y = 2;

    /// @dev G2 generator coordinates (EIP-197 standard values)
    ///      x = G2_X1·u + G2_X0  (X1 = imaginary, X0 = real)
    uint256 constant G2_X1 =
        11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant G2_X0 =
        10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant G2_Y1 =
        4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant G2_Y0 =
        8495653923123431417604973247489272438418190587263600148770280649306958101930;

    // ─────────────────────────────────────────────────────────────────────────
    // Trusted setup: τ·G2 (stored from the JS trusted setup)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev τ·G2 point — imaginary part of x-coordinate
    uint256 public TAU_G2_X1;
    /// @dev τ·G2 point — real part of x-coordinate
    uint256 public TAU_G2_X0;
    /// @dev τ·G2 point — imaginary part of y-coordinate
    uint256 public TAU_G2_Y1;
    /// @dev τ·G2 point — real part of y-coordinate
    uint256 public TAU_G2_Y0;

    // ─────────────────────────────────────────────────────────────────────────
    // Whitelist
    // ─────────────────────────────────────────────────────────────────────────

    mapping(address => bool) public whitelist;

    event WhitelistAdded(address indexed account);

    // ─────────────────────────────────────────────────────────────────────────
    // Data types
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice G1 point in affine coordinates
    struct G1Point {
        uint256 x;
        uint256 y;
    }

    /// @notice G2 point in affine coordinates over Fp2
    /// @dev x[0] = imaginary (c1), x[1] = real (c0) — matches EIP-197 encoding
    struct G2Point {
        uint256[2] x; // [x1 (imaginary), x0 (real)]
        uint256[2] y; // [y1 (imaginary), y0 (real)]
    }

    /// @notice Complete KZG proof
    struct Proof {
        G1Point commitment; // C = f(τ)·G1
        uint256 z;          // evaluation point
        uint256 y_eval;     // claimed f(z)
        G1Point pi;         // opening proof π = q(τ)·G1
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param tauG2X1 Imaginary part of τ·G2 x-coordinate
     * @param tauG2X0 Real part of τ·G2 x-coordinate
     * @param tauG2Y1 Imaginary part of τ·G2 y-coordinate
     * @param tauG2Y0 Real part of τ·G2 y-coordinate
     */
    constructor(
        uint256 tauG2X1,
        uint256 tauG2X0,
        uint256 tauG2Y1,
        uint256 tauG2Y0
    ) {
        TAU_G2_X1 = tauG2X1;
        TAU_G2_X0 = tauG2X0;
        TAU_G2_Y1 = tauG2Y1;
        TAU_G2_Y0 = tauG2Y0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Precompile wrappers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Add two G1 points using the ecAdd precompile (0x06).
     * @dev EIP-196: staticcall to 0x06 with 128-byte input, 64-byte output.
     */
    function ecAdd(G1Point memory p1, G1Point memory p2)
        internal
        view
        returns (G1Point memory r)
    {
        uint256[4] memory input = [p1.x, p1.y, p2.x, p2.y];
        bool success;
        assembly {
            success := staticcall(gas(), 0x06, input, 0x80, r, 0x40)
        }
        require(success, "ecAdd: precompile call failed");
    }

    /**
     * @notice Scalar-multiply a G1 point using the ecMul precompile (0x07).
     * @dev EIP-196: staticcall to 0x07 with 96-byte input, 64-byte output.
     */
    function ecMul(G1Point memory p, uint256 scalar)
        internal
        view
        returns (G1Point memory r)
    {
        uint256[3] memory input = [p.x, p.y, scalar];
        bool success;
        assembly {
            success := staticcall(gas(), 0x07, input, 0x60, r, 0x40)
        }
        require(success, "ecMul: precompile call failed");
    }

    /**
     * @notice Negate a G1 point: (x, y) → (x, p - y).
     * @dev Pure function — no precompile needed.  Valid because the curve
     *      equation y² = x³ + 3 is symmetric about the x-axis.
     */
    function ecNeg(G1Point memory p)
        internal
        pure
        returns (G1Point memory)
    {
        if (p.x == 0 && p.y == 0) return p; // point at infinity
        return G1Point(p.x, FIELD_PRIME - (p.y % FIELD_PRIME));
    }

    /**
     * @notice Check e(a1, a2) == e(b1, b2) using the ecPairing precompile (0x08).
     *
     * Equivalently: e(a1, a2) · e(−b1, b2) == 1
     *
     * EIP-197 input encoding for each pair (G1, G2):
     *   [g1.x, g1.y, g2.x[0], g2.x[1], g2.y[0], g2.y[1]]
     *   where g2.x[0] = imaginary (c1), g2.x[1] = real (c0)
     *
     * Total: 2 pairs × 6 words × 32 bytes = 384 bytes input.
     */
    function pairingCheck(
        G1Point memory a1,
        G2Point memory a2,
        G1Point memory b1,
        G2Point memory b2
    ) internal view returns (bool) {
        uint256[12] memory input;
        // Pair 1: (a1, a2)
        input[0] = a1.x;
        input[1] = a1.y;
        input[2] = a2.x[0]; // x1 (imaginary)
        input[3] = a2.x[1]; // x0 (real)
        input[4] = a2.y[0]; // y1 (imaginary)
        input[5] = a2.y[1]; // y0 (real)
        // Pair 2: (b1, b2)  — we pass -b1 to turn == into product == 1
        G1Point memory negB1 = ecNeg(b1);
        input[6]  = negB1.x;
        input[7]  = negB1.y;
        input[8]  = b2.x[0];
        input[9]  = b2.x[1];
        input[10] = b2.y[0];
        input[11] = b2.y[1];

        uint256[1] memory out;
        bool success;
        assembly {
            success := staticcall(gas(), 0x08, input, 0x180, out, 0x20)
        }
        require(success, "ecPairing: precompile call failed");
        return out[0] == 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core verification logic
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Verify a KZG evaluation proof and whitelist the caller on success.
     *
     * Verification equation (after algebraic rearrangement):
     *   e(C - y·G1 + z·π, G2) == e(π, τ·G2)
     *
     * @param proof The KZG proof (commitment, evaluation point, claimed value, π).
     * @return valid True iff the proof is valid.
     */
    function verifyKZG(Proof calldata proof) external returns (bool valid) {
        G1Point memory G1gen = G1Point(G1X, G1Y);

        // ── Step 1: compute y·G1 ─────────────────────────────────────────────
        // y·G1 is the G1 encoding of the claimed evaluation value.
        G1Point memory yG1 = ecMul(G1gen, proof.y_eval);

        // ── Step 2: C - y·G1 ─────────────────────────────────────────────────
        // Subtracting y·G1 from the commitment removes the "known" part.
        G1Point memory C_minus_yG1 = ecAdd(proof.commitment, ecNeg(yG1));

        // ── Step 3: z·π ──────────────────────────────────────────────────────
        // z is a public scalar; π is a G1 point.
        // This is an ecMul on G1 — perfectly fine for the EVM.
        G1Point memory zPi = ecMul(proof.pi, proof.z);

        // ── Step 4: lhs = C - y·G1 + z·π ────────────────────────────────────
        G1Point memory lhs = ecAdd(C_minus_yG1, zPi);

        // ── Step 5: Build G2 points ───────────────────────────────────────────
        G2Point memory G2gen = G2Point(
            [G2_X1, G2_X0], // x: [imaginary, real]
            [G2_Y1, G2_Y0]  // y: [imaginary, real]
        );
        G2Point memory tauG2 = G2Point(
            [TAU_G2_X1, TAU_G2_X0],
            [TAU_G2_Y1, TAU_G2_Y0]
        );

        // ── Step 6: Pairing check ─────────────────────────────────────────────
        // Check: e(lhs, G2) == e(π, τ·G2)
        // Equivalently: e(lhs, G2) · e(-π, τ·G2) == 1
        valid = pairingCheck(lhs, G2gen, proof.pi, tauG2);

        // ── Step 7: Whitelist on success ──────────────────────────────────────
        if (valid) {
            whitelist[msg.sender] = true;
            emit WhitelistAdded(msg.sender);
        }
    }

    /**
     * @notice View-only version of verifyKZG for off-chain simulation.
     *         Does NOT update the whitelist.
     */
    function verifyKZGView(Proof calldata proof) external view returns (bool) {
        G1Point memory G1gen = G1Point(G1X, G1Y);
        G1Point memory yG1 = ecMul(G1gen, proof.y_eval);
        G1Point memory C_minus_yG1 = ecAdd(proof.commitment, ecNeg(yG1));
        G1Point memory zPi = ecMul(proof.pi, proof.z);
        G1Point memory lhs = ecAdd(C_minus_yG1, zPi);

        G2Point memory G2gen = G2Point([G2_X1, G2_X0], [G2_Y1, G2_Y0]);
        G2Point memory tauG2 = G2Point([TAU_G2_X1, TAU_G2_X0], [TAU_G2_Y1, TAU_G2_Y0]);

        return pairingCheck(lhs, G2gen, proof.pi, tauG2);
    }
}
