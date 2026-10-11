/** Read-only operator preparation. No signer, key-file access, or broadcast function. */
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { parseJson } from "../src/json.mjs";
import { GENESIS, UPGRADEABLE_LOADER } from "./network.mjs";
import {
  address,
  raw,
  hex,
  integer,
  fields,
  deriveConfig,
  decodeConfig,
  CONFIG_BYTES,
} from "./codec.mjs";
import { initializeConfigInstruction } from "./instructions.mjs";
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
function config(input) {
  const v = typeof input === "string" ? parseJson(input, 8192) : input;
  fields(v, [
    "format",
    "cluster",
    "rpc",
    "genesis",
    "program",
    "programSha256",
    "programSize",
    "upgradeAuthority",
    "deploymentId",
  ]);
  assert(
    v.format === "qcommit/network/1" &&
      ["mainnet-beta", "devnet"].includes(v.cluster),
    "Operator preparation supports explicit mainnet-beta/devnet configurations only.",
  );
  const url = new URL(v.rpc);
  assert(
    url.protocol === "https:" && !url.username && !url.password && !url.hash,
    "Operator RPC must be an explicit credential-free HTTPS URL.",
  );
  assert(
    v.genesis === GENESIS[v.cluster],
    "Genesis does not match the chosen public cluster.",
  );
  address(v.program);
  address(v.genesis);
  raw(v.programSha256);
  raw(v.deploymentId);
  assert(raw(v.deploymentId).some(Boolean), "Deployment ID must be nonzero.");
  assert(
    Number.isSafeInteger(v.programSize) &&
      v.programSize > 0 &&
      v.programSize <= 10485760,
    "Pin a bounded executable byte length.",
  );
  assert(
    typeof v.upgradeAuthority === "string",
    "Pin the current public upgrade authority for operator preparation.",
  );
  address(v.upgradeAuthority);
  return Object.freeze({ ...v, rpc: url.href });
}
function rpc(v, connection) {
  return (
    connection ??
    new Connection(v.rpc, {
      commitment: "finalized",
      disableRetryOnRateLimit: true,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        }),
    })
  );
}
async function inspect(v, connection) {
  assert(
    new URL(connection.rpcEndpoint).href === v.rpc,
    "Operator RPC endpoint mismatch.",
  );
  assert(
    (await connection.getGenesisHash()) === v.genesis,
    "RPC genesis does not match the selected network.",
  );
  const id = address(v.program),
    program = await connection.getAccountInfo(id, "finalized");
  assert(
    program?.executable &&
      program.owner.equals(UPGRADEABLE_LOADER) &&
      program.data.length === 36 &&
      program.data.readUInt32LE(0) === 2,
    "Expected a loader-v3 executable program.",
  );
  const programData = address(program.data.subarray(4)),
    [canonical] = PublicKey.findProgramAddressSync(
      [id.toBytes()],
      UPGRADEABLE_LOADER,
    );
  assert(canonical.equals(programData), "Noncanonical ProgramData address.");
  const info = await connection.getAccountInfo(programData, "finalized");
  assert(
    info &&
      !info.executable &&
      info.owner.equals(UPGRADEABLE_LOADER) &&
      info.data.length >= 45,
    "Invalid ProgramData account owner or flags.",
  );
  const b = info.data;
  assert(
    b.readUInt32LE(0) === 3 && b[12] === 1,
    "Program must still have an upgrade authority for this operator action.",
  );
  assert(
    address(b.subarray(13, 45)).toBase58() === v.upgradeAuthority,
    "Actual upgrade authority differs from the chosen public authority.",
  );
  const code = b.subarray(45);
  assert(
    code.length >= v.programSize &&
      !code.subarray(v.programSize).some(Boolean) &&
      hex(sha256(code.subarray(0, v.programSize))) === v.programSha256,
    "Actual deployed program bytes differ from the reviewed artifact.",
  );
  return {
    programData: programData.toBase58(),
    deployedSlot: b.readBigUInt64LE(4).toString(),
    allocatedProgramBytes: code.length,
  };
}
function unchanged(a, b) {
  assert(
    a.programData === b.programData &&
      a.deployedSlot === b.deployedSlot &&
      a.allocatedProgramBytes === b.allocatedProgramBytes,
    "Program changed during operator preparation.",
  );
}
async function readConfig(v, connection) {
  const d = deriveConfig(v.program),
    a = await connection.getAccountInfo(d.config, "finalized");
  if (!a) return { address: d.config.toBase58(), state: null };
  assert(
    !a.executable && a.owner.equals(address(v.program)),
    "Config owner or executable flag is invalid.",
  );
  const state = decodeConfig(Uint8Array.from(a.data));
  assert(
    state.bump === d.bump &&
      state.genesis === v.genesis &&
      state.deploymentId === v.deploymentId &&
      state.bootstrapAuthority === v.upgradeAuthority,
    "Initialized config does not match the reviewed genesis, deployment and bootstrap authority.",
  );
  return { address: d.config.toBase58(), state };
}
async function prepared(
  v,
  connection,
  deployment,
  instruction,
  {
    operation,
    rentLamports,
    maxFeeLamports,
    maxRentLamports,
    bootstrapSignature = null,
  },
) {
  const feeCap = integer(maxFeeLamports ?? 1000000n),
    rentCap = integer(maxRentLamports ?? 10000000n);
  assert(
    feeCap > 0n && feeCap <= 10000000n && rentCap <= 1000000000n,
    "Operator fee/rent cap exceeds policy.",
  );
  assert(
    rentLamports <= rentCap,
    "Configuration rent exceeds the reviewed cap.",
  );
  const latest = await connection.getLatestBlockhash("finalized");
  const tx = new Transaction({
    feePayer: address(v.upgradeAuthority),
    recentBlockhash: latest.blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
    instruction,
  );
  const fee = (
    await connection.getFeeForMessage(tx.compileMessage(), "finalized")
  ).value;
  assert(
    fee !== null && integer(fee) <= feeCap,
    "Transaction fee is unavailable or exceeds the reviewed cap.",
  );
  const balance = integer(
    await connection.getBalance(address(v.upgradeAuthority), "finalized"),
  );
  assert(
    balance >= rentLamports + integer(fee),
    "Selected public funding authority has insufficient balance.",
  );
  const wire = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  assert(wire.length <= 1232, "Operator transaction exceeds the wire limit.");
  const simulation = await connection.simulateTransaction(
    VersionedTransaction.deserialize(wire),
    {
      commitment: "finalized",
      sigVerify: false,
      replaceRecentBlockhash: false,
    },
  );
  assert(
    simulation?.value && !simulation.value.err,
    "Operator transaction simulation failed: " +
      JSON.stringify(simulation?.value?.err ?? "missing result"),
  );
  assert(
    integer(await connection.getBlockHeight("finalized")) <=
      integer(latest.lastValidBlockHeight),
    "Operator blockhash expired during preparation.",
  );
  unchanged(deployment, await inspect(v, connection));
  const current = await readConfig(v, connection);
  assert(
    operation === "initialize-config"
      ? current.state === null
      : current.state !== null,
    "Config state changed during operator preparation.",
  );
  return {
    format: "qcommit/operator-operation/1",
    operation,
    cluster: v.cluster,
    genesis: v.genesis,
    program: v.program,
    programData: deployment.programData,
    programSha256: v.programSha256,
    programSize: v.programSize,
    deployedSlot: deployment.deployedSlot,
    authority: v.upgradeAuthority,
    config: current.address,
    deploymentId: v.deploymentId,
    bootstrapSignature,
    irreversible: operation === "make-program-immutable",
    review:
      operation === "make-program-immutable"
        ? "Permanently remove the program upgrade authority. No future code upgrade or program closure will be possible."
        : "Initialize the program configuration exactly once with this genesis and deployment ID.",
    feeLamports: String(fee),
    rentLamports: rentLamports.toString(),
    totalLamports: (integer(fee) + rentLamports).toString(),
    maxFeeLamports: feeCap.toString(),
    maxRentLamports: rentCap.toString(),
    blockhash: latest.blockhash,
    lastValidBlockHeight: String(latest.lastValidBlockHeight),
    messageSha256: hex(sha256(tx.serializeMessage())),
    transactionBase64: wire.toString("base64"),
    unsigned: true,
    simulation: {
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      error: null,
    },
    fundingWalletApprovalRequired: true,
  };
}
export async function prepareBootstrap(
  configuration,
  { authority, maxFeeLamports, maxConfigRentLamports, connection } = {},
) {
  const v = config(configuration);
  assert(
    authority === v.upgradeAuthority,
    "Explicitly select the pinned public upgrade-authority wallet.",
  );
  connection = rpc(v, connection);
  const deployment = await inspect(v, connection),
    initial = await readConfig(v, connection);
  assert(
    initial.state === null,
    "Configuration is already initialized; do not submit another bootstrap.",
  );
  const rentLamports = integer(
    await connection.getMinimumBalanceForRentExemption(
      CONFIG_BYTES,
      "finalized",
    ),
  );
  const instruction = initializeConfigInstruction({
    program: v.program,
    payer: v.upgradeAuthority,
    programData: deployment.programData,
    genesis: v.genesis,
    deploymentId: v.deploymentId,
  });
  return prepared(v, connection, deployment, instruction, {
    operation: "initialize-config",
    rentLamports,
    maxFeeLamports,
    maxRentLamports: maxConfigRentLamports,
  });
}
async function confirmBootstrap(v, connection, deployment, signature) {
  assert(
    typeof signature === "string" &&
      /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature),
    "Provide the confirmed bootstrap transaction signature.",
  );
  const [tx, statuses] = await Promise.all([
    connection.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    }),
    connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    }),
  ]);
  const status = statuses.value[0];
  assert(
    status?.confirmationStatus === "finalized" &&
      !status.err &&
      tx?.meta &&
      !tx.meta.err,
    "Bootstrap transaction is not successfully finalized.",
  );
  assert(
    tx.transaction.signatures[0] === signature &&
      integer(tx.slot) > integer(deployment.deployedSlot),
    "Bootstrap does not establish initialization by this pinned deployment.",
  );
  const m = tx.transaction.message,
    keys = m.accountKeys ?? [
      ...m.staticAccountKeys,
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ];
  assert(
    address(keys[0]).toBase58() === v.upgradeAuthority,
    "Bootstrap used a different payer/authority.",
  );
  const instructions = m.compiledInstructions ?? m.instructions;
  assert(
    instructions.length >= 1 && instructions.length <= 3,
    "Unexpected bootstrap instruction count.",
  );
  const ours = instructions.filter(
    (i) => address(keys[i.programIdIndex]).toBase58() === v.program,
  );
  assert(
    ours.length === 1 &&
      instructions.every((i) =>
        [v.program, "ComputeBudget111111111111111111111111111111"].includes(
          address(keys[i.programIdIndex]).toBase58(),
        ),
      ),
    "Bootstrap contains an unrelated program instruction.",
  );
  const expected = initializeConfigInstruction({
      program: v.program,
      payer: v.upgradeAuthority,
      programData: deployment.programData,
      genesis: v.genesis,
      deploymentId: v.deploymentId,
    }),
    ix = ours[0],
    indices = ix.accountKeyIndexes ?? ix.accounts;
  const data =
    typeof ix.data === "string" ? decode58(ix.data) : Uint8Array.from(ix.data);
  assert(
    eq(data, expected.data) &&
      indices.length === expected.keys.length &&
      expected.keys.every((a, n) => a.pubkey.equals(address(keys[indices[n]]))),
    "Finalized bootstrap instruction differs from the reviewed configuration.",
  );
}
function decode58(s) {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n,
    z = 0;
  for (const ch of s) {
    const d = chars.indexOf(ch);
    assert(d >= 0, "Invalid instruction encoding.");
    n = n * 58n + BigInt(d);
  }
  for (const ch of s) {
    if (ch !== "1") break;
    z++;
  }
  const b = [];
  while (n) {
    b.unshift(Number(n & 255n));
    n >>= 8n;
  }
  return Uint8Array.from([...new Uint8Array(z), ...b]);
}
export async function prepareImmutableFinalization(
  configuration,
  { authority, bootstrapSignature, maxFeeLamports, connection } = {},
) {
  const v = config(configuration);
  assert(
    authority === v.upgradeAuthority,
    "Explicitly select the pinned public upgrade-authority wallet.",
  );
  connection = rpc(v, connection);
  const deployment = await inspect(v, connection),
    current = await readConfig(v, connection);
  assert(
    current.state,
    "Initialize and confirm the exact configuration before finalization.",
  );
  await confirmBootstrap(v, connection, deployment, bootstrapSignature);
  // Solana loader-v3 SetAuthority, enum discriminant4 (u32 LE), omitting a new authority permanently disables upgrades.
  const instruction = new TransactionInstruction({
    programId: UPGRADEABLE_LOADER,
    keys: [
      {
        pubkey: address(deployment.programData),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: address(v.upgradeAuthority),
        isSigner: true,
        isWritable: false,
      },
    ],
    data: Buffer.from([4, 0, 0, 0]),
  });
  return prepared(v, connection, deployment, instruction, {
    operation: "make-program-immutable",
    rentLamports: 0n,
    maxFeeLamports,
    maxRentLamports: 0n,
    bootstrapSignature,
  });
}
