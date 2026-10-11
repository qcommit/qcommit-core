# Qcommit launch program v1

Authoritative integers/layouts: `crates/launch-core/src/lib.rs`. All integers are
little-endian. Strings are UTF-8 with a u16 byte-length, no normalization. Unknown
tags, trailing bytes, unsupported policy, and oversized fields are rejected.

## Accounts

- Config PDA `["config"]`: 105 bytes, magic `QCCONF01`, bump u8, genesis[32],
  deployment[32], bootstrap_authority[32]. Immutable after initialization.
- Creator PDA `["creator", id]`: 178 bytes, magic `QCCREA01`, bump u8,
  config/id/payer/key/salt each [32], nonce u64, active bool.
- Creator ID = SHA256(`Qcommit.Creator.v1\0` || genesis || deployment ||
  funding payer || initial post-quantum public key || salt).
- Proof PDA `["proof", creator, digest, uploader]`: 8,811 bytes. Header187:
  magic `QCPROF01`, bump u8, creator/uploader/digest/key each [32], kind u8,
  nonce u64, expiry u64, intent_len u16, uploaded u16, stage u8, root[16],
  tree u64, leaf u32. Payload7856-byte signature then intent (maximum768),
  unused bytes zero. Kind0 is registration, kind1 launch.
- Mint PDA `["mint", creator, nonce_le8]`, classic SPL Token owner82 bytes.
- Record PDA `["launch", creator, nonce_le8]`, 1536 bytes. Borsh prefix:
  magic `QCLAUN01`, bump, creator[32], nonce u64, digest/mint/recipient/ATA/
  metadata each[32], slot u64, payer[32], intent Vec<u8> (u32 length); zero tail.
  There is no mutation or closure instruction for config/creator/record.

## Instructions

`S` signer, `W` writable; omitted flags read-only.

| Tag | Arguments | Account order |
|---|---|---|
|0|genesis32 deployment32|payer(SW), config(W), executing program, canonical programdata, system|
|1|key32 salt32|config, creator(W), payer(SW), system|
|2|kind u8, nonce u64, expiry u64, digest32, intent_len u16|config, creator, proof(W), uploader(SW), system|
|3|offset u16, chunk1..700 bytes|creator, proof(W), uploader(S)|
|4|none|creator, proof(W), uploader(S)|
|5|none|creator, proof(W)|
|6|none|config, creator(W), proof, payer(S)|
|7|none|config, creator(W), proof, payer(SW), mint(W), recipient, ATA(W), metadata(W), record(W), system, classic token, ATA program, Metaplex, rent|
|8|none|proof(W), uploader(SW)|

Sealing requires all signature+intent bytes, closes upload permanently, parses
intent, and recomputes digest. Eight steps start FORS then recover seven XMSS
roots; only stage9 with final PK.root equality is authorization. Verification
progress is entirely program-owned. Registration activation requires completed
kind0 proof; it leaves nonce0 ready for the first launch. Execute rechecks slot,
creator nonce, entire domain and digest before all CPIs. Expiry is inclusive:
execution at `expiry` is allowed, at `expiry + 1` rejected. Failed transactions
roll back state, nonce and every CPI. Close refunds proof rent to exact uploader;
uploader may abandon a proof at any phase, but this cannot mutate a launch record.

## Signatures

SLH-DSA-SHA2-128s external pure mode context: ASCII `Qcommit.Launch.v1`.
Signed message is a32-byte digest. Preview statement signatures never authorize
these instructions.

Registration digest = SHA256(`Qcommit.Register.v1\0` || program32 || genesis32 ||
deployment32 || creator32 || key32 || creator_payer32 || zero_nonce_le8 || expiry_le8).
Launch digest = SHA256(`Qcommit.LaunchIntent.v1\0` || canonical intent bytes).

Intent bytes: `QCLNCH01`, program/genesis/deployment/creator each32, epoch/nonce/
expiry each u64, token_program/mint/recipient/payer each32, decimals u8,
supply/max_execution_rent/platform_fee/max_network_fee each u64, name max32,
symbol max10, URI max200 (each u16 length+UTF8), content_hash32,
mint_policy u8, freeze_policy u8. Epoch, platform_fee, mint_policy and
freeze_policy must be0. Decimals0..9, supply>0. URI uses https/ipfs/ar.
Human labels are signed claims, not verified human identity. Content hash is
signed; the on-chain program cannot fetch URI bytes to validate their hash.

## Exact token behavior

Creates one classic SPL mint, canonical recipient associated account, Metaplex
CreateMetadataAccountV3 DataV2 with exact name/symbol/URI, zero seller fee, no
creators/collection/uses, `is_mutable=false`, update authority creator PDA. Mints
full signed supply to recipient ATA and permanently removes mint authority.
Freeze authority is absent from initialization. Metadata standard is Metaplex;
Token2022, NFTs, liquidity/bonding curves and swaps are not supported by v1.

`max_execution_rent` caps the funding payer's observed lamport decrease across
this execution, including mint/ATA/metadata/record allocation. No Qcommit platform fee is
charged. Metaplex charges its own creation levy in addition to metadata account
rent; this is included in the observed payer decrease and execution cap. The
currently referenced Metaplex formula is rent.minimum_balance(1308) + 5440
lamports (10,000,000 lamports under standard rent). Clients must quote that
external fee explicitly; it is not refundable proof-account rent. Creator/proof account rents occur in distinct user-approved instructions;
they are not part of this execution-only rent cap. `max_network_fee` is signed and
SDK-enforced for submitted transaction fees; the program cannot observe fees
paid in previous transactions. Clients must display those separate costs.

## Authority and chain domain

Solana programs cannot read a genesis hash from a runtime syscall. Initial config
therefore requires the exact executing upgradeable-loader program and canonical
programdata account, and its current upgrade authority must sign. That authority
pins the externally checked genesis and a unique deployment32 one time. Clients
must independently compare actual RPC genesis, config, and expected deployment;
an arbitrary RPC-supplied config does not establish trust. The bootstrap authority
cannot change config through this program after creation.

An upgrade authority can replace all program rules. Production release must
publish the exact binary and choose a documented upgrade policy; an immutable
program cannot be repaired after authority removal. Current authority/code checks
belong to client deployment verification as well as release evidence. Classic
SPL/ATA/Metaplex program IDs are fixed, and their deployment trust is external.
No registration rotation, recovery, or migration is exposed in v1; losing the
post-quantum secret permanently prevents future launches under that identity.

The v1 creator identity keeps its original funding-payer address for all launches.
The launch intent, proof uploader, and stored creator payer must agree. A different
funding wallet requires a separately registered identity; sponsorship is not exposed.

Text validation is shared with the SDK; see `../../sdk/ABI.md` and the165-case
`../../sdk/tests/launch-text-corpus.json`. URI parsing uses the bounded ASCII
grammar in both implementations, without platform URL normalization or fetching.
C0/C1 controls and edge whitespace (Unicode White_Space plus U+FEFF) are rejected.
