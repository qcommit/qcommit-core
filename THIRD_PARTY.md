# Dependencies and provenance

The signing integration targets `@noble/post-quantum` 0.7.1 (MIT, Paul Miller),
whose declared dependencies are `@noble/hashes`, `@noble/curves`, and
`@noble/ciphers` 2.4.0 (MIT). These packages are not vendored in this source
archive. The website prepare script copies their licenses and records original
and transformed module hashes when matching installed packages are supplied.
Only bare package import paths are rewritten for same-origin static serving.

The verifier implementations in this project are original verify-only code.
The included receipt was generated with local OpenSSL 3.5.5; OpenSSL is not a
runtime dependency of the native verifier. See fixture provenance for its
checksum and scope. Selected official NIST external-pure SHA2-128s sigVer cases and sigGen outputs are included under fixtures/nist. Their exact upstream commit, file/subset hashes and license notice are retained. No complete corpus or certification is claimed.

References:
- https://csrc.nist.gov/pubs/fips/205/final
- https://github.com/paulmillr/noble-post-quantum/tree/a23736036d4d5b34dd3a9e0ee312fd43d00154ac
- https://wallet-standard.github.io/wallet-standard/

No PaperFills website or extension source has been copied. Only its publicly
accessible privacy repository was available earlier as a product-separation
reference; its existence does not license unrelated source code.

## On-chain and transport additions

The Rust verifier was copied from the MIT-licensed Quantum Seal Wallet
implementation, with its original license and exact source hash retained in
`crates/slh-verify/LICENSE` and `crates/slh-verify/PROVENANCE.json`. Adapted SDK
files retain their Quantum Seal attribution. Original Qcommit additions remain
MIT licensed; this does not relicense dependencies.

The production SDK pins `@solana/web3.js` 1.98.4 (MIT). Its locked transitive
dependency `rpc-websockets` 9.3.9 is **LGPL-3.0-only**, not MIT. Its publisher
notice and the GNU LGPLv3/GPLv3 texts are retained under `licenses/`. The website
preparation includes unchanged dependency source, source maps, notices and
rebuild instructions so recipients can inspect and rebuild the browser bundle
with a modified library. No additional restrictions on library debugging or
replacement are imposed by Qcommit.

`eyes` 0.1.8 declares MIT in its older `licenses` field. The text-encoding-utf-8
1.0.2 package contains a public-domain/Unlicense-style notice and acknowledges
material derived from the WHATWG Encoding Standard. Their shipped notices are
retained under `licenses/`; absent modern npm `license` metadata was not treated
as permission. `buffer` 6.0.3 is MIT and esbuild 0.28.2 is MIT. Exact resolved
versions, URLs and integrity values are recorded in `package-lock.json`.

Rust dependencies and exact versions are in `Cargo.lock`. Solana crates primarily
declare Apache-2.0; SHA-2, Borsh and other packages declare their own permissive
licenses, including dual-license choices. Consult their individual notices when
redistributing compiled artifacts. Native metadata review is not a replacement
for including required third-party notices with a binary release.

The local validator uses a separately retrieved canonical Metaplex executable.
It is not distributed in this source tree or represented as Qcommit-authored
MIT code. `scripts/fetch-metadata-fixture.mjs` retrieves its exact public
finalized account bytes read-only and checks the tested hash. The container
seccomp profile includes its separate Moby notice in `licenses/moby-profiles.txt`.
