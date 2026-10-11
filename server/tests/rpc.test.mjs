import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import { handleRpc, validateLaunchTransaction } from "../rpc.mjs";
const payer = Keypair.fromSeed(new Uint8Array(32).fill(61)),
  program = Keypair.fromSeed(new Uint8Array(32).fill(62)).publicKey;
const origin = "https://qcommit.example",
  config = {
    upstream: "https://api.mainnet-beta.solana.com",
    expectedProgram: program.toBase58(),
    enabled: true,
    allowedOrigin: origin,
  };
const envelope = (method = "getGenesisHash", params = []) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});
const request = (body, headers = {}, url = origin + "/rpc/mainnet-beta") =>
  new Request(url, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const reply = (result, id = 1, status = 200) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status });
function wire({
  signed = true,
  otherProgram = false,
  versionByte = false,
  extra = false,
  bootstrap = false,
  units = 1200000,
  price = 0n,
} = {}) {
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: program.toBase58(),
  });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  if (price)
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  tx.add(
    new TransactionInstruction({
      programId: otherProgram ? SystemProgram.programId : program,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        {
          pubkey: Keypair.fromSeed(new Uint8Array(32).fill(63)).publicKey,
          isSigner: false,
          isWritable: true,
        },
      ],
      data: Buffer.from(bootstrap ? [0] : [5]),
    }),
  );
  if (signed) tx.sign(payer);
  let b = tx.serialize({
    requireAllSignatures: signed,
    verifySignatures: signed,
  });
  if (versionByte) {
    b = Buffer.from(b);
    b[65] = 128;
  }
  if (extra) b = Buffer.concat([b, Buffer.from([1])]);
  return b.toString("base64");
}
test("same-origin benign read forwards to fixed upstream without browser Origin or credentials", async () => {
  let seen;
  const r = await handleRpc(request(envelope()), config, async (url, init) => {
    seen = { url, init };
    return reply("genesis");
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result, "genesis");
  assert.equal(seen.url, "https://api.mainnet-beta.solana.com/");
  assert.equal(seen.init.redirect, "manual");
  assert.equal(seen.init.headers.origin, undefined);
  assert.equal(seen.init.headers.authorization, undefined);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});
test("upstream RPC errors and HTTP status are preserved", async () => {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32005, message: "Node is behind" },
  };
  const r = await handleRpc(
    request(envelope()),
    config,
    async () => new Response(JSON.stringify(body), { status: 503 }),
  );
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), body);
});
test("cross-origin, missing-origin and non-POST requests never reach upstream", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return reply(1);
  };
  assert.equal(
    (
      await handleRpc(
        request(envelope(), { origin: "https://attacker.example" }),
        config,
        fetcher,
      )
    ).status,
    403,
  );
  const req = request(envelope());
  req.headers.delete("origin");
  assert.equal((await handleRpc(req, config, fetcher)).status, 403);
  assert.equal(
    (
      await handleRpc(
        new Request(origin + "/rpc/mainnet-beta"),
        config,
        fetcher,
      )
    ).status,
    405,
  );
  assert.equal(calls, 0);
});
test("SSRF endpoint, cluster mismatch and URL-query routes are rejected", async () => {
  const fetcher = () => {
    throw Error("must not fetch");
  };
  for (const upstream of [
    "http://127.0.0.1:8899",
    "https://attacker.example",
    "https://api.mainnet-beta.solana.com/?url=http://127.0.0.1",
    "https://user:pass@api.mainnet-beta.solana.com",
  ])
    assert.equal(
      (await handleRpc(request(envelope()), { ...config, upstream }, fetcher))
        .status,
      503,
    );
  assert.equal(
    (
      await handleRpc(
        request(envelope(), {}, origin + "/rpc/devnet"),
        config,
        fetcher,
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await handleRpc(
        request(envelope(), {}, origin + "/rpc/mainnet-beta?upstream=x"),
        config,
        fetcher,
      )
    ).status,
    404,
  );
});
test("batch, duplicate JSON keys and unsupported methods are refused", async () => {
  const fetcher = () => {
    throw Error("must not fetch");
  };
  for (const body of [
    [envelope()],
    '{"jsonrpc":"2.0","id":1,"id":2,"method":"getGenesisHash"}',
    envelope("requestAirdrop", [payer.publicKey.toBase58(), 1]),
  ])
    assert.ok((await handleRpc(request(body), config, fetcher)).status >= 400);
});
test("oversized request and bounded list parameters are refused", async () => {
  const fetcher = () => {
    throw Error("must not fetch");
  };
  assert.equal(
    (await handleRpc(request(" ".repeat(32769)), config, fetcher)).status,
    413,
  );
  assert.equal(
    (
      await handleRpc(
        request(
          envelope("getMultipleAccounts", [
            new Array(33).fill(program.toBase58()),
          ]),
        ),
        config,
        fetcher,
      )
    ).status,
    400,
  );
});
test("oversized or mismatched upstream response rejected", async () => {
  let r = await handleRpc(request(envelope()), config, async () =>
    reply("a".repeat(3 * 1024 * 1024)),
  );
  assert.equal(r.status, 413);
  r = await handleRpc(request(envelope()), config, async () => reply("x", 2));
  assert.equal(r.status, 502);
});
test("disabled deployment rejects simulation and sending but allows bounded reads", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return reply("ok");
  };
  for (const method of ["simulateTransaction", "sendTransaction"])
    assert.equal(
      (
        await handleRpc(
          request(
            envelope(method, [wire(), { encoding: "base64", sigVerify: true }]),
          ),
          { ...config, enabled: false },
          fetcher,
        )
      ).status,
      503,
    );
  assert.equal(calls, 0);
  assert.equal(
    (
      await handleRpc(
        request(envelope()),
        { ...config, enabled: false },
        fetcher,
      )
    ).status,
    200,
  );
});
test("canonical signed deployment-only transaction can be sent", async () => {
  const b = wire();
  let seen;
  const r = await handleRpc(
    request(
      envelope("sendTransaction", [
        b,
        {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "finalized",
          maxRetries: 3,
        },
      ]),
    ),
    config,
    async (_url, init) => {
      seen = JSON.parse(init.body);
      return reply("signature");
    },
  );
  assert.equal(r.status, 200);
  assert.equal(seen.params[0], b);
});
test("unsigned simulation is allowed only with explicit sigVerify false; never for sending", async () => {
  const b = wire({ signed: false });
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return reply({ value: { err: null } });
  };
  assert.equal(
    (
      await handleRpc(
        request(
          envelope("simulateTransaction", [
            b,
            {
              encoding: "base64",
              sigVerify: false,
              replaceRecentBlockhash: false,
              commitment: "finalized",
            },
          ]),
        ),
        config,
        fetcher,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await handleRpc(
        request(
          envelope("sendTransaction", [
            b,
            { encoding: "base64", skipPreflight: false },
          ]),
        ),
        config,
        fetcher,
      )
    ).status,
    400,
  );
  assert.equal(calls, 1);
});
test("wrong program, versioned wire, trailing bytes, bootstrap and excessive compute rejected", () => {
  for (const options of [
    { otherProgram: true },
    { versionByte: true },
    { extra: true },
    { bootstrap: true },
    { units: 1200001 },
    { price: 1000001n },
  ])
    assert.throws(() =>
      validateLaunchTransaction(wire(options), program.toBase58()),
    );
});
test("base64 and shortvec noncanonical encodings rejected", () => {
  const b = Buffer.from(wire(), "base64");
  const bad = Buffer.concat([Buffer.from([129, 0]), b.subarray(1)]).toString(
    "base64",
  );
  assert.throws(() => validateLaunchTransaction(bad, program.toBase58()));
  assert.throws(() =>
    validateLaunchTransaction(wire() + "\n", program.toBase58()),
  );
  assert.throws(() =>
    validateLaunchTransaction(
      Buffer.alloc(1233).toString("base64"),
      program.toBase58(),
    ),
  );
});
test("skip-preflight, blockhash replacement and extra simulation account snapshots rejected", async () => {
  const fetcher = () => {
    throw Error("must not fetch");
  };
  for (const [method, opts] of [
    ["sendTransaction", { encoding: "base64", skipPreflight: true }],
    [
      "simulateTransaction",
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true },
    ],
    [
      "simulateTransaction",
      {
        encoding: "base64",
        sigVerify: true,
        accounts: { addresses: [payer.publicKey.toBase58()] },
      },
    ],
  ])
    assert.equal(
      (
        await handleRpc(
          request(envelope(method, [wire(), opts])),
          config,
          fetcher,
        )
      ).status,
      400,
    );
});
test("streamed request enforces limit before parsing or network forwarding", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(32769));
      c.close();
    },
  });
  const req = new Request(origin + "/rpc/mainnet-beta", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
    duplex: "half",
  });
  assert.equal(
    (
      await handleRpc(req, config, () => {
        throw Error("must not fetch");
      })
    ).status,
    413,
  );
});

test("Worker-style fetch receiver is globalThis and internal runtime diagnostics stay private", async () => {
  const r = await handleRpc(request(envelope()), config, function () {
    assert.equal(this, globalThis);
    return reply("bound");
  });
  assert.equal(r.status, 200);
  let diagnostic;
  const failed = await handleRpc(
    request(envelope()),
    {
      ...config,
      onDiagnostic: (x) => {
        diagnostic = x;
      },
    },
    function () {
      throw new TypeError(
        "Illegal invocation at https://api.mainnet-beta.solana.com/private",
      );
    },
  );
  assert.equal(failed.status, 502);
  assert.equal(
    (await failed.json()).error.message,
    "RPC upstream unavailable.",
  );
  assert.equal(diagnostic.stage, "fetch-upstream");
  assert.equal(diagnostic.name, "TypeError");
  assert.equal(diagnostic.message, "Illegal invocation at [URL]");
});

test("every upstream redirect is rejected without following Location or reading its body", async () => {
  for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
    let calls = 0;
    const r = await handleRpc(
      request(envelope()),
      config,
      async (_url, init) => {
        calls++;
        assert.equal(init.redirect, "manual");
        return new Response(null, {
          status,
          headers: { location: "http://127.0.0.1/private" },
        });
      },
    );
    assert.equal(r.status, 502);
    assert.equal(
      (await r.json()).error.message,
      "Upstream redirects are not permitted.",
    );
    assert.equal(calls, 1);
  }
});
