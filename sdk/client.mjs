import { Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { assertNetwork } from "./network.mjs";
import { submitNetwork, integerAmount } from "./transport.mjs";
import * as c from "./codec.mjs";
import * as ix from "./instructions.mjs";
import { verifyApproval, createLaunchAuthorization } from "./approval.mjs";
import { verifyExecution } from "./receipt.mjs";
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const payerAddress = (p) => c.address(p?.publicKey ?? p).toBase58();
export async function readOwned(
  network,
  key,
  decode,
  { optional = false } = {},
) {
  const a = await network.connection.getAccountInfo(
    c.address(key),
    network.commitment,
  );
  if (!a) {
    if (optional) return null;
    throw new Error("Required on-chain account is missing.");
  }
  if (a.executable || !a.owner.equals(c.address(network.program)))
    throw new Error("Wrong account owner/executable flag.");
  return decode(Uint8Array.from(a.data));
}
export async function assertConfiguration(network) {
  await assertNetwork(network.connection, network);
  const { config, bump } = c.deriveConfig(network.program);
  const state = await readOwned(network, config, c.decodeConfig);
  if (
    state.bump !== bump ||
    state.genesis !== network.genesis ||
    state.deploymentId !== network.deploymentId
  )
    throw new Error(
      "On-chain configuration does not match the actual deployment/genesis.",
    );
  return state;
}
export async function getCreator(network, { payer, creatorPublicKey, salt }) {
  await assertConfiguration(network);
  const p = payerAddress(payer);
  salt ??= c.defaultCreatorSalt(network, p, creatorPublicKey);
  const derived = c.deriveCreator(
      network.program,
      network.genesis,
      network.deploymentId,
      p,
      creatorPublicKey,
      salt,
    ),
    { config } = c.deriveConfig(network.program);
  const state = await readOwned(network, derived.creator, c.decodeCreator, {
    optional: true,
  });
  if (
    state &&
    (state.bump !== derived.bump ||
      state.id !== c.hex(derived.id) ||
      state.config !== config.toBase58() ||
      state.creatorPublicKey !== c.hex(c.raw(creatorPublicKey)) ||
      state.salt !== c.hex(c.raw(salt)) ||
      state.payer !== p)
  )
    throw new Error("Creator identity binding mismatch.");
  return {
    creator: derived.creator.toBase58(),
    salt: c.hex(c.raw(salt)),
    state,
  };
}
async function expiry(network, value) {
  const slot = c.integer(await network.connection.getSlot(network.commitment));
  const exp = value === undefined ? slot + 3000n : c.integer(value);
  if (exp <= slot || exp > slot + 216000n)
    throw new Error("Expiry must be in the future and within 216,000 slots.");
  return exp.toString();
}
async function rent(network, sizes) {
  let n = 0n;
  for (const size of sizes)
    n += c.integer(
      await network.connection.getMinimumBalanceForRentExemption(
        size,
        network.commitment,
      ),
    );
  return n;
}
async function metadataFee(network) {
  // Metaplex immutable Token Metadata create fee: state/fee.rs CREATE_FEE_SCALAR=1308, OFFSET=5440.
  return (
    c.integer(
      await network.connection.getMinimumBalanceForRentExemption(
        1308,
        network.commitment,
      ),
    ) + 5440n
  );
}
async function feeQuote(network, payer, instruction, count) {
  const latest = await network.connection.getLatestBlockhash(
    network.commitment,
  );
  const tx = new Transaction({
    feePayer: c.address(payer),
    recentBlockhash: latest.blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1200000 }),
    instruction,
  );
  const f = await network.connection.getFeeForMessage(
    tx.compileMessage(),
    network.commitment,
  );
  if (f.value === null)
    throw new Error("RPC could not estimate the transaction fee.");
  return c.integer(f.value) * BigInt(count);
}
export async function prepareRegistration(network, options) {
  const payer = payerAddress(options.payer),
    creatorPublicKey = c.hex(c.raw(options.creatorPublicKey));
  const d = await getCreator(network, { ...options, payer });
  const registration = {
    version: 1,
    program: network.program,
    genesis: network.genesis,
    deploymentId: network.deploymentId,
    creator: d.creator,
    creatorPublicKey,
    payer,
    salt: d.salt,
    nonce: "0",
    expirySlot: await expiry(network, options.expirySlot),
  };
  const count =
    (!d.state ? 1 : 0) +
    1 +
    Math.ceil(c.SIGNATURE_BYTES / c.MAX_CHUNK_BYTES) +
    1 +
    8 +
    1;
  const rentLamports = await rent(network, [
    ...(!d.state ? [c.CREATOR_BYTES] : []),
    c.PROOF_BYTES,
  ]);
  const networkFeeLamports = await feeQuote(
    network,
    payer,
    ix.initializeCreatorInstruction(registration),
    count,
  );
  const estimate = {
    rentLamports: rentLamports.toString(),
    networkFeeLamports: networkFeeLamports.toString(),
    totalLamports: (rentLamports + networkFeeLamports).toString(),
    transactionCount: count,
  };
  return {
    registration,
    creator: d.creator,
    digest: c.registrationDigest(registration),
    context: c.CONTEXT,
    estimate,
    active: d.state?.active ?? false,
  };
}
export async function prepareLaunch(network, options) {
  const payer = payerAddress(options.payer),
    creatorPublicKey = c.hex(c.raw(options.creatorPublicKey)),
    d = await getCreator(network, { ...options, payer });
  if (!d.state?.active)
    throw new Error("Register and activate this creator identity first.");
  const addresses = c.deriveLaunch(
    network.program,
    d.creator,
    d.state.nonce,
    options.recipient ?? payer,
  );
  const maxExecutionRent = c
      .integer(
        options.maxExecutionRent ?? options.maxRentLamports ?? 100000000n,
      )
      .toString(),
    maxNetworkFee = c
      .integer(options.maxNetworkFee ?? options.maxFeeLamports ?? 10000000n)
      .toString();
  const intent = c.normalizeIntent({
    version: 1,
    program: network.program,
    genesis: network.genesis,
    deploymentId: network.deploymentId,
    creator: d.creator,
    epoch: "0",
    nonce: d.state.nonce,
    expirySlot: await expiry(network, options.expirySlot),
    tokenProgram: c.TOKEN_PROGRAM.toBase58(),
    mint: addresses.mint.toBase58(),
    recipient: options.recipient ?? payer,
    payer,
    decimals: options.decimals,
    supplyBaseUnits: String(options.supplyBaseUnits),
    maxExecutionRent,
    platformFee: "0",
    maxNetworkFee,
    name: options.name,
    symbol: options.symbol,
    metadataUri: options.metadataUri,
    metadataSha256: options.metadataSha256,
    mintPolicy: "fixed",
    freezePolicy: "none",
  });
  const bytes = c.encodeIntent(intent),
    digest = c.intentDigest(bytes),
    { proof } = c.deriveProof(network.program, d.creator, digest, payer);
  const metadataProtocolFee = await metadataFee(network);
  const executionRent =
    (await rent(network, [82, 165, 679, c.RECORD_BYTES])) + metadataProtocolFee;
  const uploadRent = await rent(network, [c.PROOF_BYTES]);
  const count =
    1 +
    Math.ceil((c.SIGNATURE_BYTES + bytes.length) / c.MAX_CHUNK_BYTES) +
    1 +
    8 +
    1;
  const networkFee = await feeQuote(
    network,
    payer,
    ix.executeLaunchInstruction(intent, proof),
    count,
  );
  if (
    executionRent > c.integer(maxExecutionRent) ||
    networkFee > c.integer(maxNetworkFee)
  )
    throw new Error(
      "Estimated execution rent or network fees exceed the signed caps.",
    );
  return {
    intent,
    creatorPublicKey,
    salt: d.salt,
    bytes,
    digest,
    context: c.CONTEXT,
    creator: d.creator,
    mint: intent.mint,
    estimate: {
      rentLamports: (executionRent + uploadRent).toString(),
      executionRentLamports: executionRent.toString(),
      metadataFeeLamports: metadataProtocolFee.toString(),
      proofRentLamports: uploadRent.toString(),
      networkFeeLamports: networkFee.toString(),
      totalLamports: (executionRent + uploadRent + networkFee).toString(),
      transactionCount: count,
    },
  };
}
function checkNetworkFields(network, v) {
  if (
    v.program !== network.program ||
    v.genesis !== network.genesis ||
    v.deploymentId !== network.deploymentId
  )
    throw new Error("Authorization belongs to another deployment.");
}
async function priorProofFees(network, proof, payer) {
  // Recover spent fees from confirmed chain history, never from caller-submitted scores.
  const entries = await network.connection.getSignaturesForAddress(
    proof,
    { limit: 1000 },
    network.commitment,
  );
  if (entries.length === 1000)
    throw new Error(
      "Proof history exceeds the bounded fee audit; inspect before resuming.",
    );
  let total = 0n;
  for (const row of entries) {
    const tx = await network.connection.getTransaction(row.signature, {
      commitment: network.commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta)
      throw new Error(
        "Proof history is incomplete; cumulative fees cannot be established.",
      );
    const first =
      tx.transaction.message.accountKeys?.[0] ??
      tx.transaction.message.staticAccountKeys?.[0];
    if (c.address(first).toBase58() === payer) total += c.integer(tx.meta.fee);
  }
  return total;
}
async function priorInitializationFee(network, creator, payer) {
  const rows = await network.connection.getSignaturesForAddress(
    c.address(creator),
    { limit: 1000 },
    network.commitment,
  );
  if (rows.length === 1000)
    throw new Error("Creator history exceeds bounded registration audit.");
  let total = 0n;
  for (const row of rows) {
    const tx = await network.connection.getTransaction(row.signature, {
      commitment: network.commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) throw new Error("Registration history is incomplete.");
    const m = tx.transaction.message;
    const keys = m.accountKeys ?? [
      ...m.staticAccountKeys,
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ];
    if (c.address(keys[0]).toBase58() !== payer) continue;
    const instructions = m.compiledInstructions ?? m.instructions;
    const init = instructions.some(
      (ix) =>
        c.address(keys[ix.programIdIndex]).toBase58() === network.program &&
        (typeof ix.data === "string"
          ? base58Decode(ix.data)[0]
          : ix.data[0]) === 1,
    );
    if (init) total += c.integer(tx.meta.fee);
  }
  return total;
}
function base58Decode(s) {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n,
    z = 0;
  for (const x of s) {
    const a = chars.indexOf(x);
    if (a < 0) throw new Error("Invalid instruction base58.");
    n = n * 58n + BigInt(a);
  }
  for (const x of s) {
    if (x !== "1") break;
    z++;
  }
  const out = [];
  while (n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  return [...new Array(z).fill(0), ...out];
}
function submission(
  network,
  payer,
  maxFee,
  onRecord,
  onProgress,
  initialSpent = 0n,
) {
  let spent = initialSpent;
  const records = [];
  return {
    records,
    send: async (instruction, label) => {
      await assertConfiguration(network);
      const remaining = c.integer(maxFee) - spent;
      if (remaining <= 0n)
        throw new Error("Approved cumulative network-fee budget exhausted.");
      onProgress?.({
        phase: label,
        transactions: records.length,
        spentFeeLamports: spent.toString(),
      });
      const result = await submitNetwork(
        network.connection,
        payer,
        [instruction],
        {
          network,
          label,
          maxFeeLamports: remaining > 10000000n ? 10000000n : remaining,
          onRecord: async (r) => {
            await onRecord?.(r);
          },
        },
      );
      spent += c.integer(result.feeLamports);
      records.push(result);
      return result;
    },
  };
}
async function ensureFunds(network, payer, amount) {
  if (
    c.integer(
      await network.connection.getBalance(c.address(payer), network.commitment),
    ) < amount
  )
    throw new Error(
      "Funding wallet balance is below the approved rent and fee budget.",
    );
}
async function uploadAndVerify(
  network,
  {
    creator,
    creatorPublicKey,
    payer,
    kind,
    nonce,
    expirySlot,
    digest,
    signature,
    intentBytes = new Uint8Array(),
  },
  sender,
) {
  const program = network.program,
    uploader = payerAddress(payer),
    { proof } = c.deriveProof(program, creator, digest, uploader),
    payload = c.concat(c.raw(signature, c.SIGNATURE_BYTES), intentBytes);
  let state = await readOwned(network, proof, c.decodeProof, {
    optional: true,
  });
  const check = (s) => {
    if (
      s.creator !== creator ||
      s.uploader !== uploader ||
      s.creatorPublicKey !== creatorPublicKey ||
      s.kind !== kind ||
      s.nonce !== String(nonce) ||
      s.expirySlot !== String(expirySlot) ||
      s.digest !== c.hex(digest) ||
      s.intentLength !== intentBytes.length ||
      !eq(s.payload, payload.slice(0, s.uploaded))
    )
      throw new Error(
        "Existing proof differs from the exact approval; refusing resume.",
      );
  };
  if (!state) {
    await sender.send(
      ix.beginProofInstruction({
        program,
        creator,
        uploader,
        kind,
        nonce,
        expirySlot,
        digest,
        intentLength: intentBytes.length,
      }).instruction,
      "begin-proof",
    );
    state = await readOwned(network, proof, c.decodeProof);
  }
  check(state);
  while (state.uploaded < payload.length) {
    const offset = state.uploaded;
    await sender.send(
      ix.appendProofInstruction({
        program,
        creator,
        proof,
        uploader,
        offset,
        chunk: payload.slice(offset, offset + c.MAX_CHUNK_BYTES),
      }),
      "upload-proof",
    );
    state = await readOwned(network, proof, c.decodeProof);
    check(state);
    if (state.uploaded <= offset)
      throw new Error("Proof upload did not advance.");
  }
  if (state.stage === 0) {
    await sender.send(
      ix.sealProofInstruction({ program, creator, proof, uploader }),
      "seal-proof",
    );
    state = await readOwned(network, proof, c.decodeProof);
    check(state);
  }
  while (state.stage < 9) {
    const prior = state.stage;
    await sender.send(
      ix.stepProofInstruction({ program, creator, proof }),
      "verify-proof-" + state.stage,
    );
    state = await readOwned(network, proof, c.decodeProof);
    check(state);
    if (state.stage !== prior + 1)
      throw new Error("Verification did not advance by one stage.");
  }
  return proof;
}
export async function registerCreator(
  network,
  {
    registration,
    signature,
    payer,
    maxRentLamports = 100000000n,
    maxFeeLamports = 10000000n,
    onProgress,
    onRecord,
    priorRecords = [],
  },
) {
  const v = c.normalizeRegistration(registration);
  checkNetworkFields(network, v);
  if (payerAddress(payer) !== v.payer)
    throw new Error("Funding wallet differs from authorization.");
  const d = await getCreator(network, {
    payer: v.payer,
    creatorPublicKey: v.creatorPublicKey,
    salt: v.salt,
  });
  if (v.creator !== d.creator || v.nonce !== "0")
    throw new Error("Invalid creator registration.");
  if (
    !(await verifyApproval({
      digest: c.registrationDigest(v),
      signature,
      creatorPublicKey: v.creatorPublicKey,
    }))
  )
    throw new Error("Invalid post-quantum registration signature.");
  if (d.state?.active)
    return {
      creator: d.creator,
      registration: v,
      active: true,
      transactions: [],
      alreadyActive: true,
    };
  await expiry(network, v.expirySlot);
  const requiredRent = await rent(network, [
    ...(!d.state ? [c.CREATOR_BYTES] : []),
    c.PROOF_BYTES,
  ]);
  if (requiredRent > c.integer(maxRentLamports))
    throw new Error("Registration rent exceeds approved cap.");
  await ensureFunds(network, v.payer, requiredRent + c.integer(maxFeeLamports));
  const existingProof = c.deriveProof(
    v.program,
    v.creator,
    c.registrationDigest(v),
    v.payer,
  ).proof;
  const spent =
    (await priorProofFees(network, existingProof, v.payer)) +
    (d.state ? await priorInitializationFee(network, v.creator, v.payer) : 0n);
  const sender = submission(
    network,
    payer,
    maxFeeLamports,
    onRecord,
    onProgress,
    spent,
  );
  if (!d.state)
    await sender.send(ix.initializeCreatorInstruction(v), "initialize-creator");
  const proof = await uploadAndVerify(
    network,
    { ...v, payer, kind: 0, digest: c.registrationDigest(v), signature },
    sender,
  );
  await sender.send(
    ix.activateCreatorInstruction({
      program: v.program,
      creator: v.creator,
      proof,
      payer: v.payer,
    }),
    "activate-creator",
  );
  const after = await getCreator(network, {
    payer: v.payer,
    creatorPublicKey: v.creatorPublicKey,
    salt: v.salt,
  });
  if (!after.state?.active) throw new Error("Creator did not become active.");
  return {
    creator: v.creator,
    registration: v,
    registrationSignature: c.hex(c.raw(signature, c.SIGNATURE_BYTES)),
    active: true,
    transactions: sender.records,
  };
}
export async function executeLaunch(
  network,
  {
    intent,
    signature,
    creatorPublicKey,
    payer,
    onProgress,
    onRecord,
    priorRecords = [],
  },
) {
  const v = c.normalizeIntent(intent);
  checkNetworkFields(network, v);
  if (payerAddress(payer) !== v.payer)
    throw new Error("Funding wallet differs from signed intent.");
  await assertConfiguration(network);
  const creator = await readOwned(network, v.creator, c.decodeCreator);
  creatorPublicKey ??= creator.creatorPublicKey;
  if (
    creator.creatorPublicKey !== c.hex(c.raw(creatorPublicKey)) ||
    !creator.active ||
    creator.payer !== v.payer
  )
    throw new Error("Creator state does not match authorization.");
  if (
    !(await verifyApproval({
      digest: c.intentDigest(v),
      signature,
      creatorPublicKey,
    }))
  )
    throw new Error("Invalid post-quantum launch signature.");
  if (creator.nonce !== v.nonce) {
    if (c.integer(creator.nonce) < c.integer(v.nonce))
      throw new Error("Authorization nonce is ahead of creator state.");
    const { record } = c.deriveLaunch(
      v.program,
      v.creator,
      v.nonce,
      v.recipient,
    );
    const existing = await readOwned(network, record, c.decodeLaunchRecord, {
      optional: true,
    });
    if (
      !existing ||
      existing.digest !== c.hex(c.intentDigest(v)) ||
      !eq(existing.intentBytes, c.encodeIntent(v))
    )
      throw new Error("Creator nonce was consumed by a different launch.");
    const history = await network.connection.getSignaturesForAddress(
      record,
      { limit: 100 },
      network.commitment,
    );
    const authorization = createLaunchAuthorization(
      v,
      signature,
      creatorPublicKey,
    );
    for (const row of history) {
      if (row.err) continue;
      try {
        return {
          ...(await verifyExecution(network, {
            authorization,
            transactionSignature: row.signature,
          })),
          transactions: [],
          resumedConfirmed: true,
        };
      } catch {}
    }
    throw new Error(
      "Matching launch record exists but its confirmed transaction is unavailable. Do not resubmit.",
    );
  }
  await expiry(network, v.expirySlot);
  const requiredRent =
    (await rent(network, [82, 165, 679, c.RECORD_BYTES])) +
    (await metadataFee(network));
  if (requiredRent > c.integer(v.maxExecutionRent))
    throw new Error("Execution rent exceeds signed cap.");
  await ensureFunds(
    network,
    v.payer,
    requiredRent +
      (await rent(network, [c.PROOF_BYTES])) +
      c.integer(v.maxNetworkFee),
  );
  const existingProof = c.deriveProof(
    v.program,
    v.creator,
    c.intentDigest(v),
    v.payer,
  ).proof;
  const spent = await priorProofFees(network, existingProof, v.payer);
  const sender = submission(
      network,
      payer,
      v.maxNetworkFee,
      onRecord,
      onProgress,
      spent,
    ),
    bytes = c.encodeIntent(v);
  const proof = await uploadAndVerify(
    network,
    {
      creator: v.creator,
      creatorPublicKey,
      payer,
      kind: 1,
      nonce: v.nonce,
      expirySlot: v.expirySlot,
      digest: c.intentDigest(bytes),
      signature,
      intentBytes: bytes,
    },
    sender,
  );
  const final = await sender.send(
    ix.executeLaunchInstruction(v, proof),
    "execute-launch",
  );
  const authorization = createLaunchAuthorization(
    v,
    signature,
    creatorPublicKey,
  );
  const receipt = await verifyExecution(network, {
    authorization,
    transactionSignature: final.signature,
  });
  return { ...receipt, transactions: sender.records };
}
