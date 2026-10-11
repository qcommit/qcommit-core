# Program-enforced launch

The Qcommit launch program and production client are implemented. Actual local
validator execution covers creator activation, staged SLH-DSA verification,
atomic classic SPL token creation and independently checked execution receipts.
See [build instructions](BUILD.md) and the [operator deployment guide](MAINNET_DEPLOYMENT.md).
Public mainnet deployment and genuine Phantom-extension testing are pending;
local execution does not establish either.

## Two authorizations, two keys

The ordinary Solana funding wallet pays account rent and transaction fees. The
separate SLH-DSA creator key approves registration and token parameters. A funding
signature cannot replace a creator proof. Connecting a wallet requests no
signature; funding transactions require explicit approval.

Initialization binds a creator PDA to the exact payer, post-quantum public key,
network/deployment and public salt. It begins inactive. A domain-separated
registration proof must pass the on-chain verifier before activation. The default
public salt is deterministic and recoverable from the public identity inputs;
a custom salt must be retained with the registration configuration.

Version 1 uses one lifetime key and epoch zero. Rotation, recovery and arbitrary
creator-account replacement are not implemented. Losing the creator key prevents
future launches through that identity. This does not lock ordinary SPL tokens
already distributed to recipients.

## Production signature and replay domain

The complete [binary ABI](../sdk/ABI.md) uses canonical length-prefixed bytes and
pure SLH-DSA-SHA2-128s with context `Qcommit.Launch.v1`. The launch digest binds:

- Program ID, actual cluster genesis, nonzero deployment ID and protocol version.
- Creator PDA, epoch, monotonically consumed nonce and expiry slot.
- Exact funding payer, token program, deterministic mint and supply recipient.
- Name, symbol, decimals, integer base-unit supply, metadata URI and content hash.
- Fixed mint/no-freeze policies, execution-rent cap, zero platform fee and
  cumulative client-enforced network-fee cap.

Registration has a distinct digest domain and cannot authorize a launch. The
historical `Qcommit.LaunchPreview.v1` context and JSON preview receipts are also
rejected. Timestamps, UI labels and a supplied signature-valid flag are never
accepted as substitutes for the program's verification.

## Bounded proof accounts

A 7,856-byte signature cannot fit in a single legacy transaction. The SDK creates
an uploader-specific proof account and appends the exact signature plus complete
intent in bounded chunks. The program checks account owner, discriminator, PDA,
creator/uploader, payload length and exact next offset.

Sealing freezes the uploaded bytes. Subsequent instructions advance the actual
on-chain verifier through its stages; no off-chain success claim is trusted.
Verification progress remains bound to the exact creator, nonce, expiry, digest
and payload. An incomplete, corrupted, wrong-context or altered-intent proof
cannot authorize token creation.

## Atomic creation

The final program instruction checks expiry, nonce and the complete signed intent
again. In one Solana transaction it creates:

1. The deterministic classic SPL mint.
2. The recipient's canonical associated token account and full initial supply.
3. Immutable Metaplex metadata matching the approved name, symbol and URI.
4. An immutable record of exact intent bytes and execution slot.

Mint authority is revoked, freeze authority is absent, and the creator nonce is
consumed only with successful execution. The execution cap includes account rent
and Metaplex's creation fee. A rejected CPI or final cost check rolls back the
mint, account allocation, record and nonce; transaction fees already charged by
the network are not rolled back.

Token-2022, NFTs, trading, bonding curves, liquidity and swaps are outside this
profile. Holder transfers use ordinary SPL authorization; the post-quantum proof
protects the creator's launch approval, not every subsequent token transfer.

## Deployment and transaction client

`openNetwork` verifies actual genesis, executable/loader ownership, binary length
and SHA-256, upgrade authority and on-chain configuration. Public modes require
HTTPS RPC and finalized evidence. Mainnet mode requires an immutable program;
an upgradeable deployment is rejected there.

The client checks the funding wallet's signed message against the exact unsigned
message, verifies ordinary signatures, simulates before submission and confirms
actual execution. It records a locally derived transaction signature before
broadcast. Unknown acknowledgement/confirmation raises `SubmissionUncertain`;
it does not silently sign a replacement.

Resume requires matching proof-header fields and every previously uploaded byte.
The same signed approval must be retained: a newly randomized signature over the
same intent is different proof content. Prior fees are reconstructed from
confirmed history before continuing the cumulative budget. Missing history or an
inconsistent consumed nonce fails closed. A completed launch can be recovered by
checking its immutable record and original confirmed transaction.

Proof-account rent is paid separately before atomic execution. It is not
refunded automatically. The exact uploader can deliberately close a proof with
an additional approved transaction; doing so abandons any unfinished verification.
Keep the complete authorization and execution receipt first.

## Independent execution receipt

Production authorizations use `qcommit/launch-authorization/2`; execution receipts
use `qcommit/launch-execution/1`. The receipt verifier independently checks:

- The actual post-quantum signature and optional independently obtained creator pin.
- The configured program/deployment and cluster, required confirmation, transaction
  success, exact top-level instruction and ordered accounts.
- Creator registration and consumed nonce, immutable intent record and slot.
- Classic SPL mint/authorities, original transaction's exact initial distribution,
  and immutable Metaplex metadata.

Signature validity, human creator trust and confirmed execution are separate
results. An explorer link alone proves none of them. Current balances can change,
tokens can be burned, and a recipient account can close after launch; original
allocation is checked from confirmed transaction history rather than assumed from
its current balance. Remote metadata availability/content is not fetched or
proven by this verifier. RPC responses remain a trust boundary; this is not a
light-client state proof.

## Executed evidence and remaining release work

[The current local receipt](../evidence/onchain-localnet.json) records 204 actual
transactions, 28 checks, two successful launches and 24 expected rejected
transactions on an isolated validator. It includes initialization front-running,
account substitution, wrong uploader/offset, incomplete proof, corrupted
signature, altered intent, historical preview-context rejection, replay, final
expiry and failed-CPI rollback. The matching test and source versions must be
inspected when reproducing or extending this evidence.

A live mainnet claim still requires an actual published immutable deployment,
public-network execution receipts, genuine wallet-extension acceptance and the
associated operational/key-handling review. Independent security review remains
outstanding. These are explicit release gaps; they do not erase the implemented
and executed local program.
