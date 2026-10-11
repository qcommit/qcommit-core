# Build and reproduce

The source has separate offline cryptography, native program, and actual Solana
validator checks. A passing offline suite alone does not establish a deployment.

## Toolchain

- Node 22.22.0 or later supported Node 22; Python 3.11 or later.
- Rust 1.89 or later for native tests; locked workspace dependencies.
- Agave/Solana CLI and `cargo-build-sbf` 3.1.10.
- SBF platform-tools v1.52 / its Rust 1.89.0 compiler.

The initial local native test run used host Rust 1.99.0. The on-chain binary used
the separate SBF compiler above. Record actual versions with each release.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:signing
npm run test:vectors
npm run test:mutations
npm run test:sdk
node --test server/tests/*.test.mjs
node sdk/tests/cli-identity.integration.mjs
bash scripts/build-onchain.sh
```

The build writes `target/deploy/qcommit_launch.so`. Both Cargo operations use the
lockfile. If your CLI installation uses a nonstandard SDK location, set
`SBF_SDK_PATH` explicitly. No default Solana wallet is used by this build.
The generated program keypair under `target/` is ignored; it is not a deployment
identity or funding authorization. Do not commit it.

## Local validator integration

`tests/onchain-localnet.mjs` executes real transactions using synthetic keys and
genesis funds. It requires a fresh isolated local validator with this program,
classic SPL Token, Associated Token Account, and canonical Metaplex Token
Metadata deployed. The metadata fixture can be obtained read-only:

```sh
node scripts/fetch-metadata-fixture.mjs .runtime/program-fixtures
```

The fetcher verifies mainnet genesis, canonical ProgramData, immutable authority,
exact size and the pinned SHA-256. It refuses changed bytes and existing output.
The external binary is not included in this repository or licensed as Qcommit.

`scripts/test-onchain.sh` is the bounded runner used on the development host. It
currently expects the documented locally cached `quantum-seal-localnet:0.1.0`
container image and installed tool paths; it is not a claim of a portable Docker
image published by this repository. Inspect and adapt the runner paths to your
own tool installation. It starts only its own network-isolated validator,
generates synthetic local keys, and removes its owned container when finished.
It does not connect tests to mainnet or read an existing funding wallet.

The committed `evidence/onchain-localnet.json` records the actual tested program
hash and transactions. Any program change requires a fresh build and integration
receipt; an old hash must not be relabeled as evidence for new code.

## Deployed-byte verification

The current candidate was rebuilt in a separate source directory with an empty
Cargo target directory on the same host; its 168,568 bytes matched exactly.
See [the reproducibility receipt](../evidence/sbf-reproducibility.json). This is
not a claim of reproduction by a separate operator or machine.

Before enabling a public network, compare a clean build to the reviewed artifact
and compare the deployed ProgramData bytes to that artifact. SDK network opening
checks the configured SHA-256, byte length, zero-only allocation padding, loader,
genesis and upgrade authority. These checks bind a particular binary; they do
not replace independent source/security review or prove every possible behavior.
