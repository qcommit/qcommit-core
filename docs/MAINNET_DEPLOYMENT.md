# Mainnet deployment and acceptance

Mainnet is the intended runtime. No mainnet program deployment or funded token
launch is established by the current local-validator receipts. Website launch
controls remain disabled until the exact deployment is configured and verified.

## Concrete operator sequence

1. Freeze the reviewed source commit and compiled program. Record tool versions,
   exact binary SHA-256 and length, native/validator/browser evidence and a clean
   independent rebuild comparison. Preserve earlier failure records.
2. Choose an explicit funding wallet, new program ID and random nonzero 32-byte
   deployment ID. Publish public identifiers only. Never read a default wallet
   or paste a seed phrase into the website, repository or chat.
3. Obtain a fresh read-only rent quote for that exact artifact:
   `node scripts/quote-mainnet.mjs target/deploy/qcommit_launch.so NEW-QUOTE.json`.
   Add the actual deployment transaction fees and explicit funding limit to the
   wallet approval. The quote alone does not authorize or submit a transaction.
4. Rehearse public-network deployment, registration, launch and receipt checking
   on devnet with isolated test keys. Test the actual supported wallet extension
   separately from the synthetic Wallet Standard adapter used in automated QA.
5. Deploy the reviewed binary to mainnet **with an upgrade authority temporarily
   retained for bootstrap**. Use an explicitly selected signer and program ID.
   Check real mainnet genesis and actual finalized deployed bytes.
6. The current loader-v3 upgrade authority initializes the one-time config with
   mainnet genesis and the deployment ID. Independently verify its exact
   finalized transaction and config account. A deployment finalized before
   this initialization cannot bootstrap Qcommit and must not be used.
7. Prepare and review the separate irreversible authority-removal transaction.
   It must name that exact program and current authority after the correct
   config is confirmed. Removing authority prevents future upgrades and program
   closure; recovery of program rent is then unavailable. The ordinary SDK
   deliberately rejects mutable programs in mainnet mode.
8. Publish the final `qcommit/network/1` configuration: cluster, HTTPS RPC,
   genesis, program ID, exact binary hash/size, `upgradeAuthority: null`, and
   deployment ID. Verify it again from the SDK and website before enabling the
   gateway's transaction path.
9. Execute one explicitly approved mainnet creator registration and token launch.
   Record actual finalized signatures, immutable metadata, fixed supply,
   recipient, absent mint/freeze authority, nonce and independent execution
   receipt. Test refresh/recovery without duplicating the launch.

Each state change requires the selected wallet's signature. Operator bootstrap
is a separate workflow from creator registration, not an exception that allows
the ordinary SDK to accept arbitrary mutable mainnet programs.

The unsigned finalization packet is an as-of-preparation check. The loader
instruction itself does not commit to a code hash. Keep the selected upgrade
authority exclusive, prepare again after any code change, and independently
recheck the finalized code and removed authority before enabling launches.
The browser gateway requires its Site Origin header; CLI users should configure
an approved direct HTTPS RPC instead of assuming the browser proxy accepts
headerless CLI requests.

## Budget and service boundaries

The 2026-10-11 04:01 UTC read-only quote for the 168,568-byte candidate required
0.85922104 SOL in deployed program/config rent, with a conservative 1.71638468 SOL
peak if the full upload-buffer allocation is counted simultaneously. This quote
**excludes transaction fees** and must be refreshed before wallet approval.
Its artifact SHA-256 is
`d71c18378db12dc6e36f9864043054557ec02610dbc1accb50a3c805147ab61d`.
No funds were used to obtain them.

The browser needs HTTPS and a working RPC. The restricted same-origin gateway
permits fixed Solana endpoints and bounded methods; state-changing forwarding
is disabled until its program pin is configured. Per-isolate limits do not
establish a production traffic SLA. Public RPC rate limits, historical receipt
availability, and real wallet compatibility must be measured before broad use.

## Meaning of mainnet completion

Completion requires actual deployed bytes and real finalized registration and
launch evidence on mainnet, not only a build, simulation, devnet result or an
explorer link. Source, test evidence and website claims must identify the same
release. An independent audit is not implied by any successful launch.

Qcommit v1 authorizes creation of classic SPL tokens. It does not create a
post-quantum Solana network, protect ordinary Phantom-held token balances from
future attacks on their wallet signatures, create liquidity or a bonding curve,
or implement creator key rotation. Backups restore the same creator key; the
registered funding wallet remains bound in v1.
