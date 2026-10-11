import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { openNetwork } from "../network.mjs";
import { submitNetwork, SubmissionUncertain, base58 } from "../transport.mjs";
import { hex } from "../codec.mjs";
const payer = Keypair.fromSeed(new Uint8Array(32).fill(11));
const program = Keypair.fromSeed(new Uint8Array(32).fill(12)).publicKey;
const config = {
  format: "qcommit/network/1",
  cluster: "localnet",
  rpc: "http://127.0.0.1:18898",
  genesis: Keypair.fromSeed(new Uint8Array(32).fill(13)).publicKey.toBase58(),
  program: program.toBase58(),
  programSha256: hex(sha256(Uint8Array.of(1, 2, 3))),
  programSize: 3,
  upgradeAuthority: null,
  deploymentId: "ab".repeat(32),
};
const ix = () =>
  new TransactionInstruction({
    programId: program,
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
    data: Buffer.from([5]),
  });
async function fixture() {
  let sent = 0;
  const c = {
    rpcEndpoint: config.rpc,
    getGenesisHash: async () => config.genesis,
    getAccountInfo: async () => ({
      executable: true,
      owner: SystemProgram.programId.constructor.default
        ? new SystemProgram.programId.constructor(
            "BPFLoader2111111111111111111111111111111111",
          )
        : null,
      data: Uint8Array.of(1, 2, 3),
    }),
    getLatestBlockhash: async () => ({
      blockhash: config.genesis,
      lastValidBlockHeight: 100,
    }),
    getFeeForMessage: async () => ({ value: 5000 }),
    simulateTransaction: async () => ({ value: { err: null } }),
    getBlockHeight: async () => 10,
    getSignatureStatuses: async () => ({
      value: [{ confirmationStatus: "confirmed", err: null }],
    }),
    getTransaction: async () => ({
      slot: 20,
      meta: { err: null, fee: 5000, computeUnitsConsumed: 100 },
    }),
    sendRawTransaction: async (b) => {
      sent++;
      return base58(b.slice(1, 65));
    },
  };
  const network = await openNetwork(config, c);
  return { c, network, sent: () => sent };
}
test("explicit wallet transaction signing submits exact reviewed bytes", async () => {
  const { c, network, sent } = await fixture();
  let signed = 0;
  const wallet = {
    publicKey: payer.publicKey.toBase58(),
    signTransaction: async (tx) => {
      signed++;
      tx.sign(payer);
      return tx;
    },
  };
  const records = [];
  const result = await submitNetwork(c, wallet, [ix()], {
    network,
    onRecord: (r) => records.push(r),
    pollIntervalMs: 0,
  });
  assert.equal(signed, 1);
  assert.equal(sent(), 1);
  assert.equal(result.genesis, config.genesis);
  assert.deepEqual(
    records.map((r) => r.phase),
    ["prepared", "confirmed"],
  );
});
test("wallet modification is rejected before RPC submission", async () => {
  const { c, network, sent } = await fixture();
  const wallet = {
    publicKey: payer.publicKey,
    signTransaction: async (tx) => {
      tx.add(ix());
      tx.sign(payer);
      return tx;
    },
  };
  await assert.rejects(
    submitNetwork(c, wallet, [ix()], { network }),
    /modified/,
  );
  assert.equal(sent(), 0);
});
test("fee quote exceeding cap never requests wallet signature", async () => {
  const { c, network, sent } = await fixture();
  let signed = false;
  c.getFeeForMessage = async () => ({ value: 5001 });
  await assert.rejects(
    submitNetwork(
      c,
      {
        publicKey: payer.publicKey,
        signTransaction: async () => {
          signed = true;
        },
      },
      [ix()],
      { network, maxFeeLamports: 5000 },
    ),
    /fee/,
  );
  assert.equal(signed, false);
  assert.equal(sent(), 0);
});
test("simulation failure sends nothing", async () => {
  const { c, network, sent } = await fixture();
  c.simulateTransaction = async () => ({
    value: { err: { InstructionError: [1, "InvalidArgument"] } },
  });
  await assert.rejects(
    submitNetwork(c, payer, [ix()], { network }),
    /Simulation rejected/,
  );
  assert.equal(sent(), 0);
});
test("uncertain RPC acknowledgement preserves exact signature and never silently retries", async () => {
  const { c, network } = await fixture();
  let calls = 0;
  c.sendRawTransaction = async () => {
    calls++;
    throw new Error("socket closed");
  };
  await assert.rejects(
    submitNetwork(c, payer, [ix()], { network }),
    (e) => e instanceof SubmissionUncertain && typeof e.signature === "string",
  );
  assert.equal(calls, 1);
});
test("confirmed execution failure is never success", async () => {
  const { c, network } = await fixture();
  c.getTransaction = async () => ({
    slot: 20,
    meta: { err: { InstructionError: [1, "Custom"] }, fee: 5000 },
  });
  await assert.rejects(
    submitNetwork(c, payer, [ix()], { network }),
    /execution error/,
  );
});
test("expired blockhash never submitted", async () => {
  const { c, network, sent } = await fixture();
  c.getBlockHeight = async () => 101;
  await assert.rejects(submitNetwork(c, payer, [ix()], { network }), /expired/);
  assert.equal(sent(), 0);
});
test("instructions for another program rejected", async () => {
  const { c, network } = await fixture();
  const bad = ix();
  bad.programId = SystemProgram.programId;
  await assert.rejects(submitNetwork(c, payer, [bad], { network }), /pinned/);
});
