import test from "node:test";
import assert from "node:assert/strict";
import { Transaction, Keypair, SystemProgram } from "@solana/web3.js";
import * as c from "../codec.mjs";
import * as i from "../instructions.mjs";
import { parseLaunchAuthorization } from "../approval.mjs";
import { parseNetwork, openNetwork, inspectDeployment } from "../network.mjs";
import { sha256 } from "@noble/hashes/sha2.js";
const pk = (n) =>
  Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const program = pk(1),
  payer = pk(2),
  genesis = pk(3),
  deploymentId = "04".repeat(32),
  key = "05".repeat(32),
  salt = "06".repeat(32);
const d = c.deriveCreator(program, genesis, deploymentId, payer, key, salt);
const launch = c.deriveLaunch(program, d.creator, 0, payer);
export const intent = {
  version: 1,
  program,
  genesis,
  deploymentId,
  creator: d.creator.toBase58(),
  epoch: "0",
  nonce: "0",
  expirySlot: "9000",
  tokenProgram: c.TOKEN_PROGRAM.toBase58(),
  mint: launch.mint.toBase58(),
  recipient: payer,
  payer,
  decimals: 6,
  supplyBaseUnits: "1000000000",
  maxExecutionRent: "100000000",
  platformFee: "0",
  maxNetworkFee: "10000000",
  name: "Test Token",
  symbol: "TEST",
  metadataUri: "https://example.com/token.json",
  metadataSha256: "07".repeat(32),
  mintPolicy: "fixed",
  freezePolicy: "none",
};
test("production intent round-trips exact canonical bytes", () => {
  assert.deepEqual(c.decodeIntent(c.encodeIntent(intent)), intent);
  assert.equal(
    c.hex(c.intentDigest(intent)),
    c.hex(c.intentDigest(c.encodeIntent(intent))),
  );
});
test("preview JSON never decodes as production approval", () => {
  assert.throws(() =>
    c.decodeIntent(
      new TextEncoder().encode(JSON.stringify({ scope: "preview-only" })),
    ),
  );
  assert.throws(() =>
    parseLaunchAuthorization({ format: "qcommit/launch-authorization/1" }),
  );
});
test("every signed launch field changes digest", () => {
  for (const [k, v] of Object.entries({
    program: pk(9),
    genesis: pk(9),
    deploymentId: "08".repeat(32),
    creator: pk(9),
    nonce: "1",
    expirySlot: "9001",
    mint: pk(9),
    recipient: pk(9),
    payer: pk(9),
    decimals: 5,
    supplyBaseUnits: "1000000001",
    maxExecutionRent: "100000001",
    maxNetworkFee: "10000001",
    name: "Another",
    symbol: "OTHER",
    metadataUri: "https://example.com/other",
    metadataSha256: "08".repeat(32),
  })) {
    assert.notEqual(
      c.hex(c.intentDigest({ ...intent, [k]: v })),
      c.hex(c.intentDigest(intent)),
      k,
    );
  }
});
test("u64 never silently rounds, signs or accepts noncanonical decimals", () => {
  for (const n of [
    -1,
    1.1,
    Number.MAX_SAFE_INTEGER + 1,
    "01",
    "+1",
    "1e3",
    2n ** 64n,
    NaN,
    null,
  ])
    assert.throws(() => c.u64(n));
  assert.equal(c.u64(2n ** 64n - 1n).length, 8);
});
test("closed intent schema rejects ignored fields and dangerous policies", () => {
  for (const p of [
    { extra: true },
    { epoch: "1" },
    { platformFee: "1" },
    { mintPolicy: "retain" },
    { freezePolicy: "creator" },
    { tokenProgram: pk(9) },
    { supplyBaseUnits: "0" },
    { metadataSha256: "00".repeat(32) },
    { decimals: 10 },
    { name: " trailing " },
    { symbol: "bad symbol" },
    { metadataUri: "javascript:alert(1)" },
    { metadataUri: "https://user:pass@example.com/x" },
  ])
    assert.throws(() => c.encodeIntent({ ...intent, ...p }));
});
test("malformed/trailing intent bytes fail closed", () => {
  const b = c.encodeIntent(intent);
  assert.throws(() => c.decodeIntent(b.slice(0, -1)));
  assert.throws(() => c.decodeIntent(c.concat(b, Uint8Array.of(0))));
  const bad = b.slice();
  bad[0] = 0;
  assert.throws(() => c.decodeIntent(bad));
});
test("UTF-8 byte limits and surrogates enforced", () => {
  assert.throws(() => c.encodeIntent({ ...intent, name: "\uD800" }));
  assert.throws(() => c.encodeIntent({ ...intent, name: "é".repeat(17) }));
  assert.doesNotThrow(() =>
    c.encodeIntent({ ...intent, name: "é".repeat(16) }),
  );
});
test("creator address binds payer, key, salt and deployment", () => {
  for (const args of [
    [program, genesis, deploymentId, pk(9), key, salt],
    [program, genesis, deploymentId, payer, "09".repeat(32), salt],
    [program, genesis, deploymentId, payer, key, "09".repeat(32)],
    [program, genesis, "09".repeat(32), payer, key, salt],
  ])
    assert.notEqual(
      c.deriveCreator(...args).creator.toBase58(),
      d.creator.toBase58(),
    );
});
test("proof PDA isolates uploader and signed digest", () => {
  const x = c.deriveProof(program, d.creator, c.intentDigest(intent), payer);
  assert.notEqual(
    c
      .deriveProof(program, d.creator, c.intentDigest(intent), pk(9))
      .proof.toBase58(),
    x.proof.toBase58(),
  );
});
test("registration digest cannot collide with a launch approval", () => {
  const r = {
    version: 1,
    program,
    genesis,
    deploymentId,
    creator: intent.creator,
    creatorPublicKey: key,
    payer,
    salt,
    nonce: "0",
    expirySlot: "9000",
  };
  assert.notEqual(
    c.hex(c.registrationDigest(r)),
    c.hex(c.intentDigest(intent)),
  );
  assert.throws(() => c.registrationDigest({ ...r, nonce: "1" }));
});
test("maximum intent is uploaded while execute fits legacy transaction limit", () => {
  const max = {
    ...intent,
    name: "X".repeat(32),
    symbol: "X".repeat(10),
    metadataUri: "https://example.com/" + "a".repeat(180),
  };
  const b = c.encodeIntent(max);
  assert.ok(b.length <= 768);
  const { proof } = c.deriveProof(
    program,
    d.creator,
    c.intentDigest(max),
    payer,
  );
  const instruction = i.executeLaunchInstruction(max, proof);
  assert.deepEqual([...instruction.data], [7]);
  const tx = new Transaction({
    feePayer: c.address(payer),
    recentBlockhash: pk(4),
  }).add(instruction);
  assert.ok(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false })
      .length <= 1232,
  );
});
test("proof append size and begin payload length guards", () => {
  const args = {
    program,
    creator: d.creator,
    uploader: payer,
    kind: 1,
    nonce: 0,
    expirySlot: 9000,
    digest: c.intentDigest(intent),
    intentLength: c.encodeIntent(intent).length,
  };
  assert.equal(i.beginProofInstruction(args).instruction.data.length, 52);
  assert.throws(() => i.beginProofInstruction({ ...args, kind: 0 }));
  assert.throws(() =>
    i.appendProofInstruction({
      ...args,
      proof: pk(4),
      offset: 0,
      chunk: new Uint8Array(701),
    }),
  );
});
const config = {
  format: "qcommit/network/1",
  cluster: "localnet",
  rpc: "http://127.0.0.1:18999",
  genesis,
  program,
  programSha256: c.hex(sha256(Uint8Array.of(1, 2, 3))),
  programSize: 3,
  upgradeAuthority: null,
  deploymentId,
};
test("public clusters require exact genesis, HTTPS and immutable mainnet policy", () => {
  assert.doesNotThrow(() => parseNetwork(config));
  assert.throws(() => parseNetwork({ ...config, cluster: "mainnet-beta" }));
  assert.throws(() =>
    parseNetwork({ ...config, rpc: "http://localhost:8899" }),
  );
  assert.throws(() =>
    parseNetwork({
      ...config,
      cluster: "mainnet-beta",
      rpc: "https://api.mainnet-beta.solana.com",
      genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      upgradeAuthority: payer,
    }),
  );
});
test("deployment inspector checks actual code bytes and zero allocation padding", async () => {
  const connection = {
    rpcEndpoint: config.rpc,
    getGenesisHash: async () => genesis,
    getAccountInfo: async () => ({
      executable: true,
      owner: c.address("BPFLoader2111111111111111111111111111111111"),
      data: Uint8Array.of(1, 2, 3, 0, 0),
    }),
  };
  assert.equal((await inspectDeployment(connection, config)).immutable, true);
  await assert.rejects(
    inspectDeployment(connection, {
      ...config,
      programSha256: "00".repeat(32),
    }),
  );
  connection.getAccountInfo = async () => ({
    executable: true,
    owner: c.address("BPFLoader2111111111111111111111111111111111"),
    data: Uint8Array.of(1, 2, 3, 0, 1),
  });
  await assert.rejects(inspectDeployment(connection, config));
});
test("deployment inspector rejects wrong genesis before reading program", async () => {
  let called = false;
  await assert.rejects(
    inspectDeployment(
      {
        rpcEndpoint: config.rpc,
        getGenesisHash: async () => pk(9),
        getAccountInfo: async () => {
          called = true;
        },
      },
      config,
    ),
  );
  assert.equal(called, false);
});
test("strict account sizes/discriminators reject spoofed state", () => {
  for (const [fn, size] of [
    [c.decodeConfig, c.CONFIG_BYTES],
    [c.decodeCreator, c.CREATOR_BYTES],
    [c.decodeProof, c.PROOF_BYTES],
    [c.decodeLaunchRecord, c.RECORD_BYTES],
  ]) {
    assert.throws(() => fn(new Uint8Array(size)));
    assert.throws(() => fn(new Uint8Array(size - 1)));
  }
});
