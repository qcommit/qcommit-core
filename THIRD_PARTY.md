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
