# Deployment operator preparation

`operator.mjs` prepares unsigned transactions. It never loads a secret key, signs, broadcasts, creates a program account, or spends funds. It solves the deliberate deployment-order constraint: configuration must be initialized by the current loader-v3 upgrade authority, while normal mainnet SDK sessions accept only an immutable program.

1. Build/review the exact ELF and record its SHA-256 and byte length.
2. Select the public deployment/funding authority and deploy the reviewed bytes through a separately approved operator action.
3. Prepare and inspect the one-time configuration transaction:

```js
import {prepareBootstrap,prepareImmutableFinalization} from './sdk/operator.mjs';
const operation = await prepareBootstrap(configuration, {
  authority: selectedPublicAuthority,
  maxConfigRentLamports: '10000000',
  maxFeeLamports: '1000000',
});
```

The configuration uses the normal `qcommit/network/1` fields, with `upgradeAuthority` set to the actual current public authority. Operator preparation accepts only explicit HTTPS mainnet-beta or devnet RPC endpoints and their canonical genesis hashes. An injected connection is available for integration tests; its endpoint and returned genesis must match. No localhost exception is provided here.

The operation includes the unsigned transaction bytes, SHA-256 of its message, blockhash/expiry, program/code/config identity, actual rent/fee quote, simulated outcome and human-readable review. Request the selected wallet's explicit signature only after reviewing those fields. The prepared transaction expires with its original blockhash; prepare a new one if it expires.

4. Submit the explicitly approved bootstrap transaction and obtain its finalized signature.
5. Prepare immutable finalization:

```js
const finalization = await prepareImmutableFinalization(configuration, {
  authority: selectedPublicAuthority,
  bootstrapSignature: finalizedBootstrapSignature,
  maxFeeLamports: '1000000',
});
```

This requires the exact initialized configuration, actual pinned bytes and current authority, a successful finalized bootstrap transaction from that deployment, its exact instruction/accounts, a valid fresh blockhash and successful simulation. The returned unsigned transaction invokes loader-v3 `SetAuthority` with no replacement authority. **Submitting it permanently disables program upgrades and program closure.** Preparation does not submit it.

6. Only after separately approving/submitting finalization and verifying the actual authority is null, publish a normal mainnet configuration with `upgradeAuthority: null`. Normal `openNetwork` rechecks the deployed bytes and immutability before enabling ordinary creator registration/launches.

Read-only preparation trusts finalized RPC account/transaction responses and simulation. It does not replace post-submission confirmation or an independent deployment audit. The browser RPC gateway intentionally refuses bootstrap instruction tag0 and all loader instructions; operator transactions require the separately selected direct operator RPC path.

The loader instruction/account layout follows the official [Solana loader-v3 interface](https://docs.rs/solana-loader-v3-interface/latest/solana_loader_v3_interface/instruction/enum.UpgradeableLoaderInstruction.html). Program deployment, selected wallet, exact deployment cost and approval are handled by the deployment operator, not this preparation API.
