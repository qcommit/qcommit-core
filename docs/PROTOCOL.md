# Preview authorization v1

This is intentionally **not a transaction-signing ABI for Solana**. Production
programs must reject this preview context and scope.

## Exact field order

The normalized intent has exactly these members, in this order:

```text
version, scope, network, creatorPublicKey, creatorLabel, fundingWallet,
launchId, name, symbol, description, metadataUri, metadataSha256, decimals,
supply, recipient, mintAuthority, freezeAuthority, issuedAt, expiresAt
```

`version` is the integer 1. `scope` is `preview-only`. `network` is
`solana:devnet` or `solana:mainnet`; it is a signed domain label, not proof of an
RPC connection. Public keys, identifiers and hashes use lowercase hexadecimal.
Funding/recipient addresses use base58 encodings of exactly 32 bytes.

`name` and `creatorLabel` are nonempty UTF-8 text, limited to 32 and 80 bytes.
The symbol is 1–10 uppercase ASCII letters/digits. Description is at most 400
UTF-8 bytes. Control characters and lone UTF-16 surrogates are forbidden. There
is no Unicode normalization or whitespace trimming of signed values.

`metadataUri` is empty or an HTTPS/IPFS/Arweave URI of at most 200 UTF-8 bytes,
without URL credentials. The preview does not fetch it. `metadataSha256` is null
or an explicit 32-byte lowercase hexadecimal hash. A null hash does not commit
to the contents that a mutable URI may later serve.

Decimals are integers 0–9. Supply is a positive canonical decimal **string** of
whole tokens, with `supply * 10^decimals <= 2^64 - 1`. No floating-point arithmetic,
rounding, exponent notation or leading zeroes are accepted. Mint authority is
`revoke` and freeze authority is `none` in this one fixed-supply preview profile.
These describe approved intent, not authority changes that actually occurred.

Times are canonical UTC timestamps with millisecond precision and a trailing Z.
The signed lifetime is 1 minute to 24 hours. Local clocks determine displayed
expiry; there is no trusted timestamp service or on-chain slot check.

## Signed message

```text
normalized = UTF8(JSON.stringify(intent_in_the_fixed_order))
message    = SHA256(UTF8("Qcommit/LaunchPreview/v1\0") || normalized)
context    = UTF8("Qcommit.LaunchPreview.v1")
signature  = pure SLH-DSA-SHA2-128s(message, context)
```

The outer receipt has exactly `format`, `algorithm`, `context`, `intent`, and
`signature`. Format is `qcommit/launch-authorization/1`. The signature is 7,856
bytes, encoded as canonical padded base64. Unknown/duplicate keys and receipts
larger than 32 KiB are rejected. Transport member ordering is irrelevant because
the normalized intent order is fixed before hashing.

## Separate outputs

`signatureValid`: mathematical signature check.
`identityMatch`: true/false for a separately supplied pin; null with no pin.
`identityTrusted`: true only when the signature is valid and the pin matches.
`authorizationExpired` and `issuedInFuture`: local-clock checks.
`onchainVerified`: always false in this profile.

Creator fingerprint:

```text
SHA256(UTF8("Qcommit/Creator/v1\0") || raw_public_key[32])
```

This fingerprint is not a Solana wallet address or an on-chain creator PDA.

## Independent verification

`src/slh-verify.mjs` reconstructs FORS and seven XMSS layer roots using WebCrypto
SHA-256. `cli/slh_verify.py` implements the same primitive independently with
Python's standard library. Neither calls the Noble signing implementation.
Neither constitutes independent implementation of the underlying SHA-256
primitive itself. Trace output contains public intermediates only.

## Portable URI and time validation

Both verifiers accept absolute HTTPS/IPFS/Arweave URIs with nonempty authority,
without ASCII spaces, backslashes or credentials. HTTPS hostnames use ASCII DNS
labels (punycode supported), optional trailing dot and port1–65535. IPFS/Arweave
authorities use ASCII letters, digits, dot, underscore or hyphen. Unicode paths
are preserved exactly; IPv6 literals and Unicode hostnames are not supported.
Canonical timestamps require years1000–9999. Required-text whitespace follows
the JavaScript trim character set in both implementations. These lexical checks
do not resolve a URI, authenticate its contents or establish trusted time.
