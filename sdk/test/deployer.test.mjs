import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemInstruction } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "../codec.mjs";
import {
  prepareDeployment,
  deploymentInstructions,
  executeDeployment,
  inspectFinalization,
  deploymentHeader,
} from "../deployer.mjs";
import { SubmissionUncertain } from "../transport.mjs";
const pair = Keypair.fromSeed(new Uint8Array(32).fill(81)),
  genesis = Keypair.fromSeed(new Uint8Array(32).fill(82)).publicKey.toBase58();
function fixture() {
  const binary = new Uint8Array(1801).fill(17);
  binary.set([127, 69, 76, 70]);
  let sent = 0;
  const connection = {
    rpcEndpoint: "http://127.0.0.1:18893",
    getGenesisHash: async () => genesis,
    getMultipleAccountsInfo: async () => [null, null, null, null],
    getMinimumBalanceForRentExemption: async (n) => 1000 + n,
    getLatestBlockhash: async () => ({
      blockhash: genesis,
      lastValidBlockHeight: 1000,
    }),
    getFeeForMessage: async () => ({ value: 5000 }),
    getBalance: async () => 1000000000,
    getSignaturesForAddress: async () => [],
    getBlockHeight: async () => 10,
    simulateTransaction: async () => ({ value: { err: null } }),
    sendRawTransaction: async () => {
      sent++;
      throw new Error("network ambiguous");
    },
  };
  return {
    binary,
    connection,
    sent: () => sent,
    options: {
      cluster: "localnet",
      rpc: connection.rpcEndpoint,
      payer: pair.publicKey.toBase58(),
      binary,
      binarySha256: hex(sha256(binary)),
      connection,
      maxFeeLamports: "2000000",
      maxTotalLamports: "3000000000",
    },
  };
}
test("public deployment plan uses wallet-base seeded accounts without deployment secrets", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options);
  assert.match(p.plan.programSeed, /^[0-9a-f]{32}$/);
  assert.notEqual(p.plan.programSeed, p.plan.bufferSeed);
  assert.equal(p.plan.authority, pair.publicKey.toBase58());
  assert.equal(p.state.deployed, false);
  assert.equal(p.quote.balanceLamports, "1000000000");
  assert.equal(p.quote.writeTransactions, 3);
  assert.equal(p.quote.transactionCount, 7);
  assert.equal(JSON.stringify(p.journal).includes("secretKey"), false);
  assert.deepEqual(Object.keys(deploymentHeader(p.plan)).sort(), [
    "authority",
    "bufferSeed",
    "deploymentId",
    "format",
    "programSeed",
  ]);
});
test("native loader ABI uses u64Vec length and seeded program needs no program signature", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options),
    i = await deploymentInstructions(p.plan, f.binary, f.connection);
  assert.equal(
    SystemInstruction.decodeInstructionType(i.setup[0]),
    "CreateWithSeed",
  );
  assert.equal(
    SystemInstruction.decodeInstructionType(i.deploy[0]),
    "CreateWithSeed",
  );
  assert.deepEqual([...i.setup[1].data], [0, 0, 0, 0]);
  assert.equal(i.write(0).data.readUInt32LE(0), 1);
  assert.equal(i.write(0).data.readUInt32LE(4), 0);
  assert.equal(i.write(0).data.readBigUInt64LE(8), 900n);
  assert.equal(i.write(1800).data.readBigUInt64LE(8), 1n);
  assert.equal(i.deploy[1].data.readBigUInt64LE(4), 1801n);
  assert.equal(i.deploy[1].keys[2].isSigner, false);
  assert.equal(i.deploy[1].keys[7].isSigner, true);
});
test("changed artifact, wallet, derived addresses and journal caps reject", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options);
  await assert.rejects(
    prepareDeployment({ ...f.options, binarySha256: "00".repeat(32) }),
    /binary/,
  );
  await assert.rejects(
    prepareDeployment({ ...f.options, payer: genesis, journal: p.journal }),
    /another wallet/,
  );
  let j = structuredClone(p.journal);
  j.plan.program = genesis;
  await assert.rejects(
    prepareDeployment({ ...f.options, journal: j }),
    /derived/,
  );
  j = structuredClone(p.journal);
  j.plan.maxFeeLamports = "3000000";
  await assert.rejects(
    prepareDeployment({ ...f.options, journal: j }),
    /raises/,
  );
});
test("public clusters cannot silently use localhost genesis", async () => {
  const f = fixture();
  await assert.rejects(
    prepareDeployment({ ...f.options, cluster: "mainnet-beta" }),
    /genesis/,
  );
});
test("changed or dusted account is not silently overwritten on resume", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options);
  f.connection.getMultipleAccountsInfo = async () => [
    null,
    { owner: pair.publicKey, executable: false, data: Buffer.alloc(0) },
    null,
    null,
  ];
  await assert.rejects(
    prepareDeployment({ ...f.options, journal: p.journal }),
    /occupied/,
  );
});
test("wallet rejection sends nothing and retains public resumable plan", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options);
  let journal;
  await assert.rejects(
    executeDeployment({
      plan: p.plan,
      binary: f.binary,
      payer: {
        publicKey: pair.publicKey,
        signTransaction: async () => {
          throw new Error("User rejected");
        },
      },
      journal: p.journal,
      connection: f.connection,
      onJournal: (j) => {
        journal = j;
      },
    }),
    /User rejected/,
  );
  assert.equal(f.sent(), 0);
  assert.equal(journal.plan.program, p.plan.program);
  assert.deepEqual(journal.records, []);
});
test("wallet altered message fails before any transaction submission", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options);
  await assert.rejects(
    executeDeployment({
      plan: p.plan,
      binary: f.binary,
      payer: {
        publicKey: pair.publicKey,
        signTransaction: async (tx) => {
          tx.recentBlockhash = pair.publicKey.toBase58();
          tx.sign(pair);
          return tx;
        },
      },
      journal: p.journal,
      connection: f.connection,
    }),
    /changed an approved/,
  );
  assert.equal(f.sent(), 0);
});
test("uncertain broadcast stops and records exact prepared signature before RPC", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options);
  let journal;
  await assert.rejects(
    executeDeployment({
      plan: p.plan,
      binary: f.binary,
      payer: {
        publicKey: pair.publicKey,
        signTransaction: async (tx) => {
          tx.sign(pair);
          return tx;
        },
      },
      journal: p.journal,
      connection: f.connection,
      onJournal: (j) => {
        journal = j;
      },
    }),
    (e) => e instanceof SubmissionUncertain,
  );
  assert.equal(f.sent(), 1);
  assert.deepEqual(
    journal.records.map((r) => r.phase),
    ["prepared", "broadcasting"],
  );
  assert.equal(journal.records[0].signature, journal.records[1].signature);
});
test("expired blockhash after wallet review stops without broadcasting", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options);
  f.connection.getBlockHeight = async () => 1001;
  await assert.rejects(
    executeDeployment({
      plan: p.plan,
      binary: f.binary,
      payer: {
        publicKey: pair.publicKey,
        signTransaction: async (tx) => {
          tx.sign(pair);
          return tx;
        },
      },
      journal: p.journal,
      connection: f.connection,
    }),
    /expired/,
  );
  assert.equal(f.sent(), 0);
});
test("separate irreversible preflight refuses before actual deployment and initialization", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options);
  await assert.rejects(
    inspectFinalization({
      plan: p.plan,
      binary: f.binary,
      journal: p.journal,
      connection: f.connection,
    }),
    /Deploy and initialize/,
  );
});

test("failure to persist prepared signatures prevents RPC broadcast", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options);
  await assert.rejects(
    executeDeployment({
      plan: p.plan,
      binary: f.binary,
      payer: {
        publicKey: pair.publicKey,
        signTransaction: async (tx) => {
          tx.sign(pair);
          return tx;
        },
      },
      journal: p.journal,
      connection: f.connection,
      onJournal: async (j) => {
        if (j.records.length) throw new Error("Journal storage unavailable");
      },
    }),
    /Journal storage/,
  );
  assert.equal(f.sent(), 0);
});

test("one altered transaction in a signed batch prevents sending every transaction in that batch", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options);
  const { UPGRADEABLE_LOADER } = await import("../network.mjs");
  const data = Buffer.alloc(37 + f.binary.length);
  data.writeUInt32LE(1);
  data[4] = 1;
  data.set(pair.publicKey.toBytes(), 5);
  f.connection.getMultipleAccountsInfo = async () => [
    null,
    { owner: UPGRADEABLE_LOADER, executable: false, data },
    null,
    null,
  ];
  const prior = "2".repeat(88);
  f.connection.getSignaturesForAddress = async () => [{ signature: prior }];
  f.connection.getTransaction = async () => ({
    transaction: {
      signatures: [prior],
      message: { accountKeys: [pair.publicKey] },
    },
    meta: { fee: 5000, err: null },
    slot: 1,
  });
  let batches = 0;
  await assert.rejects(
    executeDeployment({
      plan: p.plan,
      binary: f.binary,
      payer: {
        publicKey: pair.publicKey,
        signTransaction: async () => {
          throw new Error("Unexpected individual signing");
        },
        signAllTransactions: async (txs) => {
          batches++;
          assert.equal(txs.length, 3);
          txs[1].recentBlockhash = pair.publicKey.toBase58();
          for (const tx of txs) tx.sign(pair);
          return txs;
        },
      },
      journal: p.journal,
      connection: f.connection,
    }),
    /changed an approved/,
  );
  assert.equal(batches, 1);
  assert.equal(f.sent(), 0);
});

test("resume uses actual confirmed transaction fees instead of resetting or trusting journal fee fields", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options),
    prior = "2".repeat(88);
  let signed = 0;
  f.connection.getSignaturesForAddress = async () => [{ signature: prior }];
  f.connection.getTransaction = async () => ({
    transaction: {
      signatures: [prior],
      message: { accountKeys: [pair.publicKey] },
    },
    meta: { fee: 1999999, err: null },
    slot: 1,
  });
  await assert.rejects(
    executeDeployment({
      plan: p.plan,
      binary: f.binary,
      payer: {
        publicKey: pair.publicKey,
        signTransaction: async (tx) => {
          signed++;
          tx.sign(pair);
          return tx;
        },
      },
      journal: p.journal,
      connection: f.connection,
    }),
    /cumulative fee cap/,
  );
  assert.equal(signed, 0);
  assert.equal(f.sent(), 0);
});

test("confirmed journal history cannot silently disappear during a resume", async () => {
  const f = fixture(),
    p = await prepareDeployment(f.options);
  p.journal.records.push({
    phase: "confirmed",
    signature: "2".repeat(88),
    feeLamports: "1",
  });
  await assert.rejects(
    executeDeployment({
      plan: p.plan,
      binary: f.binary,
      payer: {
        publicKey: pair.publicKey,
        signTransaction: async () => {
          throw new Error("must not sign");
        },
      },
      journal: p.journal,
      connection: f.connection,
    }),
    /confirmed deployment history/,
  );
  assert.equal(f.sent(), 0);
});

test("new program bootstrap waits for a strictly newer finalized bank with observed-slot evidence", async () => {
  const { waitForProgramVisibility } = await import("../deployer.mjs");
  let slots = [1032, 1032, 1033],
    queries = 0;
  const v = await waitForProgramVisibility(
    {
      getSlot: async (commitment) => {
        assert.equal(commitment, "finalized");
        queries++;
        return slots.shift();
      },
    },
    "1032",
    { pollIntervalMs: 0, timeoutMs: 100 },
  );
  assert.equal(queries, 3);
  assert.equal(v.minContextSlot, 1033);
  assert.deepEqual(v.observedFinalizedSlots, ["1032", "1032", "1033"]);
});

test("program-visibility deadline fails with exact observed bank evidence and never retries execution", async () => {
  const { waitForProgramVisibility } = await import("../deployer.mjs");
  await assert.rejects(
    waitForProgramVisibility({ getSlot: async () => 1032 }, "1032", {
      timeoutMs: 1,
      pollIntervalMs: 0,
    }),
    (error) =>
      error.name === "ProgramVisibilityError" &&
      error.visibility.deployedSlot === "1032" &&
      error.visibility.observedFinalizedSlots.every((s) => s === "1032") &&
      error.visibility.observedFinalizedSlots.length > 0,
  );
});

async function nativeFixture() {
  const f = fixture(),
    p = await prepareDeployment(f.options),
    instructions = await deploymentInstructions(p.plan, f.binary, f.connection);
  const { Transaction, ComputeBudgetProgram } = await import("@solana/web3.js");
  const tx = new Transaction({
      feePayer: pair.publicKey,
      recentBlockhash: genesis,
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1200000 }),
      ...instructions.deploy,
    ),
    message = tx.compileMessage();
  const pi = message.accountKeys.findIndex(
      (key) => key.toBase58() === p.plan.program,
    ),
    preBalances = new Array(message.accountKeys.length).fill(0),
    postBalances = [...preBalances];
  postBalances[pi] = 1036;
  return {
    plan: p.plan,
    state: { deployed: true, deployedSlot: "100" },
    transactions: [
      {
        signature: "3".repeat(88),
        tx: {
          slot: 100,
          transaction: { signatures: ["3".repeat(88)], message },
          meta: { err: null, preBalances, postBalances },
        },
      },
    ],
  };
}

test("native provenance binds exact first seeded creation and loader deployment at current ProgramData slot", async () => {
  const { verifyNativeDeployment } = await import("../deployer.mjs");
  const f = await nativeFixture(),
    e = verifyNativeDeployment(f.plan, f.state, f.transactions);
  assert.equal(e.deploymentSignature, "3".repeat(88));
  assert.equal(e.deployedSlot, "100");
  assert.equal(e.program, f.plan.program);
});

test("current code installed by Upgrade cannot substitute for clean native creation", async () => {
  const { verifyNativeDeployment } = await import("../deployer.mjs");
  const f = await nativeFixture();
  f.state.deployedSlot = "101";
  assert.throws(
    () => verifyNativeDeployment(f.plan, f.state, f.transactions),
    /successful history before/,
  );
});

test("earlier successful program activity rejects while failed earlier deployment attempts are retained", async () => {
  const { verifyNativeDeployment } = await import("../deployer.mjs");
  const f = await nativeFixture(),
    earlier = {
      signature: "4".repeat(88),
      tx: {
        ...f.transactions[0].tx,
        slot: 99,
        meta: { ...f.transactions[0].tx.meta, err: null },
      },
    };
  assert.throws(
    () => verifyNativeDeployment(f.plan, f.state, [earlier, ...f.transactions]),
    /successful history before/,
  );
  earlier.tx.meta.err = { InstructionError: [2, "InvalidArgument"] };
  assert.doesNotThrow(() =>
    verifyNativeDeployment(f.plan, f.state, [earlier, ...f.transactions]),
  );
});

test("seed substitution and nonzero preexisting program account balance reject native provenance", async () => {
  const { verifyNativeDeployment } = await import("../deployer.mjs");
  const f = await nativeFixture();
  assert.throws(
    () =>
      verifyNativeDeployment(
        { ...f.plan, programSeed: "f".repeat(32) },
        f.state,
        f.transactions,
      ),
    /exact successful first/,
  );
  const keys = f.transactions[0].tx.transaction.message.accountKeys,
    pi = keys.findIndex((k) => k.toBase58() === f.plan.program);
  f.transactions[0].tx.meta.preBalances[pi] = 1;
  assert.throws(
    () => verifyNativeDeployment(f.plan, f.state, f.transactions),
    /exact successful first/,
  );
});

test("native provenance rejects a mismatched RPC transaction signature", async () => {
  const { verifyNativeDeployment } = await import("../deployer.mjs");
  const f = await nativeFixture();
  f.transactions[0].tx.transaction.signatures[0] = "5".repeat(88);
  assert.throws(
    () => verifyNativeDeployment(f.plan, f.state, f.transactions),
    /signature does not match/,
  );
});
