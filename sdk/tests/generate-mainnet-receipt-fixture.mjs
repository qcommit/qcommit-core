// Explicitly synthetic offline fixture. No RPC, transaction submission, wallet funds or real deployment.
import { readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { slh_dsa_sha2_128s as slh } from "@noble/post-quantum/slh-dsa.js";
import * as sdk from "../index.mjs";
const source = JSON.parse(
  readFileSync(
    new URL("./receipt-authorization-localnet.json", import.meta.url),
  ),
);
const pair = slh.keygen(new Uint8Array(48).fill(93));
try {
  const genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    program = Keypair.fromSeed(
      new Uint8Array(32).fill(94),
    ).publicKey.toBase58(),
    payer = Keypair.fromSeed(new Uint8Array(32).fill(95)).publicKey.toBase58(),
    deploymentId = "96".repeat(32),
    creatorPublicKey = sdk.hex(pair.publicKey);
  const domain = { program, genesis, deploymentId },
    salt = sdk.defaultCreatorSalt(domain, payer, creatorPublicKey),
    creator = sdk
      .deriveCreator(
        program,
        genesis,
        deploymentId,
        payer,
        creatorPublicKey,
        salt,
      )
      .creator.toBase58(),
    mint = sdk.deriveLaunch(program, creator, 0, payer).mint.toBase58();
  const intent = sdk.normalizeIntent({
    ...source.authorization.intent,
    ...domain,
    creator,
    payer,
    recipient: payer,
    mint,
    expirySlot: "999999999",
    name: "Synthetic RPC Fixture",
    symbol: "FIXTURE",
  });
  const signature = slh.sign(sdk.intentDigest(intent), pair.secretKey, {
    context: new TextEncoder().encode(sdk.CONTEXT),
    extraEntropy: false,
  });
  const authorization = sdk.createLaunchAuthorization(
    intent,
    signature,
    creatorPublicKey,
  );
  if (
    !(await sdk
      .verifyLaunchApproval(authorization)
      .then((r) => r.signatureValid))
  )
    throw new Error("Fixture signature invalid.");
  writeFileSync(
    new URL("./receipt-authorization-mainnet-fixture.json", import.meta.url),
    JSON.stringify(
      {
        scope:
          "SYNTHETIC OFFLINE MAINNET-DOMAIN FIXTURE. Public deterministic test seeds. No mainnet account, deployment, transaction or funds.",
        authorization,
        confirmation: {
          slot: "1000",
          transactionSignature: source.confirmation.transactionSignature,
        },
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
} finally {
  pair.secretKey.fill(0);
}
