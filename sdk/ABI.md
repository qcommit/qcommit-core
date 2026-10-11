# Qcommit launch ABI v1

All integers are unsigned little-endian. Addresses, genesis hashes, content hashes and key material are raw32-byte values; JSON uses canonical base58 for addresses and lowercase hex for hashes/SLH keys. Strings are length-prefixed UTF-8 with u16 length; parsers reject trailing bytes. `sdk/tests/launch-intent-vector.json` is the cross-language deterministic vector.

SLH-DSA profile: SHA2-128s,7,856-byte signatures,32-byte public keys. Pure signature context: ASCII `Qcommit.Launch.v1`. The message signed is the32-byte domain-separated digest. Never manually prepend the FIPS message/context framing when using the public Noble API.

## Signed launch

Fields in order:

```
QCLNCH01 (8 ASCII bytes)
program, genesis, deploymentId, creator (32 bytes each)
epoch, nonce, expirySlot (u64 each)
tokenProgram, mint, recipient, payer (32 bytes each)
decimals (u8)
supplyBaseUnits, maxExecutionRent, platformFee, maxNetworkFee (u64 each)
name (u16 + <=32 UTF8 bytes)
symbol (u16 + <=10 UTF8 bytes)
metadataUri (u16 + <=200 UTF8 bytes)
metadataSha256 (32 bytes)
mintPolicy (u8=0 fixed), freezePolicy (u8=0 none)
```

Digest is SHA256(`Qcommit.LaunchIntent.v1\0` || encoded intent). Maximum768 bytes. Epoch and platform fee are zero in version1. The client enforces cumulative prior and new network fees; the on-chain program cannot retroactively cap fees charged by earlier transactions. Execution rent is enforced on-chain.

Registration digest is SHA256(`Qcommit.Register.v1\0` || program || genesis || deploymentId || creator || key || payer || nonce0:u64 || expirySlot:u64), with the same production signature context. Domain separation prevents a registration proof from authorizing a launch.

## Addresses

- Config PDA: `["config"]`.
- Creator ID: SHA256(`Qcommit.Creator.v1\0` || genesis || deploymentId || payer || key || salt); creator PDA: `["creator",id]`.
- Proof PDA: `["proof",creator,digest,uploader]`.
- Mint PDA: `["mint",creator,nonceLE8]`.
- Record PDA: `["launch",creator,nonceLE8]`.
- Recipient ATA: canonical associated-token PDA for recipient/classic-token-program/mint.
- Metadata: canonical Metaplex metadata PDA.

## Instructions

| Tag | Operation | Data after tag |
|---|---|---|
|0|Initialize config|genesis32,deploymentId32|
|1|Initialize inactive creator|key32,salt32|
|2|Begin proof|kind:u8,nonce:u64,expiry:u64,digest32,intentLength:u16|
|3|Append proof|offset:u16,1..700 bytes|
|4|Seal proof|none|
|5|Advance proof verification|none|
|6|Activate creator|none|
|7|Atomic launch|none; reads frozen proof intent|
|8|Close proof to uploader|none|

Proof payload is the signature followed by the complete launch intent. Registration kind0 has no intent bytes; launch kind1 requires1..768. Header187 bytes, signature7,856, intent reserve768: total8,811. This avoids exceeding Solana's legacy transaction size limit in atomic execution. Exact ordered account metas are defined in `instructions.mjs` and mirrored by the program.

Config is105 bytes; creator178; immutable launch record1,536 with a Borsh record prefix and zero trailing padding. See strict decoders in `codec.mjs` and Rust structs in `crates/launch-core`.

The SDK and Rust program use the same bounded URI grammar, covered by
`tests/launch-text-corpus.json`: maximum200 printable ASCII characters from the
RFC3986 URI character set, valid `%HH` escapes, exact lowercase `https://`,
`ipfs://`, or `ar://` scheme. HTTPS accepts DNS labels (1..63 alphanumeric/hyphen
characters; no edge hyphens), canonical dotted-decimal IPv4, optional trailing DNS
dot, and optional canonical decimal port1..65535. IPv6, credentials, noncanonical
numeric host forms, and literal Unicode are rejected; use punycode hostnames and
percent-encoded Unicode paths. IPFS/Arweave require a nonempty unreserved-character
identifier; this syntax check does not validate a CID or transaction's existence.
Paths, dot segments, query, fragments, and escape casing are signed verbatim;
neither implementation normalizes or fetches the URI.

All strings reject C0/C1 controls. Name edge whitespace is Unicode White_Space
plus U+FEFF, matching SDK trim behavior after control rejection. UTF-8 decoding
preserves BOM bytes instead of silently stripping them. Internal permitted Unicode
is preserved exactly; symbol is uppercase ASCII letters/digits.
