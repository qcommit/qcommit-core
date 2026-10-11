import {
  intentDigest,
  registrationDigest,
  CONTEXT,
  raw,
  hex,
  ALGORITHM,
  SIGNATURE_BYTES,
  normalizeIntent,
} from "./codec.mjs";
import { verifySlh } from "../src/slh-verify.mjs";
import { parseJson } from "../src/json.mjs";
export const launchApproval = (intent) => ({
  context: CONTEXT,
  digest: intentDigest(intent),
});
export const registrationApproval = (registration) => ({
  context: CONTEXT,
  digest: registrationDigest(registration),
});
export async function verifyApproval({
  digest,
  signature,
  creatorPublicKey,
  context = CONTEXT,
}) {
  if (context !== CONTEXT)
    throw new Error("Production signature context required.");
  const result = await verifySlh(
    raw(digest),
    raw(signature, SIGNATURE_BYTES),
    raw(creatorPublicKey),
    new TextEncoder().encode(CONTEXT),
  );
  return result.valid;
}
export function parseLaunchAuthorization(input) {
  const v = typeof input === "string" ? parseJson(input, 65536) : input;
  if (
    !v ||
    Object.keys(v).sort().join(",") !==
      "algorithm,context,creatorPublicKey,format,intent,signature" ||
    v.format !== "qcommit/launch-authorization/2" ||
    v.algorithm !== ALGORITHM ||
    v.context !== CONTEXT
  )
    throw new Error(
      "Production launch authorization required; preview receipts cannot launch.",
    );
  return {
    format: v.format,
    algorithm: ALGORITHM,
    context: CONTEXT,
    creatorPublicKey: hex(raw(v.creatorPublicKey)),
    intent: normalizeIntent(v.intent),
    signature: hex(raw(v.signature, SIGNATURE_BYTES)),
  };
}
export const createLaunchAuthorization = (
  intent,
  signature,
  creatorPublicKey,
) =>
  parseLaunchAuthorization({
    format: "qcommit/launch-authorization/2",
    algorithm: ALGORITHM,
    context: CONTEXT,
    creatorPublicKey,
    intent,
    signature: hex(raw(signature, SIGNATURE_BYTES)),
  });
export async function verifyLaunchApproval(input) {
  const p = parseLaunchAuthorization(input);
  return {
    signatureValid: await verifyApproval({
      digest: intentDigest(p.intent),
      signature: p.signature,
      creatorPublicKey: p.creatorPublicKey,
    }),
    authorization: p,
  };
}
