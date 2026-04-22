# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install JS dependencies
npm install

# Run off-chain integration tests (R1CS + QAP + KZG verification, 4 test cases)
node src/deploy_and_test.js

# Build Solidity contracts
forge build

# Run on-chain Foundry tests (11 tests)
forge test -vvv

# Run a single Foundry test
forge test --match-test test_validProofVerifies -vvv

# Generate a proof for a given secret x (prints JSON + Solidity calldata)
node src/prover.js <x>

# Deploy to local Anvil node (start anvil first, use constructor args from prover output)
anvil
forge create contracts/Verifier.sol:KZGVerifier --constructor-args <x1> <x0> <y1> <y0> --private-key 0xac0974... --rpc-url http://localhost:8545
```

## Architecture

This is a from-scratch ZK proof system for the circuit `x * x = y`. No snarkjs/circom — everything is implemented manually in JS and Solidity.

### JavaScript pipeline (`src/`)

The proof generation flows through these modules in order:

1. **`field.js`** — scalar field `Fᵣ` arithmetic, mod `r = ...617` (the G1 group order, exported as `CURVE_ORDER`)
2. **`polynomial.js`** — polynomial arithmetic over `Fᵣ`: add, mul, div, Lagrange interpolation
3. **`bn128.js`** — BN128 G1/G2 wrappers around `@noble/curves/bn254`; exports `G1`, `G2`, `g1Add`, `g1Mul`, `g2Mul`, `G1_GROUP_ORDER`
4. **`r1cs.js`** — hardcoded R1CS matrices A, B, C (2 constraints for `x*x=y`) and witness computation
5. **`qap.js`** — R1CS→QAP via Lagrange interpolation; produces column polynomials `aPolys`, `bPolys`, `cPolys` and target `t(x)=(x-1)(x-2)`
6. **`kzg.js`** — KZG: `trustedSetup`, `commit`, `prove`, `verify`, `tauG2Affine`
7. **`prover.js`** — CLI entry point; runs the full pipeline and prints proof JSON + Solidity constructor args
8. **`deploy_and_test.js`** — end-to-end integration test across 4 witness values; also prints deployment artifacts

### Solidity (`contracts/`)

**`Verifier.sol`** (`KZGVerifier` contract):
- Constructor takes `τ·G2` as 4 `uint256` args (x1, x0, y1, y0 in EIP-197 Fp2 encoding)
- `verifyKZG(Proof)` — state-changing: verifies proof, whitelists `msg.sender` on success
- `verifyKZGView(Proof)` — view-only version for off-chain simulation
- Uses EIP-196/197 precompiles: `ecAdd` (0x06), `ecMul` (0x07), `ecPairing` (0x08)

**`contracts/test/Verifier.t.sol`** — 11 Foundry tests with hardcoded proof values for `x=3`.

### Fixed demo parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `τ` (tau) | `7` | Trusted setup secret — DEMO ONLY |
| `z` (challenge) | `42` | KZG evaluation point |
| `r` (scalar field) | `...617` | G1 group order; all poly coefficients and scalars are mod r |
| `q` (coord field) | `...583` | G1 coordinate prime; only used for ecNeg in Solidity |

### Critical naming note

The field naming is inverted between the Solidity comment and `field.js`: `CURVE_ORDER` in `field.js` equals `G1_GROUP_ORDER` in `bn128.js` equals the scalar field modulus `r = ...617`. The G1 coordinate field prime `q = ...583` is only needed in Solidity for point negation (`y' = q - y`).

### G2 encoding (EIP-197)

G2 coordinates are in `Fp2 = Fp[u]/(u²+1)`. Each coordinate `a = a₀ + a₁·u` is encoded as `[a₁, a₀]` (imaginary first, real second). Noble's `Fp2` uses `{c0: real, c1: imaginary}`, so when converting: `x1 = aff.x.c1`, `x0 = aff.x.c0`.

### How proof values flow JS → Solidity

1. Run `node src/prover.js <x>` — prints commitment, z, y_eval, pi, tauG2 as hex
2. The `tauG2` values are the constructor args for `KZGVerifier`
3. The commitment/z/y_eval/pi are the `Proof` struct fields for `verifyKZG`
4. Foundry tests hardcode values generated from `x=3` with `tau=7`
