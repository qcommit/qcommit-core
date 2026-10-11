import { sha256 } from "@noble/hashes/sha2.js";
import { assertNetwork } from "./network.mjs";
import { parseLaunchAuthorization, verifyLaunchApproval } from "./approval.mjs";
import * as c from "./codec.mjs";
import { executeLaunchInstruction } from "./instructions.mjs";
import { assertConfiguration, readOwned } from "./client.mjs";
import { base58 } from "./transport.mjs";
function assert(v, m) {
  if (!v) throw new Error(m);
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function u32(b, o) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
}
function u64(b, o) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(
    o,
    true,
  );
}
function txKeys(tx) {
  const m = tx.transaction.message;
  if (m.accountKeys) return m.accountKeys.map(c.address);
  return [
    ...m.staticAccountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ].map(c.address);
}
function decodeMetadata(data) {
  const r = new c.Reader(Uint8Array.from(data));
  assert(r.byte() === 4, "Unsupported metadata account version.");
  const updateAuthority = c.address(r.take(32)).toBase58(),
    mint = c.address(r.take(32)).toBase58();
  const str = (max) => {
    const n = r.u32();
    assert(n <= max, "Metadata string too large.");
    return new TextDecoder("utf8", { fatal: true, ignoreBOM: true })
      .decode(r.take(n))
      .replace(/\0+$/, "");
  };
  const name = str(32),
    symbol = str(10),
    uri = str(200),
    sellerFee = r.u16(),
    creators = r.byte();
  assert(creators === 0, "Unexpected metadata creator royalties.");
  const primarySale = r.byte(),
    mutable = r.byte();
  assert(primarySale <= 1 && mutable <= 1, "Invalid metadata flags.");
  return {
    updateAuthority,
    mint,
    name,
    symbol,
    uri,
    sellerFee,
    mutable: !!mutable,
  };
}
export async function verifyExecution(
  network,
  { authorization, transactionSignature, expectedCreatorFingerprint },
) {
  const p = parseLaunchAuthorization(authorization),
    v = p.intent;
  assert(
    v.program === network.program &&
      v.genesis === network.genesis &&
      v.deploymentId === network.deploymentId,
    "Receipt belongs to another deployment.",
  );
  assert(
    typeof transactionSignature === "string" &&
      /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(transactionSignature),
    "Invalid transaction signature.",
  );
  const sigcheck = await verifyLaunchApproval(p);
  assert(sigcheck.signatureValid, "Post-quantum signature is invalid.");
  const deployment = await assertNetwork(network.connection, network);
  await assertConfiguration(network);
  const creator = await readOwned(network, v.creator, c.decodeCreator);
  assert(
    creator.creatorPublicKey === p.creatorPublicKey &&
      creator.payer === v.payer &&
      creator.active &&
      c.integer(creator.nonce) > c.integer(v.nonce),
    "Creator key or consumed nonce is inconsistent.",
  );
  const creatorAddress = c.deriveCreator(
    v.program,
    v.genesis,
    v.deploymentId,
    creator.payer,
    creator.creatorPublicKey,
    creator.salt,
  );
  assert(
    creatorAddress.creator.toBase58() === v.creator &&
      creatorAddress.bump === creator.bump &&
      c.hex(creatorAddress.id) === creator.id &&
      creator.config === c.deriveConfig(v.program).config.toBase58(),
    "Creator registration address/identity binding is inconsistent.",
  );
  const { proof } = c.deriveProof(
      v.program,
      v.creator,
      c.intentDigest(v),
      v.payer,
    ),
    expected = executeLaunchInstruction(v, proof),
    derived = c.deriveLaunch(v.program, v.creator, v.nonce, v.recipient);
  const [statusResult, tx] = await Promise.all([
    network.connection.getSignatureStatuses([transactionSignature], {
      searchTransactionHistory: true,
    }),
    network.connection.getTransaction(transactionSignature, {
      commitment: network.commitment,
      maxSupportedTransactionVersion: 0,
    }),
  ]);
  const status = statusResult.value[0];
  assert(
    status &&
      !status.err &&
      (status.confirmationStatus === "finalized" ||
        (network.commitment === "confirmed" &&
          status.confirmationStatus === "confirmed")),
    "Transaction is not confirmed at the required commitment.",
  );
  assert(tx?.meta && !tx.meta.err, "Missing or failed confirmed transaction.");
  assert(
    tx.transaction.signatures[0] === transactionSignature,
    "RPC returned a different transaction.",
  );
  if (deployment.deployedSlot !== null) {
    assert(
      c.integer(tx.slot) > c.integer(deployment.deployedSlot),
      "Transaction predates the currently pinned program deployment; historical code is unproven.",
    );
  }
  const keys = txKeys(tx),
    message = tx.transaction.message;
  assert(keys[0].toBase58() === v.payer, "Wrong transaction fee payer.");
  const all = message.compiledInstructions ?? message.instructions;
  const relevant = all.filter(
    (i) => keys[i.programIdIndex]?.toBase58() === v.program,
  );
  assert(
    relevant.length === 1,
    "Expected exactly one launch-program instruction.",
  );
  const instruction = relevant[0],
    indices = instruction.accountKeyIndexes ?? instruction.accounts;
  const data =
    typeof instruction.data === "string"
      ? decodeBase58(instruction.data)
      : Uint8Array.from(instruction.data);
  assert(
    same(data, Uint8Array.of(7)),
    "Transaction is not the atomic launch instruction.",
  );
  assert(
    indices.length === expected.keys.length &&
      expected.keys.every((m, i) => keys[indices[i]]?.equals(m.pubkey)),
    "Launch transaction accounts do not match the signed intent.",
  );
  // A receipt confirms a plain launch, not arbitrary extra calls co-signed by the payer.
  assert(
    all.every((i) =>
      [v.program, "ComputeBudget111111111111111111111111111111"].includes(
        keys[i.programIdIndex]?.toBase58(),
      ),
    ),
    "Unexpected additional top-level instruction.",
  );
  const record = await readOwned(network, derived.record, c.decodeLaunchRecord);
  assert(
    record.bump === derived.recordBump &&
      record.digest === c.hex(c.intentDigest(v)) &&
      same(record.intentBytes, c.encodeIntent(v)) &&
      record.creator === v.creator &&
      record.nonce === v.nonce &&
      record.mint === v.mint &&
      record.recipient === v.recipient &&
      record.ata === derived.ata.toBase58() &&
      record.metadata === derived.metadata.toBase58() &&
      record.payer === v.payer &&
      record.slot === String(tx.slot),
    "Immutable launch record differs from the confirmed execution.",
  );
  const infos = await network.connection.getMultipleAccountsInfo(
      [derived.mint, derived.ata, derived.metadata],
      network.commitment,
    ),
    [mint, ata, metadata] = infos;
  assert(
    mint &&
      !mint.executable &&
      mint.owner.equals(c.TOKEN_PROGRAM) &&
      mint.data.length === 82,
    "Mint is not a classic SPL mint.",
  );
  assert(
    u32(mint.data, 0) === 0 &&
      u32(mint.data, 46) === 0 &&
      mint.data[44] === v.decimals &&
      mint.data[45] === 1,
    "Mint authorities or decimals do not match fixed-supply policy.",
  );
  assert(
    u64(mint.data, 36) <= c.integer(v.supplyBaseUnits),
    "Mint supply increased beyond approved issuance.",
  );
  const recipientAccountCurrent = !!(
    ata &&
    !ata.executable &&
    ata.owner.equals(c.TOKEN_PROGRAM) &&
    ata.data.length === 165 &&
    same(ata.data.subarray(0, 32), derived.mint.toBytes()) &&
    same(ata.data.subarray(32, 64), c.address(v.recipient).toBytes()) &&
    ata.data[108] === 1
  );
  const ai = keys.findIndex((k) => k.equals(derived.ata));
  const initial = tx.meta.postTokenBalances?.find(
    (b) =>
      b.accountIndex === ai &&
      b.mint === v.mint &&
      b.owner === v.recipient &&
      (!b.programId || b.programId === v.tokenProgram),
  );
  assert(
    initial &&
      initial.uiTokenAmount.amount === v.supplyBaseUnits &&
      initial.uiTokenAmount.decimals === v.decimals,
    "Confirmed transaction did not distribute the exact signed supply.",
  );
  assert(
    metadata &&
      !metadata.executable &&
      metadata.owner.equals(c.METADATA_PROGRAM),
    "Metadata account has the wrong owner.",
  );
  const md = decodeMetadata(metadata.data);
  assert(
    md.mint === v.mint &&
      md.updateAuthority === v.creator &&
      md.name === v.name &&
      md.symbol === v.symbol &&
      md.uri === v.metadataUri &&
      md.sellerFee === 0 &&
      !md.mutable,
    "Metaplex metadata or immutability differs from approval.",
  );
  const finalDeployment = await assertNetwork(network.connection, network);
  assert(
    finalDeployment.programSha256 === deployment.programSha256 &&
      finalDeployment.deployedSlot === deployment.deployedSlot &&
      finalDeployment.upgradeAuthority === deployment.upgradeAuthority,
    "Deployment changed during receipt verification.",
  );
  await assertConfiguration(network);
  const fingerprint = c.hex(
    sha256(c.concat(c.utf8("Qcommit/Creator/v1\0"), c.raw(p.creatorPublicKey))),
  );
  if (expectedCreatorFingerprint !== undefined)
    c.raw(expectedCreatorFingerprint);
  return {
    format: "qcommit/launch-execution/1",
    authorization: p,
    signatureValid: true,
    creatorFingerprint: fingerprint,
    creatorTrusted:
      expectedCreatorFingerprint !== undefined &&
      fingerprint === expectedCreatorFingerprint,
    confirmation: {
      transactionSignature,
      slot: String(tx.slot),
      commitment: network.commitment,
      genesis: network.genesis,
      program: network.program,
      programSha256: deployment.programSha256,
      immutableProgram: deployment.immutable,
      onchainVerified: true,
      mint: v.mint,
      recipient: v.recipient,
      tokenAccount: derived.ata.toBase58(),
      metadata: derived.metadata.toBase58(),
      record: derived.record.toBase58(),
      supplyBaseUnits: v.supplyBaseUnits,
      decimals: v.decimals,
      feeLamports: String(tx.meta.fee),
      currentRecipientAccount: recipientAccountCurrent
        ? "open"
        : "closed-or-repurposed",
      currentRecipientAmount: recipientAccountCurrent
        ? u64(ata.data, 64).toString()
        : null,
    },
    rpcTrust:
      "Confirmed RPC account and transaction evidence; not a light-client state proof.",
  };
}
function decodeBase58(s) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n,
    zeros = 0;
  for (const ch of s) {
    const v = alphabet.indexOf(ch);
    assert(v >= 0, "Invalid base58 instruction.");
    n = n * 58n + BigInt(v);
  }
  for (const ch of s) {
    if (ch !== "1") break;
    zeros++;
  }
  const b = [];
  while (n) {
    b.unshift(Number(n & 255n));
    n >>= 8n;
  }
  return Uint8Array.from([...new Uint8Array(zeros), ...b]);
}
