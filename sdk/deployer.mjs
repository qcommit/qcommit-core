/** Explicit wallet-signed loader-v3 deployment. All journals and seeds are public. */
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  address,
  raw,
  hex,
  integer,
  concat,
  u64,
  deriveConfig,
  decodeConfig,
  CONFIG_BYTES,
} from "./codec.mjs";
import { GENESIS, UPGRADEABLE_LOADER, openNetwork } from "./network.mjs";
import { initializeConfigInstruction } from "./instructions.mjs";
import { base58, SubmissionUncertain } from "./transport.mjs";
export { serializeTransaction, deserializeTransaction } from "./transport.mjs";
const CHUNK = 900,
  FORMAT = "qcommit/deployment-plan/1";
const assert = (v, m) => {
  if (!v) throw new Error(m);
};
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const u32 = (n) => {
  assert(Number.isInteger(n) && n >= 0 && n <= 0xffffffff, "Invalid u32.");
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const random = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const publicKey = (p) => address(p?.publicKey ?? p).toBase58();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function deploymentHeader(plan) {
  return {
    format: FORMAT,
    authority: plan.authority,
    programSeed: plan.programSeed,
    bufferSeed: plan.bufferSeed,
    deploymentId: plan.deploymentId,
  };
}
export function createOperatorConnection(plan) {
  const url = new URL(plan.rpc);
  return new Connection(url.href, {
    commitment: "finalized",
    disableRetryOnRateLimit: true,
    fetch: (target, init) => {
      const headers = new Headers(init?.headers);
      if (url.pathname.startsWith("/rpc/operator/"))
        headers.set(
          "X-Qcommit-Deployment",
          JSON.stringify(deploymentHeader(plan)),
        );
      return globalThis.fetch(target, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    },
  });
}
async function checkPlan(plan, binary) {
  assert(
    plan?.format === FORMAT &&
      ["localnet", "devnet", "mainnet-beta"].includes(plan.cluster),
    "Invalid deployment plan.",
  );
  assert(
    binary instanceof Uint8Array &&
      binary.length >= 4 &&
      binary.length <= 2097152 &&
      binary[0] === 127 &&
      binary[1] === 69 &&
      binary[2] === 76 &&
      binary[3] === 70,
    "Expected a bounded reviewed ELF artifact.",
  );
  assert(
    plan.binarySize === binary.length &&
      hex(sha256(binary)) === plan.binarySha256,
    "Deployment binary differs from the reviewed plan.",
  );
  raw(plan.binarySha256);
  raw(plan.deploymentId);
  assert(
    raw(plan.deploymentId).some(Boolean),
    "Deployment ID must be nonzero.",
  );
  for (const key of ["programSeed", "bufferSeed"])
    assert(
      typeof plan[key] === "string" && /^[0-9a-f]{32}$/.test(plan[key]),
      "Deployment seeds must be public32-characterhex.",
    );
  assert(
    plan.programSeed !== plan.bufferSeed,
    "Deployment account seeds must differ.",
  );
  address(plan.authority);
  address(plan.genesis);
  if (GENESIS[plan.cluster])
    assert(
      plan.genesis === GENESIS[plan.cluster],
      "Deployment genesis/cluster mismatch.",
    );
  const url = new URL(plan.rpc);
  assert(
    !url.username && !url.password && !url.hash,
    "RPC credentials/fragments are forbidden.",
  );
  assert(
    plan.cluster === "localnet"
      ? url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname)
      : url.protocol === "https:",
    "Public deployment requires HTTPS; localnet requires literal loopback.",
  );
  if (url.pathname.startsWith("/rpc/operator/"))
    assert(
      url.pathname === "/rpc/operator/" + plan.cluster,
      "Operator RPC route cluster mismatch.",
    );
  const [program, buffer] = await Promise.all([
    PublicKey.createWithSeed(
      address(plan.authority),
      plan.programSeed,
      UPGRADEABLE_LOADER,
    ),
    PublicKey.createWithSeed(
      address(plan.authority),
      plan.bufferSeed,
      UPGRADEABLE_LOADER,
    ),
  ]);
  const [programData] = PublicKey.findProgramAddressSync(
    [program.toBytes()],
    UPGRADEABLE_LOADER,
  );
  assert(
    program.toBase58() === plan.program &&
      buffer.toBase58() === plan.buffer &&
      programData.toBase58() === plan.programData,
    "Seed-derived deployment addresses mismatch.",
  );
  assert(
    integer(plan.maxFeeLamports) > 0n &&
      integer(plan.maxFeeLamports) <= 100000000n &&
      integer(plan.maxTotalLamports) > 0n,
    "Invalid deployment fee/total caps.",
  );
  return plan;
}
async function connectionFor(plan, binary, provided) {
  await checkPlan(plan, binary);
  const c = provided ?? createOperatorConnection(plan);
  assert(
    new URL(c.rpcEndpoint).href === new URL(plan.rpc).href,
    "Deployment RPC endpoint mismatch.",
  );
  assert(
    (await c.getGenesisHash()) === plan.genesis,
    "Actual RPC genesis changed.",
  );
  return c;
}
export async function deploymentInstructions(plan, binary, connection) {
  await checkPlan(plan, binary);
  const authority = address(plan.authority),
    buffer = address(plan.buffer),
    program = address(plan.program),
    programData = address(plan.programData);
  const mintRent = integer(
      await connection.getMinimumBalanceForRentExemption(36, "finalized"),
    ),
    bufferRent = integer(
      await connection.getMinimumBalanceForRentExemption(
        37 + binary.length,
        "finalized",
      ),
    );
  const setup = [
    SystemProgram.createAccountWithSeed({
      fromPubkey: authority,
      basePubkey: authority,
      seed: plan.bufferSeed,
      newAccountPubkey: buffer,
      lamports: Number(bufferRent),
      space: 37 + binary.length,
      programId: UPGRADEABLE_LOADER,
    }),
    new TransactionInstruction({
      programId: UPGRADEABLE_LOADER,
      keys: [
        { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(u32(0)),
    }),
  ];
  const write = (offset) => {
    assert(
      hex(sha256(binary)) === plan.binarySha256,
      "Deployment artifact changed before a write.",
    );
    assert(
      Number.isInteger(offset) &&
        offset >= 0 &&
        offset < binary.length &&
        offset % CHUNK === 0,
      "Invalid deployment chunk offset.",
    );
    const chunk = binary.slice(offset, offset + CHUNK);
    return new TransactionInstruction({
      programId: UPGRADEABLE_LOADER,
      keys: [
        { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(concat(u32(1), u32(offset), u64(chunk.length), chunk)),
    });
  };
  const deploy = [
    SystemProgram.createAccountWithSeed({
      fromPubkey: authority,
      basePubkey: authority,
      seed: plan.programSeed,
      newAccountPubkey: program,
      lamports: Number(mintRent),
      space: 36,
      programId: UPGRADEABLE_LOADER,
    }),
    new TransactionInstruction({
      programId: UPGRADEABLE_LOADER,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: programData, isSigner: false, isWritable: true },
        { pubkey: program, isSigner: false, isWritable: true },
        { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: authority, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(concat(u32(2), u64(binary.length))),
    }),
  ];
  const bootstrap = [
    initializeConfigInstruction({
      program,
      payer: authority,
      programData,
      genesis: plan.genesis,
      deploymentId: plan.deploymentId,
    }),
  ];
  const finalize = [
    new TransactionInstruction({
      programId: UPGRADEABLE_LOADER,
      keys: [
        { pubkey: programData, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(u32(4)),
    }),
  ];
  return { setup, write, deploy, bootstrap, finalize };
}
async function quote(plan, binary, connection) {
  const sizes = [37 + binary.length, 45 + binary.length, 36, CONFIG_BYTES],
    rents = [];
  for (const n of sizes)
    rents.push(
      integer(
        await connection.getMinimumBalanceForRentExemption(n, "finalized"),
      ),
    );
  const transactionCount = Math.ceil(binary.length / CHUNK) + 4;
  const instructions = await deploymentInstructions(plan, binary, connection),
    latest = await connection.getLatestBlockhash("finalized"),
    t = new Transaction({
      feePayer: address(plan.authority),
      recentBlockhash: latest.blockhash,
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1200000 }),
      ...instructions.bootstrap,
    );
  const fee = (
    await connection.getFeeForMessage(t.compileMessage(), "finalized")
  ).value;
  assert(fee !== null, "RPC cannot quote deployment network fees.");
  const expectedNetworkFees = integer(fee) * BigInt(transactionCount),
    permanentRent = rents[1] + rents[2] + rents[3],
    conservativeBalance =
      rents[0] + permanentRent + integer(plan.maxFeeLamports);
  assert(
    expectedNetworkFees <= integer(plan.maxFeeLamports),
    "Expected deployment fees exceed approved cap.",
  );
  assert(
    permanentRent + integer(plan.maxFeeLamports) <=
      integer(plan.maxTotalLamports),
    "Deployment permanent rent and fee budget exceed approved total cap.",
  );
  return {
    binaryBytes: binary.length,
    writeTransactions: Math.ceil(binary.length / CHUNK),
    transactionCount,
    bufferRentLamports: rents[0].toString(),
    programDataRentLamports: rents[1].toString(),
    programAccountRentLamports: rents[2].toString(),
    configRentLamports: rents[3].toString(),
    permanentRentLamports: permanentRent.toString(),
    expectedNetworkFeeLamports: expectedNetworkFees.toString(),
    conservativeFundingLamports: conservativeBalance.toString(),
    requiredFundingLamports: (
      permanentRent + integer(plan.maxFeeLamports)
    ).toString(),
    estimatedFeePerTransactionLamports: integer(fee).toString(),
    expectedNetCostLamports: (permanentRent + expectedNetworkFees).toString(),
    scope:
      "Conservative funding bound includes buffer and ProgramData simultaneously. Actual loader deploy credits buffer lamports before allocating ProgramData; final cost is permanent rent plus actual fees. No funds are moved during preparation.",
  };
}
function freshJournal(plan, source) {
  if (source !== undefined) {
    assert(
      source &&
        source.format === "qcommit/deployment-journal/1" &&
        Array.isArray(source.records) &&
        source.records.length <= 3000,
      "Invalid public deployment journal.",
    );
    assert(
      JSON.stringify(source.plan) === JSON.stringify(plan),
      "Journal plan does not match the selected deployment.",
    );
    for (const row of source.records)
      assert(
        row &&
          [
            "prepared",
            "broadcasting",
            "confirmed",
            "expired-unobserved",
          ].includes(row.phase) &&
          typeof row.signature === "string" &&
          /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(row.signature),
        "Invalid deployment journal entry.",
      );
  }
  return {
    format: "qcommit/deployment-journal/1",
    plan: { ...plan },
    records: source ? structuredClone(source.records) : [],
    ...(source?.deploymentSignature !== undefined
      ? { deploymentSignature: source.deploymentSignature }
      : {}),
  };
}
export async function prepareDeployment({
  cluster,
  rpc,
  payer,
  binary,
  binarySha256,
  journal,
  maxFeeLamports = "2000000",
  maxTotalLamports = "3000000000",
  connection,
}) {
  const authority = publicKey(payer);
  let plan;
  if (journal) {
    plan = { ...journal.plan };
    assert(
      plan.authority === authority &&
        plan.cluster === cluster &&
        new URL(plan.rpc).href === new URL(rpc).href &&
        plan.binarySha256 === binarySha256,
      "Public journal belongs to another wallet, network or binary.",
    );
    assert(
      integer(plan.maxFeeLamports) <= integer(maxFeeLamports) &&
        integer(plan.maxTotalLamports) <= integer(maxTotalLamports),
      "Imported journal raises the currently approved spending caps.",
    );
  } else {
    const programSeed = random(16),
      bufferSeed = random(16),
      deploymentId = random(32),
      [program, buffer] = await Promise.all([
        PublicKey.createWithSeed(
          address(authority),
          programSeed,
          UPGRADEABLE_LOADER,
        ),
        PublicKey.createWithSeed(
          address(authority),
          bufferSeed,
          UPGRADEABLE_LOADER,
        ),
      ]),
      [programData] = PublicKey.findProgramAddressSync(
        [program.toBytes()],
        UPGRADEABLE_LOADER,
      );
    const initial = {
      cluster,
      rpc,
      authority,
      programSeed,
      bufferSeed,
      deploymentId,
    };
    const c = connection ?? createOperatorConnection(initial),
      genesis = await c.getGenesisHash();
    plan = {
      format: FORMAT,
      ...initial,
      genesis,
      program: program.toBase58(),
      buffer: buffer.toBase58(),
      programData: programData.toBase58(),
      binarySha256,
      binarySize: binary.length,
      maxFeeLamports: integer(maxFeeLamports).toString(),
      maxTotalLamports: integer(maxTotalLamports).toString(),
    };
  }
  const c = await connectionFor(plan, binary, connection),
    state = await snapshot(plan, binary, c),
    cost = await quote(plan, binary, c);
  const recoveredJournal = freshJournal(plan, journal);
  const deploymentEvidence = state.deployed
    ? verifyNativeDeployment(plan, state, await history(plan, c))
    : null;
  if (deploymentEvidence)
    retainDeploymentEvidence(recoveredJournal, deploymentEvidence);
  return {
    plan,
    journal: recoveredJournal,
    deploymentEvidence,
    quote: {
      ...cost,
      balanceLamports: integer(
        await c.getBalance(address(plan.authority), "finalized"),
      ).toString(),
      remainingFundingLamports: remainingFunding(cost, state).toString(),
    },
    state,
    review: {
      authority,
      cluster: plan.cluster,
      genesis: plan.genesis,
      program: plan.program,
      buffer: plan.buffer,
      programData: plan.programData,
      deploymentId: plan.deploymentId,
      binarySha256: plan.binarySha256,
      binaryBytes: plan.binarySize,
      irreversible: false,
      action:
        "Create loader accounts, upload these exact program bytes, deploy and initialize configuration. Removing upgrade authority requires a separate explicit action.",
    },
  };
}
async function snapshot(plan, binary, c) {
  assert(
    binary.length === plan.binarySize &&
      hex(sha256(binary)) === plan.binarySha256,
    "Deployment artifact changed during the operation.",
  );
  assert(
    (await c.getGenesisHash()) === plan.genesis,
    "Deployment RPC genesis changed.",
  );
  const [program, buffer, data, config] = await c.getMultipleAccountsInfo(
    [
      address(plan.program),
      address(plan.buffer),
      address(plan.programData),
      deriveConfig(plan.program).config,
    ],
    "finalized",
  );
  let deployed = false,
    immutable = false,
    uploaded = [];
  if (program) {
    assert(
      program.executable &&
        program.owner.equals(UPGRADEABLE_LOADER) &&
        program.data.length === 36 &&
        program.data.readUInt32LE(0) === 2 &&
        address(program.data.subarray(4)).toBase58() === plan.programData,
      "Existing program address is occupied by unexpected data.",
    );
    assert(
      data &&
        !data.executable &&
        data.owner.equals(UPGRADEABLE_LOADER) &&
        data.data.length === 45 + binary.length &&
        data.data.readUInt32LE(0) === 3 &&
        data.data[12] <= 1,
      "Existing ProgramData differs from plan.",
    );
    immutable = data.data[12] === 0;
    assert(
      immutable ||
        address(data.data.subarray(13, 45)).toBase58() === plan.authority,
      "Program upgrade authority changed.",
    );
    assert(
      equal(data.data.subarray(45), binary),
      "Deployed program bytes differ from pinned artifact.",
    );
    deployed = true;
  } else {
    assert(
      !data,
      "ProgramData exists without the expected executable program.",
    );
  }
  if (buffer) {
    assert(
      buffer.owner.equals(UPGRADEABLE_LOADER) &&
        !buffer.executable &&
        buffer.data.length === 37 + binary.length &&
        buffer.data.readUInt32LE(0) === 1 &&
        buffer.data[4] === 1 &&
        address(buffer.data.subarray(5, 37)).toBase58() === plan.authority,
      "Buffer address is occupied by unexpected data/authority.",
    );
    for (let offset = 0; offset < binary.length; offset += CHUNK) {
      const part = buffer.data.subarray(
          37 + offset,
          37 + Math.min(binary.length, offset + CHUNK),
        ),
        expected = binary.subarray(offset, offset + CHUNK);
      if (equal(part, expected)) uploaded.push(offset);
      else
        assert(
          !part.some(Boolean),
          "Existing buffer contains a changed/partial chunk; refusing overwrite.",
        );
    }
  }
  let initialized = false;
  if (config) {
    assert(
      deployed &&
        !config.executable &&
        config.owner.equals(address(plan.program)),
      "Unexpected deployment configuration account.",
    );
    const decoded = decodeConfig(Uint8Array.from(config.data)),
      { bump } = deriveConfig(plan.program);
    assert(
      decoded.bump === bump &&
        decoded.genesis === plan.genesis &&
        decoded.deploymentId === plan.deploymentId &&
        decoded.bootstrapAuthority === plan.authority,
      "Existing configuration differs from the approved deployment.",
    );
    initialized = true;
  }
  return {
    deployed,
    immutable,
    initialized,
    bufferExists: !!buffer,
    uploadedOffsets: uploaded,
    bufferComplete: uploaded.length === Math.ceil(binary.length / CHUNK),
    deployedSlot: deployed ? data.data.readBigUInt64LE(4).toString() : null,
  };
}
function remainingFunding(cost, state) {
  const writes = state.deployed
    ? 0
    : cost.writeTransactions - state.uploadedOffsets.length;
  const count =
    (state.deployed ? 0 : (state.bufferExists ? 0 : 1) + writes + 1) +
    (state.initialized ? 0 : 1) +
    (state.immutable ? 0 : 1);
  let rent = state.initialized ? 0n : integer(cost.configRentLamports);
  if (!state.deployed)
    rent +=
      integer(cost.programDataRentLamports) +
      integer(cost.programAccountRentLamports) -
      (state.bufferExists ? integer(cost.bufferRentLamports) : 0n);
  return (
    (rent < 0n ? 0n : rent) +
    BigInt(count) * integer(cost.estimatedFeePerTransactionLamports)
  );
}
function serialJournalWriter(callback) {
  let previous = Promise.resolve();
  return (snapshot) => {
    previous = previous.then(() => callback?.(snapshot));
    return previous;
  };
}
async function pool(items, fn, limit = 4) {
  const out = new Array(items.length);
  let at = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (at < items.length) {
        const i = at++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
async function history(plan, c) {
  const lists = await Promise.all([
    c.getSignaturesForAddress(
      address(plan.buffer),
      { limit: 1000 },
      "finalized",
    ),
    c.getSignaturesForAddress(
      address(plan.program),
      { limit: 1000 },
      "finalized",
    ),
  ]);
  assert(
    lists.every((l) => l.length < 1000),
    "Deployment history exceeds bounded audit; inspect before resuming.",
  );
  const signatures = [...new Set(lists.flat().map((r) => r.signature))];
  return pool(signatures, async (signature) => {
    const tx = await c.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    assert(
      tx?.meta && tx.transaction.signatures?.[0] === signature,
      "Deployment transaction history is incomplete or mismatched.",
    );
    return { signature, tx };
  });
}
const keysOf = (tx) => {
  const m = tx.transaction.message;
  return (
    m.accountKeys ?? [
      ...m.staticAccountKeys,
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ]
  );
};
async function auditResume(plan, journal, c) {
  const latest = new Map();
  for (const row of journal.records) latest.set(row.signature, row);
  for (const row of latest.values()) {
    if (row.phase !== "broadcasting") continue;
    const status = (
      await c.getSignatureStatuses([row.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.confirmationStatus === "finalized") {
      const tx = await c.getTransaction(row.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      assert(
        tx?.meta,
        "Finalized deployment transaction metadata is unavailable.",
      );
      journal.records.push({
        ...row,
        phase: "confirmed",
        slot: String(tx.slot),
        feeLamports: String(tx.meta.fee),
        error: tx.meta.err ?? null,
      });
      continue;
    }
    if (status)
      throw new SubmissionUncertain(
        row.signature,
        "A previous deployment transaction has not finalized.",
      );
    const height = integer(await c.getBlockHeight("finalized"));
    if (height <= integer(row.lastValidBlockHeight))
      throw new SubmissionUncertain(
        row.signature,
        "Previous broadcast may still land; wait for explicit confirmation or expiry.",
      );
    journal.records.push({ ...row, phase: "expired-unobserved" });
  }
  const transactions = await history(plan, c);
  const observed = new Set(transactions.map((row) => row.signature));
  for (const row of journal.records)
    if (row.phase === "confirmed")
      assert(
        observed.has(row.signature),
        "Previously confirmed deployment history is unavailable; fee recovery cannot be established.",
      );
  let fees = 0n;
  for (const { tx } of transactions)
    if (address(keysOf(tx)[0]).toBase58() === plan.authority)
      fees += integer(tx.meta.fee);
  assert(
    fees <= integer(plan.maxFeeLamports),
    "Previous deployment fees exhausted the approved budget.",
  );
  return { fees, transactions };
}
function transaction(plan, item, latest) {
  return new Transaction({
    feePayer: address(plan.authority),
    recentBlockhash: latest.blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1200000 }),
    ...item.instructions,
  );
}
async function signerBatch(payer, transactions) {
  let signed;
  if (
    transactions.length > 1 &&
    typeof payer.signAllTransactions === "function"
  )
    signed = await payer.signAllTransactions(transactions);
  else {
    signed = [];
    for (const tx of transactions) signed.push(await payer.signTransaction(tx));
  }
  assert(
    Array.isArray(signed) && signed.length === transactions.length,
    "Wallet returned an unexpected signed transaction count.",
  );
  return signed.map((s) => (s instanceof Uint8Array ? Transaction.from(s) : s));
}
export async function waitForProgramVisibility(
  connection,
  deployedSlot,
  { timeoutMs = 30000, pollIntervalMs = 500, onProgress } = {},
) {
  const deployed = integer(deployedSlot),
    minimum = deployed + 1n;
  assert(
    minimum <= BigInt(Number.MAX_SAFE_INTEGER),
    "Program visibility slot exceeds safe RPC integer range.",
  );
  assert(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs >= 1 &&
      timeoutMs <= 60000 &&
      Number.isSafeInteger(pollIntervalMs) &&
      pollIntervalMs >= 0 &&
      pollIntervalMs <= 1000,
    "Invalid bounded visibility deadline.",
  );
  const started = Date.now(),
    deadline = started + timeoutMs,
    observed = [];
  while (Date.now() <= deadline) {
    const slot = integer(await connection.getSlot("finalized"));
    observed.push(slot.toString());
    onProgress?.({
      phase: "await-program-visibility",
      deployedSlot: deployed.toString(),
      observedFinalizedSlot: slot.toString(),
      requiredFinalizedSlot: minimum.toString(),
    });
    if (slot >= minimum)
      return {
        deployedSlot: deployed.toString(),
        minContextSlot: Number(minimum),
        observedFinalizedSlots: observed,
        elapsedMs: Date.now() - started,
      };
    await sleep(pollIntervalMs);
  }
  const evidence = {
    deployedSlot: deployed.toString(),
    requiredFinalizedSlot: minimum.toString(),
    observedFinalizedSlots: observed,
    elapsedMs: Date.now() - started,
  };
  const error = new Error(
    "Program is not yet visible in a newer finalized bank: " +
      JSON.stringify(evidence),
  );
  error.name = "ProgramVisibilityError";
  error.visibility = evidence;
  throw error;
}
async function sendBatch(
  plan,
  payer,
  items,
  c,
  journal,
  budget,
  onJournal,
  onProgress,
) {
  assert(
    items.length >= 1 && items.length <= 10,
    "Wallet batch must contain1..10 transactions.",
  );
  assert(
    publicKey(payer) === plan.authority &&
      typeof payer.signTransaction === "function",
    "Connect the exact selected funding wallet.",
  );
  assert(
    (await c.getGenesisHash()) === plan.genesis,
    "RPC genesis changed before wallet approval.",
  );
  const minContextSlot = items.reduce(
    (n, item) => Math.max(n, item.minContextSlot ?? 0),
    0,
  );
  const latest = await c.getLatestBlockhash(
      minContextSlot
        ? { commitment: "finalized", minContextSlot }
        : "finalized",
    ),
    transactions = items.map((item) => transaction(plan, item, latest)),
    messages = transactions.map((tx) => Uint8Array.from(tx.serializeMessage())),
    fees = [];
  for (const tx of transactions) {
    const wire = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    assert(wire.length <= 1232, "Deployment transaction exceeds1,232 bytes.");
    const quoted = (await c.getFeeForMessage(tx.compileMessage(), "finalized"))
      .value;
    assert(quoted !== null, "RPC fee quote unavailable.");
    fees.push(integer(quoted));
    const sim = await c.simulateTransaction(
      VersionedTransaction.deserialize(wire),
      {
        commitment: "finalized",
        sigVerify: false,
        replaceRecentBlockhash: false,
        ...(minContextSlot ? { minContextSlot } : {}),
      },
    );
    assert(
      !minContextSlot ||
        (Number.isSafeInteger(sim.context?.slot) &&
          sim.context.slot >= minContextSlot),
      "Deployment simulation used an unproven or stale bank: " +
        JSON.stringify({ minContextSlot, actualContext: sim.context ?? null }),
    );
    assert(
      sim.value && !sim.value.err,
      "Deployment simulation failed: " +
        JSON.stringify({
          error: sim.value?.err ?? "missing result",
          context: sim.context ?? null,
          minContextSlot,
        }),
    );
  }
  const batchFee = fees.reduce((a, b) => a + b, 0n);
  assert(
    budget.spent + batchFee <= integer(plan.maxFeeLamports),
    "Deployment batch exceeds approved cumulative fee cap.",
  );
  onProgress?.({
    phase: "wallet-approval",
    transactions: items.length,
    labels: items.map((i) => i.label),
    quotedFeeLamports: batchFee.toString(),
    program: plan.program,
  });
  const signed = await signerBatch(payer, transactions),
    wires = [];
  for (let i = 0; i < signed.length; i++) {
    assert(
      signed[i] instanceof Transaction &&
        equal(signed[i].serializeMessage(), messages[i]),
      "Wallet changed an approved deployment message. Nothing from this batch was sent.",
    );
    const wire = signed[i].serialize({
      requireAllSignatures: true,
      verifySignatures: true,
    });
    assert(wire.length <= 1232, "Signed transaction exceeds wire limit.");
    wires.push(wire);
  }
  assert(
    integer(await c.getBlockHeight("finalized")) <=
      integer(latest.lastValidBlockHeight),
    "Deployment blockhash expired while awaiting wallet approval. No transaction from this batch was sent.",
  );
  const pending = wires.map((wire, i) => ({
    phase: "prepared",
    label: items[i].label,
    signature: base58(VersionedTransaction.deserialize(wire).signatures[0]),
    blockhash: latest.blockhash,
    lastValidBlockHeight: String(latest.lastValidBlockHeight),
    quotedFeeLamports: fees[i].toString(),
    bytes: wire.length,
    ...(items[i].offset === undefined ? {} : { offset: items[i].offset }),
  }));
  journal.records.push(...pending);
  await onJournal?.(structuredClone(journal));
  // Broadcast the entire approved batch promptly (at most4 concurrent RPC calls),
  // then await finality. Waiting for each4 before broadcasting the next4 would
  // unnecessarily age the shared blockhash and could expire later transactions.
  for (let start = 0; start < wires.length; start += 4) {
    const group = wires.slice(start, start + 4);
    const results = await Promise.allSettled(
      group.map(async (wire, j) => {
        const row = pending[start + j];
        journal.records.push({ ...row, phase: "broadcasting" });
        await onJournal?.(structuredClone(journal));
        try {
          const returned = await c.sendRawTransaction(wire, {
            skipPreflight: false,
            preflightCommitment: "confirmed",
            maxRetries: 3,
            ...(minContextSlot ? { minContextSlot } : {}),
          });
          if (returned !== row.signature)
            throw new Error("RPC signature mismatch.");
        } catch {
          throw new SubmissionUncertain(
            row.signature,
            "Deployment broadcast acknowledgement is uncertain.",
          );
        }
      }),
    );
    const failure = results.find((r) => r.status === "rejected");
    if (failure) throw failure.reason;
  }
  const deadline = Date.now() + 120000;
  const confirmed = await Promise.allSettled(
    pending.map(async (row) => {
      let state;
      while (Date.now() < deadline) {
        try {
          state = (
            await c.getSignatureStatuses([row.signature], {
              searchTransactionHistory: true,
            })
          ).value[0];
        } catch {
          throw new SubmissionUncertain(
            row.signature,
            "Deployment confirmation RPC failed.",
          );
        }
        if (state?.confirmationStatus === "finalized") break;
        if (
          !state &&
          integer(await c.getBlockHeight("finalized")) >
            integer(latest.lastValidBlockHeight)
        )
          throw new SubmissionUncertain(
            row.signature,
            "Deployment blockhash expired without a finalized result.",
          );
        await sleep(1000);
      }
      if (state?.confirmationStatus !== "finalized")
        throw new SubmissionUncertain(
          row.signature,
          "Deployment transaction did not finalize before the confirmation deadline.",
        );
      const tx = await c.getTransaction(row.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta)
        throw new SubmissionUncertain(
          row.signature,
          "Finalized deployment metadata is unavailable.",
        );
      budget.spent += integer(tx.meta.fee);
      journal.records.push({
        ...row,
        phase: "confirmed",
        slot: String(tx.slot),
        feeLamports: String(tx.meta.fee),
        error: tx.meta.err ?? null,
      });
      await onJournal?.(structuredClone(journal));
      assert(
        !state.err && !tx.meta.err,
        "Deployment transaction finalized with an execution error: " +
          row.signature,
      );
    }),
  );
  const failure = confirmed.find((r) => r.status === "rejected");
  if (failure) throw failure.reason;
  return pending.map((p) => p.signature);
}
function deploymentConfiguration(plan, immutable = false) {
  let rpc = plan.rpc;
  if (immutable) rpc = rpc.replace("/rpc/operator/", "/rpc/");
  return {
    format: "qcommit/network/1",
    cluster: plan.cluster,
    rpc,
    genesis: plan.genesis,
    program: plan.program,
    programSha256: plan.binarySha256,
    programSize: plan.binarySize,
    upgradeAuthority: immutable ? null : plan.authority,
    deploymentId: plan.deploymentId,
  };
}
function decodeBase58(s) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n,
    z = 0;
  for (const ch of s) {
    const x = alphabet.indexOf(ch);
    assert(x >= 0, "Invalid base58 instruction.");
    n = n * 58n + BigInt(x);
  }
  for (const ch of s) {
    if (ch !== "1") break;
    z++;
  }
  const out = [];
  while (n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  return Uint8Array.from([...new Uint8Array(z), ...out]);
}
export function verifyNativeDeployment(plan, state, transactions) {
  assert(
    state.deployed && state.deployedSlot !== null,
    "A current native deployment is required.",
  );
  const slot = integer(state.deployedSlot),
    program = address(plan.program),
    authority = address(plan.authority);
  const successful = transactions.filter(
    (row) =>
      row.tx?.meta &&
      !row.tx.meta.err &&
      keysOf(row.tx).some((key) => address(key).equals(program)),
  );
  assert(
    !successful.some((row) => integer(row.tx.slot) < slot),
    "Program address has successful history before this deployment; clean first-deployment provenance is unproven.",
  );
  const found = [];
  for (const row of successful) {
    assert(
      row.tx.transaction.signatures?.[0] === row.signature,
      "Native deployment transaction signature does not match the requested history row.",
    );
    const tx = row.tx;
    if (integer(tx.slot) !== slot) continue;
    const keys = keysOf(tx),
      message = tx.transaction.message,
      all = message.compiledInstructions ?? message.instructions;
    if (
      address(keys[0]).toBase58() !== plan.authority ||
      message.header?.numRequiredSignatures !== 1
    )
      continue;
    const body = [];
    let invalid = false;
    const budgets = new Set();
    for (const item of all) {
      const id = address(keys[item.programIdIndex]),
        data =
          typeof item.data === "string"
            ? decodeBase58(item.data)
            : Uint8Array.from(item.data),
        indices = item.accountKeyIndexes ?? item.accounts;
      if (id.equals(ComputeBudgetProgram.programId)) {
        if (body.length || indices.length || budgets.has(data[0])) {
          invalid = true;
          break;
        }
        budgets.add(data[0]);
        if (data[0] === 2) {
          if (
            data.length !== 5 ||
            new DataView(data.buffer, data.byteOffset, 5).getUint32(1, true) >
              1200000
          ) {
            invalid = true;
            break;
          }
        } else if (data[0] === 3) {
          if (
            data.length !== 9 ||
            new DataView(data.buffer, data.byteOffset, 9).getBigUint64(
              1,
              true,
            ) > 1000000n
          ) {
            invalid = true;
            break;
          }
        } else {
          invalid = true;
          break;
        }
      } else body.push({ id, data, indices });
    }
    if (invalid || body.length !== 2) continue;
    const [create, deploy] = body;
    if (
      !create.id.equals(SystemProgram.programId) ||
      create.data.length !== 124 ||
      create.indices.length !== 2 ||
      !deploy.id.equals(UPGRADEABLE_LOADER) ||
      deploy.data.length !== 12 ||
      deploy.indices.length !== 8
    )
      continue;
    if (
      !equal(create.data.subarray(0, 4), u32(3)) ||
      !equal(create.data.subarray(4, 36), authority.toBytes()) ||
      !equal(create.data.subarray(36, 44), u64(32)) ||
      new TextDecoder("utf-8", { fatal: true }).decode(
        create.data.subarray(44, 76),
      ) !== plan.programSeed ||
      !equal(create.data.subarray(84, 92), u64(36)) ||
      !equal(create.data.subarray(92), UPGRADEABLE_LOADER.toBytes())
    )
      continue;
    if (
      !address(keys[create.indices[0]]).equals(authority) ||
      !address(keys[create.indices[1]]).equals(program)
    )
      continue;
    const expected = [
      plan.authority,
      plan.programData,
      plan.program,
      plan.buffer,
      SYSVAR_RENT_PUBKEY.toBase58(),
      SYSVAR_CLOCK_PUBKEY.toBase58(),
      SystemProgram.programId.toBase58(),
      plan.authority,
    ];
    if (
      !equal(deploy.data, concat(u32(2), u64(plan.binarySize))) ||
      !expected.every(
        (key, n) => address(keys[deploy.indices[n]]).toBase58() === key,
      )
    )
      continue;
    const programIndex = create.indices[1];
    if (
      !Array.isArray(tx.meta.preBalances) ||
      !Array.isArray(tx.meta.postBalances) ||
      tx.meta.preBalances[programIndex] !== 0 ||
      integer(tx.meta.postBalances[programIndex]) !==
        new DataView(
          create.data.buffer,
          create.data.byteOffset,
          create.data.length,
        ).getBigUint64(76, true)
    )
      continue;
    found.push(row);
  }
  assert(
    found.length === 1,
    "Current ProgramData slot is not an exact successful first seeded CreateAccountWithSeed plus native DeployWithMaxDataLen transaction. Upgrade history is not accepted.",
  );
  return {
    format: "qcommit/native-deployment-evidence/1",
    deploymentSignature: found[0].signature,
    deployedSlot: state.deployedSlot,
    program: plan.program,
    programData: plan.programData,
    buffer: plan.buffer,
    authority: plan.authority,
    genesis: plan.genesis,
    deploymentId: plan.deploymentId,
    binarySha256: plan.binarySha256,
    binarySize: plan.binarySize,
    source:
      "Finalized RPC native transaction, current loader-owned code bytes, and bounded successful program history. Not a light-client proof or proof that an RPC retained all older history.",
  };
}
function retainDeploymentEvidence(journal, evidence) {
  if (journal.deploymentSignature !== undefined)
    assert(
      journal.deploymentSignature === evidence.deploymentSignature,
      "Public journal deployment signature differs from actual native deployment.",
    );
  journal.deploymentSignature = evidence.deploymentSignature;
  journal.deploymentEvidence = evidence;
}
function matchingBootstrap(plan, state, transactions) {
  const expected = initializeConfigInstruction({
    program: plan.program,
    payer: plan.authority,
    programData: plan.programData,
    genesis: plan.genesis,
    deploymentId: plan.deploymentId,
  });
  for (const { signature, tx } of transactions) {
    if (
      tx.meta.err ||
      integer(tx.slot) <= integer(state.deployedSlot) ||
      address(keysOf(tx)[0]).toBase58() !== plan.authority
    )
      continue;
    const keys = keysOf(tx),
      m = tx.transaction.message,
      all = m.compiledInstructions ?? m.instructions;
    if (
      !all.every((ix) =>
        [plan.program, "ComputeBudget111111111111111111111111111111"].includes(
          address(keys[ix.programIdIndex]).toBase58(),
        ),
      )
    )
      continue;
    const ours = all.filter(
      (ix) => address(keys[ix.programIdIndex]).toBase58() === plan.program,
    );
    if (ours.length !== 1) continue;
    const i = ours[0],
      data = typeof i.data === "string" ? decodeBase58(i.data) : i.data,
      indices = i.accountKeyIndexes ?? i.accounts;
    if (
      equal(data, expected.data) &&
      indices.length === expected.keys.length &&
      expected.keys.every((key, n) =>
        key.pubkey.equals(address(keys[indices[n]])),
      )
    )
      return signature;
  }
  return null;
}
export async function executeDeployment({
  plan,
  binary,
  payer,
  journal: previous,
  onJournal,
  onProgress,
  connection,
  batchSize = 10,
}) {
  assert(
    plan.cluster === "localnet" || typeof onJournal === "function",
    "Public deployment requires a durable journal callback.",
  );
  onJournal = serialJournalWriter(onJournal);
  assert(
    Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 10,
    "Deployment batch size must be1..10.",
  );
  const c = await connectionFor(plan, binary, connection),
    journal = freshJournal(plan, previous);
  const audit = await auditResume(plan, journal, c),
    budget = { spent: audit.fees };
  await onJournal?.(structuredClone(journal));
  const cost = await quote(plan, binary, c),
    balance = integer(await c.getBalance(address(plan.authority), "finalized"));
  let state = await snapshot(plan, binary, c);
  assert(
    !(state.bufferExists || state.deployed) || audit.transactions.length > 0,
    "Existing deployment accounts have no available transaction history; refusing to reset fees.",
  );
  assert(
    balance >= remainingFunding(cost, state),
    "Funding wallet has insufficient remaining deployment funds.",
  );
  const instructions = await deploymentInstructions(plan, binary, c);
  if (!state.deployed) {
    if (!state.bufferExists) {
      onProgress?.({ phase: "create-buffer", program: plan.program });
      await sendBatch(
        plan,
        payer,
        [{ label: "create-buffer", instructions: instructions.setup }],
        c,
        journal,
        budget,
        onJournal,
        onProgress,
      );
      state = await snapshot(plan, binary, c);
      assert(state.bufferExists, "Buffer initialization did not finalize.");
    }
    let todo = [];
    for (let offset = 0; offset < binary.length; offset += CHUNK)
      if (!state.uploadedOffsets.includes(offset)) todo.push(offset);
    for (let start = 0; start < todo.length; start += batchSize) {
      const offsets = todo.slice(start, start + batchSize);
      onProgress?.({
        phase: "upload",
        completedBytes: Math.min(
          binary.length,
          (Math.ceil(binary.length / CHUNK) - todo.length + start) * CHUNK,
        ),
        totalBytes: binary.length,
      });
      await sendBatch(
        plan,
        payer,
        offsets.map((offset) => ({
          label: "write-buffer-" + offset,
          offset,
          instructions: [instructions.write(offset)],
        })),
        c,
        journal,
        budget,
        onJournal,
        onProgress,
      );
      state = await snapshot(plan, binary, c);
      assert(
        offsets.every((o) => state.uploadedOffsets.includes(o)),
        "Finalized buffer bytes do not match the reviewed artifact.",
      );
    }
    assert(state.bufferComplete, "Buffer is incomplete.");
    onProgress?.({ phase: "deploy-program", program: plan.program });
    await sendBatch(
      plan,
      payer,
      [{ label: "deploy-program", instructions: instructions.deploy }],
      c,
      journal,
      budget,
      onJournal,
      onProgress,
    );
    state = await snapshot(plan, binary, c);
    assert(
      state.deployed && !state.immutable,
      "Program deployment did not establish the expected mutable authority.",
    );
  }
  const deploymentEvidence = verifyNativeDeployment(
    plan,
    state,
    await history(plan, c),
  );
  retainDeploymentEvidence(journal, deploymentEvidence);
  await onJournal?.(structuredClone(journal));
  if (!state.initialized) {
    assert(
      !state.immutable,
      "Program was made immutable before configuration was initialized.",
    );
    const visibility = await waitForProgramVisibility(c, state.deployedSlot, {
      onProgress,
    });
    const rechecked = await snapshot(plan, binary, c);
    assert(
      rechecked.deployedSlot === state.deployedSlot &&
        !rechecked.immutable &&
        !rechecked.initialized,
      "Deployment/config changed while waiting for program visibility.",
    );
    journal.visibility = visibility;
    await onJournal?.(structuredClone(journal));
    onProgress?.({
      phase: "initialize-config",
      program: plan.program,
      visibility,
    });
    await sendBatch(
      plan,
      payer,
      [
        {
          label: "initialize-config",
          instructions: instructions.bootstrap,
          minContextSlot: visibility.minContextSlot,
        },
      ],
      c,
      journal,
      budget,
      onJournal,
      onProgress,
    );
    state = await snapshot(plan, binary, c);
    assert(state.initialized, "Configuration did not initialize.");
  }
  const bootstrapSignature = matchingBootstrap(
    plan,
    state,
    await history(plan, c),
  );
  assert(
    bootstrapSignature,
    "Exact finalized bootstrap transaction is unavailable.",
  );
  await onJournal?.(structuredClone(journal));
  return {
    configuration: deploymentConfiguration(plan, state.immutable),
    journal,
    bootstrapSignature,
    readyForFinalization: !state.immutable,
    deploymentSignature: deploymentEvidence.deploymentSignature,
    deploymentEvidence,
    program: plan.program,
    buffer: plan.buffer,
    state,
  };
}
export async function inspectFinalization({
  plan,
  binary,
  journal,
  connection,
}) {
  const c = await connectionFor(plan, binary, connection);
  freshJournal(plan, journal);
  const state = await snapshot(plan, binary, c);
  assert(
    state.deployed && state.initialized,
    "Deploy and initialize the exact program before finalization.",
  );
  const transactions = await history(plan, c),
    deploymentEvidence = verifyNativeDeployment(plan, state, transactions);
  if (journal?.deploymentSignature !== undefined)
    assert(
      journal.deploymentSignature === deploymentEvidence.deploymentSignature,
      "Journal deployment signature mismatch.",
    );
  const bootstrapSignature = matchingBootstrap(plan, state, transactions);
  assert(
    bootstrapSignature,
    "Exact finalized bootstrap transaction is unavailable.",
  );
  const instructions = await deploymentInstructions(plan, binary, c),
    latest = await c.getLatestBlockhash("finalized"),
    tx = transaction(plan, { instructions: instructions.finalize }, latest),
    fee = (await c.getFeeForMessage(tx.compileMessage(), "finalized")).value;
  assert(fee !== null, "Finalization fee quote is unavailable.");
  return {
    program: plan.program,
    authority: plan.authority,
    binarySha256: plan.binarySha256,
    genesis: plan.genesis,
    deploymentId: plan.deploymentId,
    bootstrapConfirmed: true,
    bootstrapSignature,
    deploymentSignature: deploymentEvidence.deploymentSignature,
    deploymentEvidence,
    upgradeAuthority: state.immutable ? null : plan.authority,
    estimatedFeeLamports: String(fee),
    ready: !state.immutable,
    alreadyImmutable: state.immutable,
    irreversible: true,
  };
}
export async function finalizeDeployment({
  plan,
  binary,
  payer,
  journal: previous,
  onJournal,
  onProgress,
  connection,
}) {
  assert(
    plan.cluster === "localnet" || typeof onJournal === "function",
    "Public deployment finalization requires a durable journal callback.",
  );
  onJournal = serialJournalWriter(onJournal);
  const c = await connectionFor(plan, binary, connection),
    journal = freshJournal(plan, previous),
    review = await inspectFinalization({
      plan,
      binary,
      journal,
      connection: c,
    });
  retainDeploymentEvidence(journal, review.deploymentEvidence);
  if (!review.alreadyImmutable) {
    const audit = await auditResume(plan, journal, c),
      budget = { spent: audit.fees },
      instructions = await deploymentInstructions(plan, binary, c);
    onProgress?.({ phase: "irreversible-finalization", ...review });
    await sendBatch(
      plan,
      payer,
      [
        {
          label: "make-program-immutable",
          instructions: instructions.finalize,
        },
      ],
      c,
      journal,
      budget,
      onJournal,
      onProgress,
    );
  }
  const state = await snapshot(plan, binary, c);
  assert(
    state.immutable && state.initialized,
    "Program immutability is not confirmed.",
  );
  const configuration = deploymentConfiguration(plan, true);
  await onJournal?.(structuredClone(journal));
  return {
    configuration,
    journal,
    program: plan.program,
    immutable: true,
    deploymentSignature: review.deploymentSignature,
    deploymentEvidence: review.deploymentEvidence,
    state,
  };
}
