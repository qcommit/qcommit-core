# Qcommit Core

**Post-quantum creator approvals that anyone can verify independently.**

Qcommit Core signs the exact details of a **proposed** Solana token launch using
SLH-DSA-SHA2-128s. It includes an authorization format, encrypted creator backups,
and independent JavaScript and Python signature verifiers. The funding wallet
and the creator's post-quantum signing key have separate roles.

> **Experimental preview.** This repository does not create tokens, submit
> transactions, or verify an on-chain launch. Every receipt uses a preview-only
> domain. A valid signature is not a trusted creator identity or a confirmed
> token launch. No independent security audit has been performed.

## Reproduce the checks

Use Node **22.22.0+** and Python **3.11+**. Python verification uses only the
standard library. Install the locked JavaScript signer dependency once, then all
checks below run locally without an RPC or website.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:signing
npm run test:vectors
npm run test:mutations
```

To inspect the included public test receipt independently:

```sh
python3 cli/verify.py fixtures/orbital.receipt.json \
  --key "$(cat fixtures/creator-public-key.txt)"
```

The fixture key is deliberately public and used only for reproduction. For any
other receipt, obtain the expected creator key through an independent trusted
channel. The CLI reports signature validity, time-window status, and
`onchainVerified: false`; exit 0 establishes successful signature/key checking,
not current launch eligibility or token creation. Altered receipts exit 1.

## What is implemented

| Capability | Implementation |
| --- | --- |
| Creator approval | Noble 0.7.1 signs an application SHA-256 digest using pure SLH-DSA-SHA2-128s and `Qcommit.LaunchPreview.v1` context |
| Exact launch details | Fixed-order JSON; creator key, funding address, recipient, network label, supply, decimals, metadata and authority policy are signed |
| Creator backup | PBKDF2-HMAC-SHA256 (600,000 iterations), AES-256-GCM, fixed KDF profile, authenticated metadata |
| Independent JavaScript verification | Original verify-only FORS/WOTS+/XMSS implementation; does not call the signing library |
| Independent Python verification | Original standard-library-only verifier; does not call Node, Noble, OpenSSL or RPC |
| Separate receipt statuses | Signature validity, supplied creator-fingerprint match, expiry/future time, and unverified chain state |
| Published-vector checks | 28 selected NIST external-pure SHA2-128s signatures checked by both independent verifiers |

The signature is **7,856 bytes** and the public key is **32 bytes**. The signed
application digest is distinct from the formal HashSLH-DSA interface. Publisher
labels and timestamps are self-asserted. HTTPS or localhost is required for
browser WebCrypto; browser bundling/UI belongs to a separate project and is not
shipped here.

## API example

```js
import { slh_dsa_sha2_128s as slh } from '@noble/post-quantum/slh-dsa.js';
import {
  CONTEXT, intentDigest, makeReceipt, verifyReceipt, fingerprint, hex
} from '@qcommit/core';

const keys = slh.keygen();
try {
  // intent must contain the complete schema described in docs/PROTOCOL.md.
  intent.creatorPublicKey = hex(keys.publicKey);
  const signature = slh.sign(await intentDigest(intent), keys.secretKey, {
    context: new TextEncoder().encode(CONTEXT)
  });
  const receipt = await makeReceipt(intent, signature);
  const pin = await fingerprint(intent.creatorPublicKey);
  const result = await verifyReceipt(receipt, { expectedFingerprint: pin });
  // pin above is appropriate for this local round-trip demonstration only.
  // A verifier receiving somebody else's receipt needs a separately trusted pin.
} finally {
  keys.secretKey.fill(0); // best effort; JS cannot guarantee physical erasure
}
```

For a complete executed example including an encrypted backup round-trip and
independent Python checking, read [tests/signing.integration.mjs](tests/signing.integration.mjs).
The package is marked `private` to prevent accidental npm publication; it remains
MIT-licensed source that can be inspected and used from a local checkout.

## Executed validation

See [evidence/validation.json](evidence/validation.json) for exact commands,
runtimes and source hashes, and [evidence/nist.json](evidence/nist.json) for every
selected standard case. The release suite checks:

- 20 application tests, including JS/Python schema agreement and negative cases.
- Two fresh Noble-signed receipts, encrypted-key recovery, and independent JS/Python verification.
- 28 published NIST signatures per independent verifier: 14 sigVer cases and
  14 sigGen outputs. The verify-only implementations do not regenerate sigGen signatures.
- 491 one-byte component mutations of the OpenSSL-generated preview fixture.

The preview fixture is **not** a NIST vector. Both types have separate provenance.
Selected tests are bounded evidence; comprehensive FIPS conformance, a full NIST
corpus, formal verification and an audit are not claimed. Hosted GitHub Actions
results must be checked separately from these local receipts.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/protocol.mjs` | Intent schema, digest, receipts and trust/status semantics |
| `src/vault.mjs` | Encrypted creator backups |
| `src/slh-verify.mjs` | Independent JS signature verification and root trace |
| `cli/verify.py`, `cli/slh_verify.py` | Independent offline Python verification |
| `fixtures/` | Public preview fixture and selected NIST cases with provenance |
| `tests/` | Application, signing, schema, standard-vector and mutation checks |
| `docs/PROTOCOL.md` | Exact signed byte format and fingerprint definition |
| `docs/LAUNCH_PROGRAM.md` | Explicit requirements for the unfinished on-chain integration |
| `.github/workflows/check.yml` | Reproducible hosted checks |

## On-chain launch is future work

Production creator registration, deployment/genesis binding, replay nonces,
proof-upload accounts, on-chain verification, atomic token creation and confirmed
execution receipts are **not implemented here**. Preview receipts must never be
accepted by a production launch program. See the [integration requirements](docs/LAUNCH_PROGRAM.md).

Read [SECURITY.md](SECURITY.md) before handling keys. Contributions are described
in [CONTRIBUTING.md](CONTRIBUTING.md); original code is [MIT licensed](LICENSE).
Dependency licenses and published-vector provenance are in [THIRD_PARTY.md](THIRD_PARTY.md).
