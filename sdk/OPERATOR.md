# Deploy with a connected wallet

The complete deployment client is [`deployer.mjs`](deployer.mjs). It uses the
selected wallet as both fee payer and deployment authority. Program and upload
buffer addresses are derived from that wallet plus fresh public random seeds;
there is **no program keypair, buffer keypair or server-held signing key**.

The browser operator console adapts Phantom's injected `signTransaction` and
`signAllTransactions` methods to this client. Connecting and obtaining a quote
request no signature. The actual Phantom-extension acceptance run and funded
mainnet deployment are still pending; the completed native rehearsal used a
synthetic wallet adapter on an isolated Solana validator.

## Prepare without signing

```js
import {
  prepareDeployment, executeDeployment,
  inspectFinalization, finalizeDeployment,
} from './sdk/deployer.mjs';

const prepared = await prepareDeployment({
  cluster: 'mainnet-beta',
  rpc: approvedOperatorRpc,
  payer: wallet.publicKey,
  binary: reviewedElfBytes,
  binarySha256: reviewedElfSha256,
  maxFeeLamports: '2000000',
  maxTotalLamports: '3000000000',
  journal: savedPublicJournal, // omit for a new deployment
});
```

`prepared.plan` commits to the actual cluster genesis, wallet, two public seeds,
derived program/buffer/ProgramData addresses, deployment ID, exact ELF hash and
length, and approved fee/total ceilings. Importing a journal cannot increase the
currently supplied ceilings or change wallet, network, artifact or derived
addresses. `prepared.quote` contains current rent and network-fee estimates,
actual wallet balance and remaining funding needed for the observed chain state.
The quote itself does not authorize any transaction.

`requiredFundingLamports` includes permanent program/configuration rent plus the
approved network-fee ceiling. Loader-v3 credits the upload buffer back to the
payer before allocating ProgramData, so the buffer is not an additional permanent
cost. `conservativeFundingLamports` also counts the entire buffer simultaneously;
that older, deliberately larger bound is shown separately and is not required by
the deployment flow. Always review the fresh quote for the exact selected cluster.

## Approve, upload, deploy and bootstrap

```js
const deployed = await executeDeployment({
  plan: prepared.plan,
  binary: reviewedElfBytes,
  payer: wallet,
  journal: prepared.journal,
  batchSize: 10,
  onProgress: showDeploymentProgress,
  onJournal: async journal => {
    await persistPublicJournalDurably(journal);
  },
});
```

The wallet interface requires `publicKey` and `signTransaction`. Optional
`signAllTransactions` enables batches of at most ten transactions; otherwise the
wallet receives individual requests. Every signed message and signature is
checked before any transaction from that batch is broadcast. Broadcasts have at
most four concurrent RPC requests, then the entire batch must finalize before
the next batch. Fee quotes, simulation, cumulative spending limits and blockhash
expiry are checked. Wallet cancellation or an uncertain broadcast stops the flow.

The stages are:

1. Atomically create the seeded upload buffer and set its authority.
2. Upload exact 900-byte chunks of the reviewed artifact; reread finalized bytes.
3. Atomically create the seeded program account and invoke native loader-v3
   deployment with the exact maximum length.
4. Establish the original native deployment transaction and current code identity.
5. Wait for a finalized bank strictly newer than ProgramData's deployment slot.
   Bootstrap simulation/submission carries that `minContextSlot`; observed slots
   and simulation context are retained. An execution failure is not blindly retried.
6. Initialize the exact Qcommit genesis/deployment configuration and verify its
   finalized bootstrap transaction.

The returned `readyForFinalization` does not remove upgrade authority. Keep the
returned public journal, bootstrap signature and native deployment evidence.

## Public journal and recovery

`onJournal` is required for public-network execution. Its writes are serialized
and awaited. Prepared signatures are saved before broadcasting, and each result
is recorded afterward. The journal contains public identifiers, transaction
signatures and status, never wallet secrets or creator private keys.

Resumption compares the exact already-uploaded bytes, checks actual finalized
history and sums actual transaction fees. Missing prior confirmed history,
unresolved broadcasts, changed chunks, substituted accounts, raised caps and
changed artifacts fail closed. Unknown acknowledgement is not treated as failure
or permission to resend. Keep the same journal and inspect the recorded signature
until its status or expiry is established.

Before bootstrap, finalization or reporting a deployed program ready, the client
requires an exact successful original `CreateAccountWithSeed` plus native
`DeployWithMaxDataLen` transaction at the current ProgramData slot. It checks the
seed, wallet, account metas, allocation, funding, binary size and transaction
signature, and rejects earlier successful program history. An upgrade to the
expected code cannot substitute for this original deployment proof. Earlier
failed attempts remain in the evidence. The resulting `deploymentSignature` and
`deploymentEvidence` are retained separately from the normal network config.

These checks use finalized RPC history and account data. They are not a
light-client proof, and a provider that has pruned earlier history cannot prove
historical absence. Fresh random seeds and the retained complete journal remain
part of the deployment procedure.

## Separate irreversible finalization

```js
const review = await inspectFinalization({
  plan: prepared.plan,
  binary: reviewedElfBytes,
  journal: deployed.journal,
});

// After a separate review and explicit wallet approval:
const finalized = await finalizeDeployment({
  plan: prepared.plan,
  binary: reviewedElfBytes,
  payer: wallet,
  journal: deployed.journal,
  onJournal: persistPublicJournalDurably,
  onProgress: showDeploymentProgress,
});
```

Inspection is read-only. Finalization requires the exact initialized config,
original native deployment proof, pinned code and finalized bootstrap. The wallet
then separately signs loader-v3 `SetAuthority` with no replacement authority.
**Confirmed authority removal permanently disables program upgrades and program
closure.** The SDK rereads the resulting state before returning an immutable
`qcommit/network/1` configuration. Ordinary mainnet SDK sessions continue to require
an immutable program; the operator flow does not weaken that rule.

## Restricted RPC and lower-level preparation

The operator gateway accepts only the reviewed binary and the connected wallet's
seed-derived accounts. Its public `X-Qcommit-Deployment` header contains exactly
`format`, `authority`, `programSeed`, `bufferSeed` and `deploymentId`. It permits
only the necessary bounded setup/write/deploy/bootstrap/finalization transactions.
The ordinary launch gateway continues to reject loader operations and bootstrap.

[`operator.mjs`](operator.mjs) also provides `prepareBootstrap` and
`prepareImmutableFinalization` for lower-level operator integrations. These helpers
only return unsigned transactions and review fields; they do not upload a binary
or broadcast. Use the complete deployer above for the original native deployment
provenance checks and public journal recovery.

The loader layout follows the official
[Solana loader-v3 interface](https://docs.rs/solana-loader-v3-interface/latest/solana_loader_v3_interface/instruction/enum.UpgradeableLoaderInstruction.html).
See [the mainnet acceptance guide](../docs/MAINNET_DEPLOYMENT.md) for the remaining
funded-network and real-extension evidence required before claiming completion.
