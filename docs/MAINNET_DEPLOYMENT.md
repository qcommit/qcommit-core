# Mainnet deployment and acceptance

Mainnet is the intended runtime. The complete wallet-signed deployment flow has
now executed on an isolated validator, including native deployment, bootstrap,
separate immutable finalization, creator registration and a token launch. The
browser has also completed real **read-only mainnet** preflight. Neither result
establishes a funded mainnet deployment or a genuine Phantom-extension acceptance
run; those remain pending.

## Evidence and its limits

- [Native deployment rehearsal](../evidence/deploy-localnet.json): **244 actual
  local-validator transactions and 15 checks**. One synthetic wallet created both
  seeded accounts, uploaded the exact executable, deployed through loader-v3,
  bootstrapped the configuration, removed upgrade authority, registered a creator
  and launched a token with an independently checked receipt. Cancellation,
  changed chunks, journal recovery, incorrect signers, altered wallet messages,
  failed deployment rollback and buffer-rent reuse were exercised. Program and
  buffer private keys were never required.
- [Browser mainnet preflight](../evidence/phantom-mainnet-preflight.json): the
  compiled HTTPS Worker made real public mainnet genesis, account, rent, fee and
  balance reads. Its Phantom adapter was explicitly simulated with a disposable
  public-only account. **Zero signatures and zero transactions** were requested.
  The sanitized record retains the original report hash and exact quote values.

The local validator and mainnet returned different rent amounts. Use the selected
cluster's fresh RPC quote rather than copying synthetic-validator balances into a
mainnet budget. Earlier failed receipts remain separate from these passed runs.

## Deploy from the selected Phantom wallet

1. Freeze and independently review the source commit, executable hash/length,
   toolchain and matching native/browser evidence. Preserve earlier failures.
2. Open the operator console over HTTPS and explicitly connect the intended
   Phantom wallet. Connection and the initial preflight request no signature.
3. Review the actual mainnet genesis, wallet balance, exact binary, fresh public
   random seeds, derived program/buffer/ProgramData addresses, deployment ID,
   current costs and maximum spending ceilings. Download the public deployment
   journal; its durable persistence is required before broadcasting.
4. Approve deployment costs separately. Phantom receives explicit signing
   requests, with buffer writes grouped into batches of at most ten when the
   provider supports `signAllTransactions`. The SDK validates every message and
   signature before sending any transaction in that batch. Individual signing is
   the fallback for providers without batch support.
5. The client atomically creates the seeded buffer and its authority, uploads
   exact 900-byte chunks, then atomically creates the seeded program account and
   invokes native deployment. The selected wallet is the only signer; the server
   receives no deployment private key or wallet seed.
6. The client verifies the exact original `CreateAccountWithSeed` plus
   `DeployWithMaxDataLen` transaction at the current ProgramData slot, current
   executable bytes and absence of earlier successful program history. An
   upgrade to matching bytes is not accepted as original deployment evidence.
   Retain `deploymentSignature` and `deploymentEvidence` with the public journal.
7. Before bootstrap, the client observes a finalized slot strictly newer than
   the deployment slot and requires that bank context in simulation/submission.
   The current upgrade authority initializes the one-time mainnet genesis and
   deployment configuration. Verify the actual finalized bootstrap transaction.
8. Inspect the separate finalization review. Only after explicit approval does
   Phantom sign authority removal for that exact program. **Confirmed removal
   permanently prevents future program upgrades and program closure.** The client
   rereads code, configuration and null authority before returning the immutable
   network configuration.
9. Publish and independently verify the final `qcommit/network/1` configuration
   and original deployment evidence. Enable ordinary launch forwarding only for
   that exact verified program.
10. Complete a genuine-extension mainnet creator registration and token launch
    with explicit funding approval. Retain real finalized signatures, exact
    supply/recipient, immutable metadata, absent mint/freeze authority, nonce and
    independent execution receipt. Verify reload/recovery without another launch.

See [the precise deployer API and recovery guide](../sdk/OPERATOR.md).
`prepareDeployment` and `inspectFinalization` are read-only;
`executeDeployment` and `finalizeDeployment` request wallet signatures and can
submit transactions. Ordinary mainnet SDK sessions continue to require an
immutable program throughout this operator workflow.

## Current mainnet cost evidence

The read-only preflight recorded at **2026-10-11T05:00:59.345Z** inspected the
168,568-byte artifact with SHA-256
`d71c18378db12dc6e36f9864043054557ec02610dbc1accb50a3c805147ab61d`:

| Item | Recorded amount |
| --- | ---: |
| Permanent program and configuration rent | 0.85922104 SOL |
| Temporary upload-buffer allocation | 0.85716364 SOL |
| Required initial funding, including the approved fee ceiling | **0.86122104 SOL** |
| Estimated network fees: 192 transactions × 5,000 lamports | 0.00096 SOL |
| Estimated net deployment cost | **0.86018104 SOL** |
| Approved network-fee ceiling in that preflight | 0.002 SOL |

The temporary buffer is credited back to the payer during deployment before
ProgramData is funded. The earlier **1.71638468 SOL** figure counted both full
allocations simultaneously and is a conservative overestimate, not the required
funding amount. The native rehearsal verified the buffer-credit behavior; the
amounts above are real mainnet quotes, not local-validator rent estimates.

These figures cover program deployment, configuration and finalization. Creator
registration and token launches have separate proof-account rent, token/metadata
costs and network fees. Refresh all relevant quotes before approval; no mainnet
funds were spent to obtain the cited preflight.

## Recovery and infrastructure

Use the same public journal after an interruption. The SDK compares exact chain
bytes and actual confirmed fees, validates the selected wallet and limits, and
refuses missing history or unresolved broadcasts. It does not reset the fee cap
or assume a failed acknowledgement means the transaction failed. An observed
finalized slot and an original transaction signature are retained as evidence,
not replaced by elapsed-time assumptions.

The operator RPC gateway requires the same application origin and a public
seed-derived deployment header. It permits only the reviewed binary's bounded
setup, writes, deployment, bootstrap and finalization. The ordinary launch gateway
has a separate policy and refuses loader/bootstrap transactions. CLI deployments
must use an explicitly approved direct HTTPS RPC or the documented operator
connection adapter; the browser proxy does not accept arbitrary headerless calls.

RPC history/account responses remain a trust boundary. The checks are not a
light-client proof, and pruned history cannot establish historical absence.
Provider rate limits, genuine wallet behavior and finalized public-network
transactions must be measured before declaring mainnet acceptance complete.
Per-isolate gateway limits are not a production traffic SLA.

## Meaning of completion

Mainnet completion requires the actual deployed artifact, genuine wallet approvals
and real finalized creator registration/launch evidence. A build, simulation,
local deployment, read-only quote or explorer link alone is insufficient. The
source, site, native deployment evidence and public configuration must identify
the same release. Successful execution does not imply an independent audit.

Qcommit v1 authorizes creation of classic SPL tokens. It does not make Solana or
ordinary Phantom-held balances post-quantum, create liquidity or a bonding curve,
or implement creator key rotation. Backups restore the same creator key; the
registered funding wallet remains bound in v1.
