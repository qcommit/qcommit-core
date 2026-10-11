import { Buffer } from "buffer";
import {
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  address,
  raw,
  concat,
  u64,
  u16,
  deriveConfig,
  deriveCreator,
  deriveProof,
  deriveLaunch,
  registrationDigest,
  intentDigest,
  encodeIntent,
  MAX_CHUNK_BYTES,
  TOKEN_PROGRAM,
  ASSOCIATED_PROGRAM,
  METADATA_PROGRAM,
} from "./codec.mjs";
const meta = (key, writable = false, signer = false) => ({
  pubkey: address(key),
  isWritable: writable,
  isSigner: signer,
});
const ix = (program, keys, ...parts) =>
  new TransactionInstruction({
    programId: address(program),
    keys,
    data: Buffer.from(concat(...parts)),
  });
export function initializeConfigInstruction({
  program,
  payer,
  programData,
  genesis,
  deploymentId,
}) {
  const { config } = deriveConfig(program);
  return ix(
    program,
    [
      meta(payer, true, true),
      meta(config, true),
      meta(program),
      meta(programData),
      meta(SystemProgram.programId),
    ],
    Uint8Array.of(0),
    address(genesis).toBytes(),
    raw(deploymentId),
  );
}
export function initializeCreatorInstruction(registration) {
  const v = registration,
    { config } = deriveConfig(v.program);
  return ix(
    v.program,
    [
      meta(config),
      meta(v.creator, true),
      meta(v.payer, true, true),
      meta(SystemProgram.programId),
    ],
    Uint8Array.of(1),
    raw(v.creatorPublicKey),
    raw(v.salt),
  );
}
export function beginProofInstruction({
  program,
  creator,
  uploader,
  kind,
  nonce,
  expirySlot,
  digest,
  intentLength,
}) {
  if (
    ![0, 1].includes(kind) ||
    !Number.isInteger(intentLength) ||
    intentLength < 0 ||
    intentLength > 768 ||
    (kind === 0 && intentLength !== 0) ||
    (kind === 1 && intentLength === 0)
  )
    throw new Error("Invalid proof kind/length.");
  const { config } = deriveConfig(program),
    { proof } = deriveProof(program, creator, digest, uploader);
  return {
    proof,
    instruction: ix(
      program,
      [
        meta(config),
        meta(creator),
        meta(proof, true),
        meta(uploader, true, true),
        meta(SystemProgram.programId),
      ],
      Uint8Array.of(2, kind),
      u64(nonce),
      u64(expirySlot),
      raw(digest),
      u16(intentLength),
    ),
  };
}
export function appendProofInstruction({
  program,
  creator,
  proof,
  uploader,
  offset,
  chunk,
}) {
  if (
    !(chunk instanceof Uint8Array) ||
    chunk.length < 1 ||
    chunk.length > MAX_CHUNK_BYTES
  )
    throw new Error("Invalid upload chunk.");
  return ix(
    program,
    [meta(creator), meta(proof, true), meta(uploader, false, true)],
    Uint8Array.of(3),
    u16(offset),
    chunk,
  );
}
export function sealProofInstruction({ program, creator, proof, uploader }) {
  return ix(
    program,
    [meta(creator), meta(proof, true), meta(uploader, false, true)],
    Uint8Array.of(4),
  );
}
export function stepProofInstruction({ program, creator, proof }) {
  return ix(program, [meta(creator), meta(proof, true)], Uint8Array.of(5));
}
export function activateCreatorInstruction({ program, creator, proof, payer }) {
  const { config } = deriveConfig(program);
  return ix(
    program,
    [meta(config), meta(creator, true), meta(proof), meta(payer, false, true)],
    Uint8Array.of(6),
  );
}
export function executeLaunchInstruction(intent, proof) {
  const v = intent,
    { config } = deriveConfig(v.program),
    d = deriveLaunch(v.program, v.creator, v.nonce, v.recipient);
  if (d.mint.toBase58() !== v.mint) throw new Error("Noncanonical mint.");
  return ix(
    v.program,
    [
      meta(config),
      meta(v.creator, true),
      meta(proof),
      meta(v.payer, true, true),
      meta(d.mint, true),
      meta(v.recipient),
      meta(d.ata, true),
      meta(d.metadata, true),
      meta(d.record, true),
      meta(SystemProgram.programId),
      meta(TOKEN_PROGRAM),
      meta(ASSOCIATED_PROGRAM),
      meta(METADATA_PROGRAM),
      meta(SYSVAR_RENT_PUBKEY),
    ],
    Uint8Array.of(7),
  );
}
export function closeProofInstruction({ program, proof, uploader }) {
  return ix(
    program,
    [meta(proof, true), meta(uploader, true, true)],
    Uint8Array.of(8),
  );
}
