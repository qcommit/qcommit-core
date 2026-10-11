import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const ALGORITHM = "SLH-DSA-SHA2-128s";
export const CONTEXT = "Qcommit.Launch.v1";
export const SIGNATURE_BYTES = 7856;
export const MAX_CHUNK_BYTES = 700;
export const MAX_INTENT_BYTES = 768;
export const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const ASSOCIATED_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
export const METADATA_PROGRAM = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);
const encoder = new TextEncoder();
export const utf8 = (s) => encoder.encode(s);
export const hex = (b) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function raw(v, n = 32) {
  if (typeof v === "string") {
    if (!/^[0-9a-f]*$/.test(v) || v.length !== n * 2)
      throw new Error("Expected lowercase hexadecimal bytes.");
    v = Uint8Array.from(v.match(/../g) ?? [], (x) => parseInt(x, 16));
  }
  if (!(v instanceof Uint8Array) || v.length !== n)
    throw new Error(`Expected ${n} bytes.`);
  return Uint8Array.from(v);
}
export function address(v) {
  const p = new PublicKey(v);
  if (typeof v === "string" && p.toBase58() !== v)
    throw new Error("Noncanonical address.");
  return p;
}
export function concat(...parts) {
  const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    b.set(p, o);
    o += p.length;
  }
  return b;
}
export function integer(v) {
  if (
    !["bigint", "number", "string"].includes(typeof v) ||
    (typeof v === "number" && !Number.isSafeInteger(v)) ||
    !/^(0|[1-9][0-9]*)$/.test(String(v))
  )
    throw new Error("Expected an exact unsigned integer.");
  const n = BigInt(v);
  if (n > 0xffffffffffffffffn) throw new Error("Integer exceeds u64.");
  return n;
}
export function u64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, integer(v), true);
  return b;
}
export function u16(v) {
  if (!Number.isInteger(v) || v < 0 || v > 65535)
    throw new Error("Integer exceeds u16.");
  return Uint8Array.of(v & 255, v >>> 8);
}
export function fields(v, keys) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    throw new Error("Unknown or missing fields.");
}
export class Reader {
  constructor(b) {
    if (!(b instanceof Uint8Array)) throw new Error("Expected bytes.");
    this.bytes = b;
    this.offset = 0;
  }
  take(n) {
    if (
      !Number.isSafeInteger(n) ||
      n < 0 ||
      this.offset + n > this.bytes.length
    )
      throw new Error("Truncated data.");
    const p = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return p;
  }
  byte() {
    return this.take(1)[0];
  }
  u16() {
    const b = this.take(2);
    return b[0] + b[1] * 256;
  }
  u32() {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }
  u64() {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }
  string(max) {
    const n = this.u16();
    if (n > max) throw new Error("String exceeds protocol limit.");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.take(n));
  }
  end() {
    if (this.offset !== this.bytes.length) throw new Error("Trailing bytes.");
  }
}
function string(v, max, label) {
  if (
    typeof v !== "string" ||
    !v.isWellFormed() ||
    utf8(v).length > max ||
    /[\x00-\x1f\x7f-\x9f]/.test(v)
  )
    throw new Error(`Invalid ${label}.`);
  return concat(u16(utf8(v).length), utf8(v));
}
// Shared with launch-core::valid_metadata_uri; never normalizes or fetches the URI.
export function validMetadataUri(uri) {
  if(typeof uri!=="string" || uri.length===0 || uri.length>200 || !/^[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+$/.test(uri))return false;
  if(/%(?![0-9a-fA-F]{2})/.test(uri))return false;
  let rest,https;
  if(uri.startsWith("https://")){rest=uri.slice(8);https=true;}
  else if(uri.startsWith("ipfs://")){rest=uri.slice(7);https=false;}
  else if(uri.startsWith("ar://")){rest=uri.slice(5);https=false;}
  else return false;
  const authority=rest.split(/[/?#]/,1)[0];
  if(!authority)return false;
  if(!https)return /^[A-Za-z0-9\-._~]+$/.test(authority);
  const colon=authority.indexOf(":");
  let host=colon<0?authority:authority.slice(0,colon);
  if(colon>=0){const port=authority.slice(colon+1);if(!/^[1-9][0-9]{0,4}$/.test(port)||Number(port)>65535)return false;}
  host=host.replace(/\.$/,"");
  const labels=host.split(".");
  if(labels.some(label=>!label||label.length>63||label.startsWith("-")||label.endsWith("-")||!/^[A-Za-z0-9-]+$/.test(label)))return false;
  if(/^(?:[0-9]+|0[xX][0-9a-fA-F]+)$/.test(labels.at(-1)))return labels.length===4&&labels.every(label=>/^(0|[1-9][0-9]{0,2})$/.test(label)&&Number(label)<=255);
  return true;
}
const intentKeys = [
  "version",
  "program",
  "genesis",
  "deploymentId",
  "creator",
  "epoch",
  "nonce",
  "expirySlot",
  "tokenProgram",
  "mint",
  "recipient",
  "payer",
  "decimals",
  "supplyBaseUnits",
  "maxExecutionRent",
  "platformFee",
  "maxNetworkFee",
  "name",
  "symbol",
  "metadataUri",
  "metadataSha256",
  "mintPolicy",
  "freezePolicy",
];
export function normalizeIntent(v) {
  fields(v, intentKeys);
  if (
    v.version !== 1 ||
    integer(v.epoch) !== 0n ||
    v.mintPolicy !== "fixed" ||
    v.freezePolicy !== "none" ||
    integer(v.platformFee) !== 0n
  )
    throw new Error("Unsupported launch policy.");
  const o = { ...v };
  for (const k of [
    "program",
    "genesis",
    "creator",
    "tokenProgram",
    "mint",
    "recipient",
    "payer",
  ])
    o[k] = address(v[k]).toBase58();
  if (o.tokenProgram !== TOKEN_PROGRAM.toBase58())
    throw new Error("Only classic SPL Token is supported.");
  for (const k of ["deploymentId", "metadataSha256"]) o[k] = hex(raw(v[k]));
  for (const k of [
    "epoch",
    "nonce",
    "expirySlot",
    "supplyBaseUnits",
    "maxExecutionRent",
    "platformFee",
    "maxNetworkFee",
  ])
    o[k] = integer(v[k]).toString();
  if (
    integer(o.expirySlot) === 0n ||
    integer(o.supplyBaseUnits) === 0n ||
    integer(o.maxExecutionRent) === 0n ||
    !Number.isInteger(v.decimals) ||
    v.decimals < 0 ||
    v.decimals > 9
  )
    throw new Error("Invalid expiry, amount, rent cap or decimals.");
  string(v.name, 32, "name");
  if (!v.name.trim() || v.name !== v.name.trim())
    throw new Error("Token name is empty.");
  string(v.symbol, 10, "symbol");
  if (!/^[A-Z0-9]{1,10}$/.test(v.symbol))
    throw new Error("Symbol must be 1–10 uppercase ASCII letters/digits.");
  string(v.metadataUri, 200, "metadata URI");
  if (!validMetadataUri(v.metadataUri))
    throw new Error("Metadata URI must use the shared ASCII HTTPS/IPFS/Arweave grammar; percent-encode Unicode.");

  if (
    !raw(o.metadataSha256).some(Boolean) ||
    !raw(o.deploymentId).some(Boolean)
  )
    throw new Error("Content and deployment hashes must be nonzero.");
  return Object.fromEntries(intentKeys.map((k) => [k, o[k]]));
}
export function encodeIntent(input) {
  const v = normalizeIntent(input);
  const b = concat(
    utf8("QCLNCH01"),
    address(v.program).toBytes(),
    address(v.genesis).toBytes(),
    raw(v.deploymentId),
    address(v.creator).toBytes(),
    u64(v.epoch),
    u64(v.nonce),
    u64(v.expirySlot),
    address(v.tokenProgram).toBytes(),
    address(v.mint).toBytes(),
    address(v.recipient).toBytes(),
    address(v.payer).toBytes(),
    Uint8Array.of(v.decimals),
    u64(v.supplyBaseUnits),
    u64(v.maxExecutionRent),
    u64(v.platformFee),
    u64(v.maxNetworkFee),
    string(v.name, 32, "name"),
    string(v.symbol, 10, "symbol"),
    string(v.metadataUri, 200, "URI"),
    raw(v.metadataSha256),
    Uint8Array.of(0, 0),
  );
  if (b.length > MAX_INTENT_BYTES) throw new Error("Intent too large.");
  return b;
}
export function decodeIntent(b) {
  if (b.length > MAX_INTENT_BYTES) throw new Error("Intent too large.");
  const r = new Reader(b);
  if (hex(r.take(8)) !== hex(utf8("QCLNCH01")))
    throw new Error("Production launch discriminator required.");
  const o = { version: 1 };
  for (const k of ["program", "genesis"]) o[k] = address(r.take(32)).toBase58();
  o.deploymentId = hex(r.take(32));
  o.creator = address(r.take(32)).toBase58();
  for (const k of ["epoch", "nonce", "expirySlot"]) o[k] = r.u64().toString();
  for (const k of ["tokenProgram", "mint", "recipient", "payer"])
    o[k] = address(r.take(32)).toBase58();
  o.decimals = r.byte();
  for (const k of [
    "supplyBaseUnits",
    "maxExecutionRent",
    "platformFee",
    "maxNetworkFee",
  ])
    o[k] = r.u64().toString();
  o.name = r.string(32);
  o.symbol = r.string(10);
  o.metadataUri = r.string(200);
  o.metadataSha256 = hex(r.take(32));
  if (r.byte() !== 0 || r.byte() !== 0)
    throw new Error("Unsupported authorities.");
  o.mintPolicy = "fixed";
  o.freezePolicy = "none";
  r.end();
  return normalizeIntent(o);
}
export function intentDigest(bytesOrIntent) {
  const b =
    bytesOrIntent instanceof Uint8Array
      ? bytesOrIntent
      : encodeIntent(bytesOrIntent);
  decodeIntent(b);
  return sha256(concat(utf8("Qcommit.LaunchIntent.v1\0"), b));
}
export function defaultCreatorSalt(network, payer, key) {
  return sha256(
    concat(
      utf8("Qcommit.CreatorSalt.v1\0"),
      address(network.genesis).toBytes(),
      address(network.program).toBytes(),
      address(payer).toBytes(),
      raw(key),
    ),
  );
}
export function deriveConfig(program) {
  const [config, bump] = PublicKey.findProgramAddressSync(
    [utf8("config")],
    address(program),
  );
  return { config, bump };
}
export function deriveCreator(
  program,
  genesis,
  deploymentId,
  payer,
  key,
  salt,
) {
  const id = sha256(
    concat(
      utf8("Qcommit.Creator.v1\0"),
      address(genesis).toBytes(),
      raw(deploymentId),
      address(payer).toBytes(),
      raw(key),
      raw(salt),
    ),
  );
  const [creator, bump] = PublicKey.findProgramAddressSync(
    [utf8("creator"), id],
    address(program),
  );
  return { creator, id, bump };
}
export function deriveProof(program, creator, digest, uploader) {
  const [proof, bump] = PublicKey.findProgramAddressSync(
    [
      utf8("proof"),
      address(creator).toBytes(),
      raw(digest),
      address(uploader).toBytes(),
    ],
    address(program),
  );
  return { proof, bump };
}
export function deriveLaunch(program, creator, nonce, recipient) {
  const seeds = [address(creator).toBytes(), u64(nonce)];
  const [mint, mintBump] = PublicKey.findProgramAddressSync(
    [utf8("mint"), ...seeds],
    address(program),
  );
  const [record, recordBump] = PublicKey.findProgramAddressSync(
    [utf8("launch"), ...seeds],
    address(program),
  );
  const [ata] = PublicKey.findProgramAddressSync(
    [address(recipient).toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()],
    ASSOCIATED_PROGRAM,
  );
  const [metadata] = PublicKey.findProgramAddressSync(
    [utf8("metadata"), METADATA_PROGRAM.toBytes(), mint.toBytes()],
    METADATA_PROGRAM,
  );
  return { mint, record, ata, metadata, mintBump, recordBump };
}
export function normalizeRegistration(v) {
  fields(v, [
    "version",
    "program",
    "genesis",
    "deploymentId",
    "creator",
    "creatorPublicKey",
    "payer",
    "salt",
    "nonce",
    "expirySlot",
  ]);
  if (
    v.version !== 1 ||
    integer(v.nonce) !== 0n ||
    integer(v.expirySlot) === 0n
  )
    throw new Error("Invalid registration version, nonce or expiry.");
  const o = { ...v, nonce: "0", expirySlot: integer(v.expirySlot).toString() };
  for (const k of ["program", "genesis", "creator", "payer"])
    o[k] = address(v[k]).toBase58();
  for (const k of ["deploymentId", "creatorPublicKey", "salt"])
    o[k] = hex(raw(v[k]));
  if (
    !raw(o.deploymentId).some(Boolean) ||
    !raw(o.creatorPublicKey).some(Boolean)
  )
    throw new Error("Zero identity/deployment is invalid.");
  const derived = deriveCreator(
    o.program,
    o.genesis,
    o.deploymentId,
    o.payer,
    o.creatorPublicKey,
    o.salt,
  );
  if (derived.creator.toBase58() !== o.creator)
    throw new Error("Registration creator PDA mismatch.");
  return o;
}
export function registrationDigest(input) {
  const v = normalizeRegistration(input);
  if (v.version !== 1 || integer(v.nonce) !== 0n)
    throw new Error("Invalid registration.");
  return sha256(
    concat(
      utf8("Qcommit.Register.v1\0"),
      address(v.program).toBytes(),
      address(v.genesis).toBytes(),
      raw(v.deploymentId),
      address(v.creator).toBytes(),
      raw(v.creatorPublicKey),
      address(v.payer).toBytes(),
      u64(v.nonce),
      u64(v.expirySlot),
    ),
  );
}
export const CONFIG_BYTES = 105,
  CREATOR_BYTES = 178,
  PROOF_HEADER_BYTES = 187,
  PROOF_BYTES = 8811,
  RECORD_BYTES = 1536;
function accountReader(b, n, magic) {
  if (b.length !== n) throw new Error("Wrong account size.");
  const r = new Reader(b);
  if (hex(r.take(8)) !== hex(utf8(magic)))
    throw new Error("Wrong account discriminator.");
  return r;
}
export function decodeConfig(b) {
  const r = accountReader(b, CONFIG_BYTES, "QCCONF01");
  const o = {
    bump: r.byte(),
    genesis: address(r.take(32)).toBase58(),
    deploymentId: hex(r.take(32)),
    bootstrapAuthority: address(r.take(32)).toBase58(),
  };
  r.end();
  return o;
}
export function decodeCreator(b) {
  const r = accountReader(b, CREATOR_BYTES, "QCCREA01");
  const o = {
    bump: r.byte(),
    config: address(r.take(32)).toBase58(),
    id: hex(r.take(32)),
    payer: address(r.take(32)).toBase58(),
    creatorPublicKey: hex(r.take(32)),
    salt: hex(r.take(32)),
    nonce: r.u64().toString(),
    active: r.byte(),
  };
  if (o.active > 1) throw new Error("Invalid activation flag.");
  o.active = !!o.active;
  r.end();
  return o;
}
export function decodeProof(b) {
  if (b.length !== PROOF_BYTES) throw new Error("Wrong proof size.");
  const r = accountReader(
    b.slice(0, PROOF_HEADER_BYTES),
    PROOF_HEADER_BYTES,
    "QCPROF01",
  );
  const o = {
    bump: r.byte(),
    creator: address(r.take(32)).toBase58(),
    uploader: address(r.take(32)).toBase58(),
    digest: hex(r.take(32)),
    creatorPublicKey: hex(r.take(32)),
    kind: r.byte(),
    nonce: r.u64().toString(),
    expirySlot: r.u64().toString(),
    intentLength: r.u16(),
    uploaded: r.u16(),
    stage: r.byte(),
    root: hex(r.take(16)),
    tree: r.u64().toString(),
    leaf: r.u32(),
  };
  r.end();
  if (
    o.kind > 1 ||
    o.intentLength > MAX_INTENT_BYTES ||
    o.uploaded > SIGNATURE_BYTES + o.intentLength ||
    o.stage > 9 ||
    (o.kind === 0 && o.intentLength !== 0) ||
    (o.kind === 1 && o.intentLength === 0) ||
    (o.stage > 0 && o.uploaded !== SIGNATURE_BYTES + o.intentLength)
  )
    throw new Error("Invalid proof state.");
  return {
    ...o,
    payload: b.slice(PROOF_HEADER_BYTES, PROOF_HEADER_BYTES + o.uploaded),
  };
}
export function decodeLaunchRecord(b) {
  const r = accountReader(b, RECORD_BYTES, "QCLAUN01");
  const o = {
    bump: r.byte(),
    creator: address(r.take(32)).toBase58(),
    nonce: r.u64().toString(),
    digest: hex(r.take(32)),
    mint: address(r.take(32)).toBase58(),
    recipient: address(r.take(32)).toBase58(),
    ata: address(r.take(32)).toBase58(),
    metadata: address(r.take(32)).toBase58(),
    slot: r.u64().toString(),
    payer: address(r.take(32)).toBase58(),
  };
  const n = r.u32();
  if (n > MAX_INTENT_BYTES) throw new Error("Record intent too large.");
  o.intentBytes = r.take(n);
  o.intent = decodeIntent(o.intentBytes);
  if (r.take(b.length - r.offset).some(Boolean))
    throw new Error("Nonzero record padding.");
  r.end();
  return o;
}
