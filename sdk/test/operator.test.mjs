import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "buffer";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  prepareBootstrap,
  prepareImmutableFinalization,
} from "../operator.mjs";
import { GENESIS, UPGRADEABLE_LOADER, parseNetwork } from "../network.mjs";
import { deriveConfig, concat, u64, utf8, hex, address } from "../codec.mjs";
import { initializeConfigInstruction } from "../instructions.mjs";
const payer = Keypair.fromSeed(new Uint8Array(32).fill(71)).publicKey,
  program = Keypair.fromSeed(new Uint8Array(32).fill(72)).publicKey;
const [programData] = PublicKey.findProgramAddressSync(
    [program.toBytes()],
    UPGRADEABLE_LOADER,
  ),
  configuration = deriveConfig(program),
  sig = "2".repeat(88);
function fixture(initialized = false) {
  const code = Uint8Array.of(1, 2, 3),
    v = {
      format: "qcommit/network/1",
      cluster: "mainnet-beta",
      rpc: "https://operator.example",
      genesis: GENESIS["mainnet-beta"],
      program: program.toBase58(),
      programSha256: hex(sha256(code)),
      programSize: 3,
      upgradeAuthority: payer.toBase58(),
      deploymentId: "73".repeat(32),
    },
    state = {
      initialized,
      genesis: v.genesis,
      authority: payer.toBase58(),
      code,
      slot: 1,
      configId: v.deploymentId,
      bootstrapFinalized: true,
      fee: 5000,
      balance: 100000000,
      simulationError: null,
      changed: false,
    };
  const pHeader = Buffer.alloc(36);
  pHeader.writeUInt32LE(2);
  pHeader.set(programData.toBytes(), 4);
  const bootstrap = new Transaction({
    feePayer: payer,
    recentBlockhash: v.genesis,
  }).add(
    initializeConfigInstruction({
      program,
      payer,
      programData,
      genesis: v.genesis,
      deploymentId: v.deploymentId,
    }),
  );
  const tx = {
    slot: 3,
    transaction: { signatures: [sig], message: bootstrap.compileMessage() },
    meta: { err: null },
  };
  const connection = {
    rpcEndpoint: v.rpc,
    getGenesisHash: async () => state.genesis,
    getAccountInfo: async (key) => {
      if (key.equals(program))
        return { owner: UPGRADEABLE_LOADER, executable: true, data: pHeader };
      if (key.equals(programData)) {
        const b = Buffer.alloc(48);
        b.writeUInt32LE(3);
        b.writeBigUInt64LE(BigInt(state.slot), 4);
        b[12] = state.authority ? 1 : 0;
        if (state.authority) b.set(address(state.authority).toBytes(), 13);
        b.set(state.code, 45);
        return { owner: UPGRADEABLE_LOADER, executable: false, data: b };
      }
      if (key.equals(configuration.config) && state.initialized)
        return {
          owner: program,
          executable: false,
          data: Buffer.from(
            concat(
              utf8("QCCONF01"),
              Uint8Array.of(configuration.bump),
              address(v.genesis).toBytes(),
              Buffer.from(state.configId, "hex"),
              payer.toBytes(),
            ),
          ),
        };
      return null;
    },
    getMinimumBalanceForRentExemption: async (n) => 1000 + n,
    getLatestBlockhash: async () => ({
      blockhash: v.genesis,
      lastValidBlockHeight: 50,
    }),
    getFeeForMessage: async () => ({ value: state.fee }),
    getBalance: async () => state.balance,
    getBlockHeight: async () => 10,
    simulateTransaction: async () => {
      if (state.changed) state.slot++;
      return { value: { err: state.simulationError, unitsConsumed: 25000 } };
    },
    getTransaction: async () => tx,
    getSignatureStatuses: async () => ({
      value: [
        {
          confirmationStatus: state.bootstrapFinalized
            ? "finalized"
            : "confirmed",
          err: null,
        },
      ],
    }),
  };
  return {
    v,
    state,
    connection,
    tx,
    options: {
      authority: payer.toBase58(),
      connection,
      bootstrapSignature: sig,
    },
  };
}
test("operator bootstrap prepares exact unsigned config transaction while general mainnet SDK remains immutable-only", async () => {
  const f = fixture();
  assert.throws(() => parseNetwork(f.v), /immutable/);
  const p = await prepareBootstrap(f.v, f.options);
  assert.equal(p.operation, "initialize-config");
  assert.equal(p.unsigned, true);
  assert.equal(p.rentLamports, "1105");
  assert.equal(p.fundingWalletApprovalRequired, true);
  const tx = Transaction.from(Buffer.from(p.transactionBase64, "base64"));
  assert.equal(tx.signatures[0].signature, null);
  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.instructions[1].programId.toBase58(), program.toBase58());
  assert.equal(tx.instructions[1].data[0], 0);
  assert.equal(payer.toBase58(), p.authority);
});
test("operator refuses wrong network genesis", async () => {
  const f = fixture();
  f.state.genesis = GENESIS.devnet;
  await assert.rejects(prepareBootstrap(f.v, f.options), /genesis/);
});
test("operator refuses nonmatching executable or authority", async () => {
  const f = fixture();
  f.state.code[0] ^= 1;
  await assert.rejects(prepareBootstrap(f.v, f.options), /bytes/);
  const g = fixture();
  g.state.authority = program.toBase58();
  await assert.rejects(prepareBootstrap(g.v, g.options), /authority/);
});
test("operator cannot bootstrap an already initialized configuration", async () => {
  const f = fixture(true);
  await assert.rejects(prepareBootstrap(f.v, f.options), /already initialized/);
});
test("operator requires selected public authority and bounded fee/rent", async () => {
  const f = fixture();
  await assert.rejects(
    prepareBootstrap(f.v, { ...f.options, authority: program.toBase58() }),
    /Explicitly select/,
  );
  await assert.rejects(
    prepareBootstrap(f.v, { ...f.options, maxConfigRentLamports: 1 }),
    /rent/,
  );
  await assert.rejects(
    prepareBootstrap(f.v, { ...f.options, maxFeeLamports: 1 }),
    /fee/,
  );
});
test("operator refuses unsafe RPC balance numbers and insufficient balance", async () => {
  const f = fixture();
  f.state.balance = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(prepareBootstrap(f.v, f.options), /exact unsigned/);
  f.state.balance = 0;
  await assert.rejects(prepareBootstrap(f.v, f.options), /insufficient/);
});
test("operator rejects simulation failure or upgrade race", async () => {
  const f = fixture();
  f.state.simulationError = { InstructionError: [1, "Custom"] };
  await assert.rejects(prepareBootstrap(f.v, f.options), /simulation failed/);
  const g = fixture();
  g.state.changed = true;
  await assert.rejects(prepareBootstrap(g.v, g.options), /changed/);
});
test("immutable finalization requires the exact initialized config", async () => {
  const f = fixture();
  await assert.rejects(
    prepareImmutableFinalization(f.v, f.options),
    /Initialize/,
  );
  f.state.initialized = true;
  f.state.configId = "74".repeat(32);
  await assert.rejects(
    prepareImmutableFinalization(f.v, f.options),
    /does not match/,
  );
});
test("immutable finalization requires finalized successful bootstrap transaction", async () => {
  const f = fixture(true);
  f.state.bootstrapFinalized = false;
  await assert.rejects(
    prepareImmutableFinalization(f.v, f.options),
    /finalized/,
  );
  f.state.bootstrapFinalized = true;
  f.tx.meta.err = { InstructionError: [0, "Custom"] };
  await assert.rejects(
    prepareImmutableFinalization(f.v, f.options),
    /finalized/,
  );
});
test("bootstrap before deployment or with different data is rejected", async () => {
  const f = fixture(true);
  f.tx.slot = 1;
  await assert.rejects(
    prepareImmutableFinalization(f.v, f.options),
    /pinned deployment/,
  );
  const g = fixture(true);
  g.tx.transaction.message.instructions[0].data = "1";
  await assert.rejects(prepareImmutableFinalization(g.v, g.options), /differs/);
});
test("finalization creates unsigned loader-v3 SetAuthority without a replacement authority", async () => {
  const f = fixture(true);
  const p = await prepareImmutableFinalization(f.v, f.options);
  assert.equal(p.irreversible, true);
  assert.equal(p.rentLamports, "0");
  assert.equal(p.operation, "make-program-immutable");
  const tx = Transaction.from(Buffer.from(p.transactionBase64, "base64"));
  const ix = tx.instructions[1];
  assert.equal(ix.programId.toBase58(), UPGRADEABLE_LOADER.toBase58());
  assert.deepEqual([...ix.data], [4, 0, 0, 0]);
  assert.equal(ix.keys.length, 2);
  assert.equal(ix.keys[0].pubkey.toBase58(), programData.toBase58());
  assert.equal(ix.keys[1].pubkey.toBase58(), payer.toBase58());
  assert.equal(tx.signatures[0].signature, null);
});
