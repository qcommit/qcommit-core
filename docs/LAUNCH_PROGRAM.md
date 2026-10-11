# Program-enforced launch: integration requirements

The current Qcommit launchpad uses **Meteora DBC execution with a separately
verified creator receipt**. That path does not require deploying a custom Qcommit
program. See [METEORA_LAUNCH.md](METEORA_LAUNCH.md) for its implemented format,
wallet flow and executed evidence.

This document specifies a different architecture in which a launch program
itself enforces the post-quantum authorization. A valid off-chain receipt does
not establish that an external program performed those checks. The historical
`Qcommit.LaunchPreview.v1` fixture and the Meteora receipt domain must not be
accepted as authorizations for such a custom program.

## Program-enforced architecture

A funding wallet pays costs, a reusable creator key signs the exact commitment,
and the program verifies the creator's registered key, nonce and signature
before atomically creating the token. This architecture adds requirements
beyond the current Meteora receipt route.

## Required production authorization

Design and freeze a binary, length-prefixed ABI before program implementation.
Bind the program ID, actual cluster genesis domain, protocol version, creator PDA,
creator key epoch, monotonic creator nonce, expiry slot, token-program ID, mint
address, supply recipient, exact name/symbol/decimals/base-unit supply, metadata
URI and immutable content hash, mint/freeze policy, and explicit fee/rent bounds.
Use a production-only signature context that is distinct from the preview.

The funding payer must be either exactly bound or governed by an explicitly signed
sponsorship policy. A conventional funding-wallet signature is not creator
approval. Connecting a wallet must not trigger message or transaction signing.

## Program responsibilities

The creator PDA must commit to its initial post-quantum key without allowing an
initialization front-run to substitute authority. Re-registration, key rotation,
recovery and close semantics require separate policy and replay tests. Store
nothing that treats a display name as authenticated human identity.

Stage 7,856-byte signatures in bounded, uploader-isolated accounts. Check ownership,
discriminator, canonical PDA seeds, exact lengths, offsets and immutability after
sealing. The program must compute verification roots itself; it must never accept
an off-chain claim of successful verification. Meter staged verification and keep
progress bound to the exact creator, epoch, nonce and launch digest.

After the final signature/root/quorum checks, perform the SPL token initialization,
initial distribution and authority changes in one atomic program execution. Check
all supplied accounts, token program, privileges, fee destination and exact signed
arguments. On error, no mint/authority change or consumed nonce should survive.
Document which token metadata standard is actually supported. Do not advertise
Token-2022, NFTs, bonding curves, liquidity creation or swaps without implementation.

Publish program source, reproducible build instructions, deployment ID, deployed
binary hash and upgrade policy. Mutable upgrade authority can bypass creator
signature checks. Immutability has irreversible recovery/upgrade trade-offs.

## Independent execution receipt

Keep creator authorization and chain execution evidence as distinct artifacts.
The verifier must pin the expected cluster and program, confirm transaction success
at the required commitment, decode the exact program instruction/event, and check
mint address, token program, supply recipient and authority state. An explorer
link or a transaction signature alone is not proof that the intended program
checked a post-quantum signature. RPC evidence still has a trust boundary unless
a light-client/state-proof design is actually implemented.

## Release gates

Published vectors across the chosen profile, cross-implementation tests, malformed
and tampered inputs, replay and account-substitution attacks, upload races,
failed-CPI rollback, interrupted submission recovery, measured compute/size/rent
costs, private-key handling review and independent security review. Test on a
local validator, then devnet, before discussing funded mainnet use.
