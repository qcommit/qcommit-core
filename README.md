# Qcommit Core

**Post-quantum creator approval, enforced before a Solana token is created.**

Qcommit separates a creator's SLH-DSA signing key from the ordinary Solana wallet
that pays transaction costs. Its launch program verifies the creator's exact
approval on chain, then atomically creates a fixed-supply SPL token, distributes
its supply, revokes mint authority and creates immutable Metaplex metadata.

**Current status:** the program, creator/launch flow and complete wallet-signed
native deployment have executed on an isolated validator with synthetic funds.
The deployment rehearsal includes upload, native deployment, configuration,
separate immutable finalization and a token launch. The browser operator console
has also completed real read-only mainnet cost/state checks. A funded mainnet
deployment, genuine Phantom-extension acceptance run and independent security
audit remain pending. No mainnet program address is advertised here.

Qcommit protects **creator launch authorization**. Tokens created by the program
are ordinary SPL tokens: their holders' transfers, funding-wallet signatures and
Solana itself retain their existing authorization and security models.

## What is implemented

| Capability | Implementation |
| --- | --- |
| Creator identity | A payer/key/deployment-bound creator PDA; activation requires an actual on-chain post-quantum possession proof |
| Production approval | Canonical binary intent and `Qcommit.Launch.v1` signature context, separate from historical preview receipts |
| Wallet-signed deployment | Public wallet-derived program/buffer accounts, exact reviewed binary upload, bounded signing batches and separate irreversible finalization; no deployment private keys |
| Deployment binding | Actual genesis/code/configuration checks plus original native creation transaction, ProgramData slot visibility and upgrade policy |
| Deployment recovery | Public journal, exact-byte resume, actual confirmed-fee recovery, unchanged-message checks and uncertain-outcome stops |
| Replay and expiry | Monotonic creator nonce and expiry checked again during final execution |
| Large-signature transport | Bounded uploader-specific proof accounts, exact offset checks, immutable sealed payload and staged on-chain verification |
| Atomic token creation | Classic SPL mint, full initial distribution, revoked mint authority, no freeze authority, immutable Metaplex metadata and immutable launch record |
| Transaction client | Funding-wallet signing, unchanged-message checks, simulation, fee limits, confirmation journal and exact-proof resume |
| Execution receipt | Independent signature, creator fingerprint and finalized public-network transaction/account checks |
| Encrypted creator backup | PBKDF2-HMAC-SHA256 and AES-256-GCM; the funding wallet uses its own separate keys |
| Independent verification | Original JavaScript and Rust SLH-DSA verification; standard-library Python verification of historical preview receipts |

SLH-DSA-SHA2-128s uses a **7,856-byte signature** and **32-byte public key**.
The application signs a domain-separated SHA-256 digest using the pure SLH-DSA
interface; this is distinct from the formal HashSLH-DSA interface.

## Reproduce the checks

Use Node **22.22.0+** and Python **3.11+**. Install locked JavaScript dependencies:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:sdk
node --test server/tests/*.test.mjs
npm run test:signing
npm run test:vectors
npm run test:mutations
```

These commands exercise local cryptography and bounded client tests. They do not
spend funds or deploy a public program. The separate native build and real
validator suite require the pinned Rust/Solana toolchain, cached local-validator
container image and real Metaplex program fixture described in the
[build and local-test instructions](docs/BUILD.md):

```sh
bash scripts/build-onchain.sh
npm run test:onchain
```

Inspect [the build script](scripts/build-onchain.sh), [validator runner](scripts/test-onchain.sh)
and [actual integration test](tests/onchain-localnet.mjs) before running them.
The integration runner deliberately uses an isolated validator and synthetic
payer/genesis fixtures. It is not a mainnet deployment command.

## Deploy through Phantom

The separate operator console connects an explicitly selected Phantom wallet,
shows current rent/fees and exact artifact identity, and requests wallet signatures
only after deployment-cost review. Its SDK lives in [`sdk/deployer.mjs`](sdk/deployer.mjs):

```js
import {
  prepareDeployment, executeDeployment,
  inspectFinalization, finalizeDeployment,
} from './sdk/deployer.mjs';
```

Preparation is read-only. Execution uploads the reviewed program in wallet-approved
batches of at most ten transactions, deploys it and initializes its configuration.
The separate finalization action permanently removes upgrade authority. Public
journals retain the seeds, transaction signatures and original deployment proof;
wallet secrets remain with the wallet. See [the complete operator API](sdk/OPERATOR.md)
and [mainnet acceptance/cost evidence](docs/MAINNET_DEPLOYMENT.md).

The recorded mainnet preflight for the pinned 168,568-byte artifact showed
**0.86122104 SOL required funding**, including a 0.002 SOL network-fee ceiling,
and **0.86018104 SOL estimated net deployment cost**. Buffer funds are reused
before ProgramData allocation. These are timestamped read-only quotes, not a
mainnet deployment or a permanent price; refresh them before approval. Creator
registration and token creation have separate costs.

## Register a creator and launch

The production SDK is exported separately from the historical preview API:

```js
import {
  openNetwork, prepareRegistration, registerCreator,
  prepareLaunch, executeLaunch, verifyExecution
} from '@qcommit/core/launch';
```

1. Supply a configuration pinned to the actual program deployment and cluster.
2. Create or restore an encrypted SLH-DSA creator identity.
3. Review the registration request and costs; sign its digest with the creator key.
4. Register and activate that identity using an explicitly supplied funding wallet.
5. Prepare the exact token parameters, review recipient and cost limits, then sign
   the distinct launch digest.
6. Submit the staged proof and atomic launch; retain the complete transaction journal.
7. Independently verify the resulting authorization and execution receipt.

See [the SDK guide and examples](sdk/README.md), [operator deployment guide](docs/MAINNET_DEPLOYMENT.md), [binary ABI](sdk/ABI.md),
[program behavior](docs/LAUNCH_PROGRAM.md) and `node sdk/cli.mjs help`.
The SDK accepts a wallet exposing `publicKey` and `signTransaction`; it never
loads an implicit default funding key. Browser wallet prompts and hosting belong
to the separate Qcommit website project.

Public-network configurations require HTTPS RPC and finalized results. Mainnet
additionally requires a pinned immutable program. Configuration alone does not
bypass the deployment-byte, loader, genesis or on-chain configuration checks.

## Actual execution evidence

[evidence/onchain-localnet.json](evidence/onchain-localnet.json) records **204
transactions, 28 checks and 24 expected rejected transactions**, including two
successful token creations with immutable metadata. Its scope is the actual
isolated validator, not a mocked RPC or public network. Checks include creator
initialization front-running, account/payer substitution, upload offsets and
ownership, corrupted signatures, altered intents, preview-domain rejection,
replay, final expiry and failed-CPI rollback.

[evidence/deploy-localnet.json](evidence/deploy-localnet.json) separately records
**244 actual local-validator transactions and 15 checks** for original native
loader deployment using one synthetic wallet and no program/buffer private keys.
It covers exact uploads, interruption/recovery, cancellation, changed wallet
messages, failed-deployment rollback, buffer-rent credit, bootstrap, immutable
finalization and a subsequent creator registration/token launch. Its source
snapshot and deployer hashes identify the exact tested implementation.

[evidence/phantom-mainnet-preflight.json](evidence/phantom-mainnet-preflight.json)
records real mainnet reads from the compiled HTTPS Worker with an explicitly
simulated public-only Phantom adapter. It requested **zero signatures and zero
transactions**. Actual extension behavior and funded mainnet execution remain
separate acceptance gates.

The earlier cryptographic release evidence remains separate:

- [evidence/validation.json](evidence/validation.json): the historical preview
  suite and source hashes, not validation of subsequent program changes.
- [evidence/nist.json](evidence/nist.json): 28 selected published signatures per
  independent verifier; verify-only implementations do not regenerate sigGen outputs.
- Two fresh preview signatures with encrypted-backup recovery and independent
  JS/Python verification; 491 component mutations of the public preview fixture.

Counts describe those exact receipts. They are not an audit, comprehensive FIPS
conformance, a full NIST corpus or proof of mainnet availability. Check hosted CI
and the source hashes corresponding to the version you intend to use.

## Historical preview receipts

The original `@qcommit/core` export, `src/protocol.mjs`, `docs/PROTOCOL.md` and
`cli/verify.py` retain the **preview-only** `Qcommit.LaunchPreview.v1` domain.
These files support existing off-chain receipts; those receipts are rejected by
the production launch program. To independently inspect the public example:

```sh
python3 cli/verify.py fixtures/orbital.receipt.json \
  --key "$(cat fixtures/creator-public-key.txt)"
```

This checks the preview signature and supplied key, and reports
`onchainVerified: false`. The fixture key is public test data. Obtain other
creators' fingerprints through a separate trusted channel.

## Repository map

| Path | Purpose |
| --- | --- |
| `programs/qcommit-launch/` | Solana program, proof staging and atomic token creation |
| `crates/launch-core/` | Binary protocol and account validation |
| `crates/slh-verify/` | Independent Rust SLH-DSA verifier |
| `sdk/` | Production approval codec, wallet-signed deployment, client, receipt verifier and CLI |
| `server/` | Restricted same-origin launch/operator RPC policies and mocked boundary tests |
| `src/vault.mjs` | Encrypted creator backups |
| `src/slh-verify.mjs` | Independent JavaScript signature verification |
| `src/protocol.mjs`, `cli/` | Historical preview protocol and independent Python verifier |
| `fixtures/`, `tests/`, `evidence/` | Published test vectors, execution checks and scoped receipts |
| `.github/workflows/check.yml` | Hosted checks; inspect each run's actual scope |

Version 1 deliberately has one lifetime creator key. Key rotation/recovery,
Token-2022, NFTs, bonding curves, liquidity creation and swaps are not included.
Proof-account rent is not automatically refunded; see the explicit close flow in
[the SDK guide](sdk/README.md). Metadata content hashes commit to bytes but do not
guarantee that an external URI stays available or serves those bytes.

Read [SECURITY.md](SECURITY.md) before handling keys. Contributions are described
in [CONTRIBUTING.md](CONTRIBUTING.md); original code is [MIT licensed](LICENSE).
Dependency licenses and vector provenance are in [THIRD_PARTY.md](THIRD_PARTY.md).
The package remains `private` to prevent accidental npm publication; the source
can be inspected and used from a checkout.
