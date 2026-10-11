#!/usr/bin/env node
import fs from "node:fs/promises";
import { Keypair } from "@solana/web3.js";
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa.js";
import { parseVault, decryptCreator, encryptCreator } from "../src/vault.mjs";
import { parseJson } from "../src/json.mjs";
import * as sdk from "./index.mjs";

const usage = `Qcommit program-enforced launch CLI (Node 22+)

  node sdk/cli.mjs create-identity --label "My creator" --passphrase-file PRIVATE_FILE --out creator.vault.json
  node sdk/cli.mjs inspect --network deployment.json
  node sdk/cli.mjs prepare-register --network deployment.json --vault creator.vault.json --payer ADDRESS --out registration.request.json
  node sdk/cli.mjs prepare-launch --network deployment.json --vault creator.vault.json --payer ADDRESS --params token.json --out launch.request.json
  node sdk/cli.mjs sign --request launch.request.json --vault creator.vault.json --passphrase-file PRIVATE_FILE --out signed.json
  node sdk/cli.mjs register --network deployment.json --signed signed.json --payer-file EXPLICIT_KEYPAIR --submit --out registration.result.json
  node sdk/cli.mjs launch --network deployment.json --signed signed.json --payer-file EXPLICIT_KEYPAIR --submit --out execution.json
  node sdk/cli.mjs verify --network deployment.json --receipt execution.json

Network config pins exact cluster genesis, deployment ID, executable hash and upgrade policy.
Public execution requires HTTPS RPC; mainnet requires an immutable deployed program.
No default wallet/key path is read. --submit is required before sending any transaction.
The passphrase file must be owner-only mode0600; content is read exactly (no newline trim).
Fee/rent units are lamports. Token supply is an exact base-unit decimal string.
`;
function args() {
  const [command, ...rest] = process.argv.slice(2),
    out = { command };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith("--") || Object.hasOwn(out, k.slice(2)))
      throw new Error("Duplicate or malformed CLI argument.");
    if (k === "--submit") {
      out.submit = true;
      continue;
    }
    if (!rest[i + 1] || rest[i + 1].startsWith("--"))
      throw new Error("Missing option value.");
    out[k.slice(2)] = rest[++i];
  }
  return out;
}
async function read(path, max = 65536, secret = false) {
  if (typeof path !== "string")
    throw new Error("Required file path is missing.");
  const handle = await fs.open(path, "r");
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > max ||
      (secret && (stat.mode & 0o077) !== 0)
    )
      throw new Error("File must be bounded and secret files owner-only.");
    const b = Buffer.alloc(max + 1),
      { bytesRead } = await handle.read(b, 0, b.length, 0);
    if (bytesRead > max) throw new Error("File exceeds size bound.");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      b.subarray(0, bytesRead),
    );
  } finally {
    await handle.close();
  }
}
const json = async (path, max = 65536, secret = false) =>
  parseJson(await read(path, max, secret), max);
const write = async (path, value) => {
  if (!path) throw new Error("--out is required.");
  await fs.writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
};
const publicRequest = (kind, prepared, creatorPublicKey) => ({
  format: "qcommit/production-request/1",
  kind,
  creatorPublicKey,
  [kind === "registration" ? "registration" : "intent"]:
    prepared[kind === "registration" ? "registration" : "intent"],
  context: sdk.CONTEXT,
  digest: sdk.hex(prepared.digest),
  estimate: prepared.estimate,
});
let secret, payerKey;
try {
  const a = args();
  if (!a.command || a.command === "help") {
    console.log(usage);
    process.exit(0);
  }
  if (a.command === "create-identity") {
    if (typeof a.label !== "string") throw new Error("--label is required.");
    const pass = await read(a["passphrase-file"], 1024, true);
    const pair = slh_dsa_sha2_128s.keygen();
    secret = pair.secretKey;
    const vault = await encryptCreator(secret, pass, a.label);
    await write(a.out, vault);
    console.log(
      JSON.stringify(
        { publicKey: vault.publicKey, backup: a.out, format: vault.format },
        null,
        2,
      ),
    );
  } else if (a.command === "sign") {
    const r = await json(a.request),
      vault = parseVault(await read(a.vault, 4096)),
      pass = await read(a["passphrase-file"], 1024, true);
    if (
      r.format !== "qcommit/production-request/1" ||
      !["registration", "launch"].includes(r.kind) ||
      r.context !== sdk.CONTEXT ||
      r.creatorPublicKey !== vault.publicKey
    )
      throw new Error("Unsupported request or creator mismatch.");
    const digest =
      r.kind === "registration"
        ? sdk.registrationDigest(r.registration)
        : sdk.intentDigest(r.intent);
    if (sdk.hex(digest) !== r.digest)
      throw new Error(
        "Request digest does not match the displayed exact fields.",
      );
    secret = await decryptCreator(vault, pass);
    const signature = slh_dsa_sha2_128s.sign(digest, secret, {
      context: new TextEncoder().encode(sdk.CONTEXT),
    });
    if (
      !(await sdk.verifyApproval({
        digest,
        signature,
        creatorPublicKey: vault.publicKey,
      }))
    )
      throw new Error("Independent signature self-verification failed.");
    await write(
      a.out,
      r.kind === "launch"
        ? sdk.createLaunchAuthorization(r.intent, signature, vault.publicKey)
        : {
            format: "qcommit/creator-registration/1",
            context: sdk.CONTEXT,
            registration: r.registration,
            signature: sdk.hex(signature),
          },
    );
    console.log(
      "Wrote signed production authorization; no transaction was submitted.",
    );
  } else {
    const network = await sdk.openNetwork(await json(a.network, 8192));
    if (a.command === "inspect") {
      await sdk.assertConfiguration(network);
      console.log(
        JSON.stringify(
          {
            genesis: network.genesis,
            program: network.program,
            programSha256: network.programSha256,
            immutable: network.immutable,
            commitment: network.commitment,
          },
          null,
          2,
        ),
      );
    } else if (
      a.command === "prepare-register" ||
      a.command === "prepare-launch"
    ) {
      const vault = parseVault(await read(a.vault, 4096));
      const options = {
        ...(a.params ? await json(a.params, 8192) : {}),
        payer: a.payer,
        creatorPublicKey: vault.publicKey,
      };
      const kind = a.command === "prepare-register" ? "registration" : "launch";
      const p =
        kind === "registration"
          ? await sdk.prepareRegistration(network, options)
          : await sdk.prepareLaunch(network, options);
      await write(a.out, publicRequest(kind, p, vault.publicKey));
      console.log(JSON.stringify(p.estimate, null, 2));
    } else if (a.command === "register" || a.command === "launch") {
      if (a.submit !== true)
        throw new Error(
          "Review the signed approval and add --submit to authorize submission.",
        );
      const data = await json(a["payer-file"], 4096, true);
      if (
        !Array.isArray(data) ||
        data.length !== 64 ||
        data.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
      )
        throw new Error("Explicit payer keypair must contain exactly64 bytes.");
      payerKey = Keypair.fromSecretKey(Uint8Array.from(data));
      data.fill(0);
      const signed = await json(a.signed);
      const log = a.out + ".journal.jsonl";
      await fs.writeFile(log, "", { flag: "wx", mode: 0o600 });
      const onRecord = (r) =>
        fs.appendFile(log, JSON.stringify(r) + "\n", { mode: 0o600 });
      let result;
      if (a.command === "register") {
        if (
          signed.format !== "qcommit/creator-registration/1" ||
          signed.context !== sdk.CONTEXT
        )
          throw new Error("Production registration required.");
        result = await sdk.registerCreator(network, {
          registration: signed.registration,
          signature: signed.signature,
          payer: payerKey,
          onRecord,
        });
      } else {
        const authorization = sdk.parseLaunchAuthorization(signed);
        result = await sdk.executeLaunch(network, {
          ...authorization,
          payer: payerKey,
          onRecord,
        });
      }
      await write(a.out, result);
      console.log("Confirmed and saved result.");
    } else if (a.command === "verify") {
      const receipt = await json(a.receipt);
      const result = await sdk.verifyExecution(network, {
        authorization: receipt.authorization,
        transactionSignature: receipt.confirmation?.transactionSignature,
      });
      console.log(JSON.stringify(result, null, 2));
    } else throw new Error("Unknown command.\n" + usage);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  secret?.fill(0);
  payerKey?.secretKey.fill(0);
}
