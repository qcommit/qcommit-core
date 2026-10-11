# Program-enforced launch SDK

This SDK targets the Qcommit Solana launch program. It uses a separate binary ABI and signature context from the older preview authorization protocol. Preview receipts are rejected.

```js
import {
  openNetwork, prepareRegistration, registerCreator,
  prepareLaunch, executeLaunch, verifyExecution
} from '@qcommit/core/launch';
```

`openNetwork(configuration)` reads the actual RPC genesis, deployed executable, loader state and upgrade authority. `mainnet-beta` mode requires a pinned immutable program. A JSON configuration alone is never accepted as proof that a deployment exists. Before signing and before every submitted instruction, the client rereads the deployment and its immutable configuration.

## Funding wallet interface

A wallet is `{ publicKey, async signTransaction(transaction) }`. `publicKey` may be a canonical base58 string or web3.js `PublicKey`. The signer returns either the signed legacy `Transaction` or its serialized `Uint8Array`. Phantom and Wallet Standard can be adapted to this interface. The SDK checks that the wallet did not change the approved message and verifies its ordinary transaction signature before broadcasting. A Node `Keypair` is also supported for explicit local/operator scripts.

Connecting a wallet does not sign anything. No local default wallet path is read. Public RPC endpoints require HTTPS; localnet permits literal HTTP loopback only.

## Creator registration

```js
const prepared = await prepareRegistration(network, {
  payer: wallet.publicKey,
  creatorPublicKey: publicKeyHex,
});
// Show prepared.registration and prepared.estimate before requesting approval.
const signature = slh.sign(prepared.digest, creatorSecret, {
  context: new TextEncoder().encode(prepared.context),
});
const registered = await registerCreator(network, {
  registration: prepared.registration, signature, payer: wallet,
  maxRentLamports: '100000000', maxFeeLamports: '10000000',
  onRecord: saveTransactionJournal,
});
```

The creator PDA binds the payer, post-quantum public key, deployment and public salt. The default salt is deterministically derived from the same public identity/network inputs and does not require an additional secret backup. Caller-supplied salts are supported and must be retained with the public registration configuration. Initializing the address leaves it inactive; an on-chain SLH-DSA registration proof is required before activation. Version 1 has a single lifetime key and no rotation/recovery mechanism.

## Prepare and execute a launch

```js
const prepared = await prepareLaunch(network, {
  payer: wallet.publicKey,
  creatorPublicKey: publicKeyHex,
  name: 'Example Token', symbol: 'EXAMPLE',
  metadataUri: 'https://example.org/token.json',
  metadataSha256: exactMetadataBytesSha256,
  decimals: 6, supplyBaseUnits: '1000000000000',
  recipient: wallet.publicKey,
  maxRentLamports: '100000000', maxFeeLamports: '10000000',
});
// Show prepared.intent and prepared.estimate before requesting approval.
const signature = slh.sign(prepared.digest, creatorSecret, {
  context: new TextEncoder().encode(prepared.context),
});
const receipt = await executeLaunch(network, {
  intent: prepared.intent, signature,
  creatorPublicKey: publicKeyHex, payer: wallet,
  onProgress: showProgress, onRecord: saveTransactionJournal,
});
```

The signed intent includes the actual genesis and deployment ID, creator address/epoch/nonce, expiry slot, payer, recipient, canonical mint, token program, exact supply, decimals, immutable metadata, authority policies, execution-rent cap and cumulative network-fee cap. Platform fees are zero in this profile. The content hash commits to metadata bytes; neither the Solana runtime nor this SDK fetches the URI or proves a remote server continues serving those bytes.

`maxRentLamports` becomes `intent.maxExecutionRent` and covers the mint, token account, metadata and launch record allocated by atomic execution. The cap also includes the Metaplex protocol creation fee (estimated from RPC rent for1,308 bytes plus5,440 lamports; exposed as `metadataFeeLamports`). The proof account is separately rented before execution and its exact estimated amount is shown as `estimate.proofRentLamports`; `estimate.rentLamports` includes both. Prior proof-transaction fees are recovered from confirmed RPC history before resuming, so restarting the process does not reset the signed network-fee budget. RPC trust and incomplete/pruned history remain explicit limitations: missing history prevents a resume.

The SDK sequentially creates a proof account, uploads exact signature plus intent bytes, seals the immutable payload, advances the on-chain verifier, and submits one atomic token-creation instruction. The final transaction creates a classic SPL fixed-supply mint, distributes all units to the canonical recipient ATA, revokes mint authority, leaves no freeze authority, creates immutable Metaplex metadata, records exact approved bytes and consumes the nonce.

The funding wallet approves multiple ordinary transactions because the SLH-DSA signature is 7,856 bytes. No claim is made that this is a single Phantom approval.

## Retry and interruption behavior

Uploads resume only when every already-uploaded byte and all proof-header fields match the exact approval. A sealed proof cannot be rewritten. Expired or consumed authorizations fail closed. Unknown RPC acknowledgements raise `SubmissionUncertain` carrying the locally derived transaction signature; no replacement transaction is signed automatically. Save every `onRecord` entry before it returns.

Rerunning `executeLaunch` after successful execution checks the immutable record and finds/verifies its original confirmed transaction instead of launching again. A different consumed nonce or unavailable confirmed history does not produce a success receipt.

## Independent confirmation

```js
await verifyExecution(network, {
  authorization: receipt.authorization,
  transactionSignature: receipt.confirmation.transactionSignature,
  expectedCreatorFingerprint: previouslyTrustedFingerprint, // optional
});
```

This independently rechecks the post-quantum signature, deployment/genesis, transaction success and required commitment, exact top-level launch instruction/accounts, immutable record bytes, creator key and consumed nonce, token program/mint authorities, original post-transaction distribution, and immutable metadata. Public networks require finalized RPC results. Signature validity, creator trust and on-chain confirmation remain separate: a valid signature does not authenticate a human creator.

The evidence uses RPC transaction/account responses, not a cryptographic light-client state proof. Current supply may be lower because holders can burn tokens; the receipt proves the original full distribution from the confirmed transaction. Current recipient balances and account closure are reported separately from the original confirmed distribution.

## CLI

`node sdk/cli.mjs help` lists exact commands. Requests and signatures can be moved between online and offline machines. Output files are created exclusively and never overwrite existing approvals or journals. The signing CLI only reads a creator secret after opening an explicitly supplied encrypted vault and owner-only passphrase file; the transaction CLI only reads an explicitly supplied owner-only funding keypair file with `--submit`.

The live network configuration must be produced from an actual deployment. No mainnet address or successful mainnet launch is invented by this SDK.

### Offline creator backup creation

Create an owner-only passphrase file using your local password manager or editor (at least12 characters, exactly as entered, without an accidental trailing newline). Then:

```sh
node sdk/cli.mjs create-identity --label "My creator" \
  --passphrase-file /explicit/private/passphrase-file \
  --out creator.vault.json
```

This generates the SLH-DSA key locally and saves only the password-encrypted vault. Keep a separate protected backup. It does not register an on-chain account or submit a transaction. Use `prepare-register`, move the exact request to the offline signer, run `sign`, then move its public signed approval to the machine running `register --submit`. Repeat the prepare/sign/submit split for launch. Your normal funding-wallet signing key is separate from this creator vault.

### Reclaim proof-account rent

Registration and launch leave their proof accounts allocated; **refund is not automatic**. After saving the complete authorization and confirmed receipt, the exact uploader can reclaim the proof's lamports using exported `closeProofInstruction({program,proof,uploader})` and an explicitly approved `submitNetwork` call. The close operation itself costs a network fee. Closing a proof does not erase the immutable launch record or downloaded signature. It prevents continuing an unfinished proof, so finish or deliberately abandon that authorization before closing.
