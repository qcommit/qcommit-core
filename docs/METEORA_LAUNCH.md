# Meteora launches and post-quantum creator receipts

Qcommit's launchpad uses the existing Solana mainnet Meteora Dynamic Bonding
Curve program. A connected Phantom wallet approves the transaction and pays
its account and network costs. The browser generates a fresh token mint signer;
the server prepares the exact transaction, checks the completed signatures,
submits those same bytes, and checks the confirmed transaction and pool identity.

The current SOL profile creates a fixed supply of 1,000,000,000 tokens with six
decimals. The inherited trading fee is 2%. The launch review shows the token,
supply, estimated setup cost, network fee and creator-signature choice. Detailed
configuration addresses belong in inspectable receipts and technical material.

## Creator signature

“Qcommit’s creator signature will accompany the launch receipt” describes an
optional **SLH-DSA-SHA2-128s** commitment signed locally with a reusable creator
key. It does not describe a replacement for Phantom's ordinary Solana signature.
Meteora does not verify or enforce that post-quantum signature on chain.

The signing context is `Qcommit.MeteoraLaunch.v1`. The application message is
SHA-256 of UTF-8 JSON containing the following fields in this exact order:

```text
network, genesis, config, mint, pool, owner,
name, symbol, metadataSha256, messageSha256
```

`network` is `mainnet-beta`; `genesis` is the actual mainnet genesis hash.
`metadataSha256` hashes the exact stored metadata JSON. `messageSha256` hashes
the serialized Solana transaction message, including its recent blockhash.
The creator public key and signature are lowercase hexadecimal: 32 bytes and
7,856 bytes respectively. This is pure SLH-DSA signing an application digest,
not the standardized HashSLH-DSA interface.

The receipt format is `qcommit/meteora-launch-receipt/1`. Its fields are
`format`, `name`, `symbol`, `mint`, `pool`, `creatorProof`, and `confirmation`.
A launch without the optional creator signature has `creatorProof: null` and
must not receive a valid post-quantum signature badge.

## Sign and verify with the open core

```js
import { slh_dsa_sha2_128s as slh } from '@noble/post-quantum/slh-dsa.js';
import {
  METEORA_CONTEXT, meteoraIntentDigest,
  makeMeteoraProof, verifyMeteoraReceipt
} from '@qcommit/core/meteora';

const keys = slh.keygen();
try {
  // intent contains all ten fields from the exact prepared launch.
  const signature = slh.sign(await meteoraIntentDigest(intent), keys.secretKey, {
    context: new TextEncoder().encode(METEORA_CONTEXT)
  });
  const creatorProof = await makeMeteoraProof(intent, keys.publicKey, signature);
  // Add creatorProof to the launch receipt returned after chain confirmation.
  const checked = await verifyMeteoraReceipt(receipt, { expectedFingerprint });
  // Obtain expectedFingerprint independently from the creator.
} finally {
  keys.secretKey.fill(0);
}
```

Independent standard-library Python verification:

```sh
python3 cli/verify_meteora.py downloaded-launch-receipt.json --key CREATOR_PUBLIC_KEY_HEX
```

Both offline verifiers reconstruct the signature themselves. They reject
altered launch fields, a mismatched public key, invalid signature encodings,
duplicate JSON fields and the wrong signature domain. Offline verification
reports `onchainVerified: false`: transaction and pool confirmation require a
separate chain read. A public key supplied only inside an untrusted receipt does
not establish the creator's identity.

## Website behavior

- Confirmed Qcommit launches appear in [Explore](https://qcommit.com/#/explore).
- Token pages provide the original transaction link and downloadable receipt.
- Pending signed launches can be resumed after a browser reload. A retry uses
  the same signed bytes; a new transaction requires a fresh review.
- The unlisted curator page imports existing tokens by Solana contract address,
  without a wallet or account. It reads on-chain metadata, public token JSON and
  exact-mint DEX Screener pairs to fill available name, symbol, image, description,
  website and pool fields. Missing fields stay editable; existing CAs reopen
  their saved listing.
- Admin shows the current Explore tokens with direct Hide from Explore controls,
  plus a Hidden tokens list with Show in Explore. Hiding preserves the stored
  listing and its original receipts.
- Community imports are labelled separately; adding one does not manufacture a
  Qcommit execution receipt or creator signature. A later genuinely confirmed
  Qcommit launch links its receipt to an existing curated entry without making
  a duplicate listing.

Website hosting, listing storage and the Meteora transaction adapter are separate
from this portable cryptographic package. The core remains usable offline.

## Executed evidence

The original mainnet configuration was read and decoded, and an **unsigned**
Meteora pool-creation transaction passed mainnet RPC simulation: 833 bytes,
two required signatures, 99,084 compute units, no simulation error. No signature,
transaction submission or spend was made by that check. The measured account
cost was 20,581,640 lamports; the displayed estimate includes a conservative
account-size allowance and is not a guaranteed fee ceiling.

The new core tests sign fresh synthetic commitments and verify them independently
in JavaScript and Python, including mutation and key-mismatch failures. Website
transaction tests use synthetic wallets and an isolated chain adapter; those
checks are distinct from funded mainnet execution. See
[the read-only evidence](../evidence/meteora-readonly.json) and
[the portable receipt tests](../tests/meteora.test.mjs).
