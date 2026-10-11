import { parseJson } from "../src/json.mjs";
/** Same-origin Solana RPC gateway. No credentials, keys, arbitrary URLs or Node APIs. */
export const RPC_UPSTREAMS = Object.freeze({
  "mainnet-beta": Object.freeze([
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
  ]),
  devnet: Object.freeze(["https://api.devnet.solana.com"]),
});
const MAX_REQUEST = 32768,
  MAX_RESPONSE = 3 * 1024 * 1024,
  TIMEOUT_MS = 15000;
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const utf8 = new TextDecoder("utf-8", { fatal: true });
const counts = new Map();
class GatewayError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
function requireThat(value, message, status = 400) {
  if (!value) throw new GatewayError(message, status);
}
function shape(value, keys) {
  requireThat(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((k) => keys.includes(k)),
    "Unsupported object fields.",
  );
}
function uint(value, max = Number.MAX_SAFE_INTEGER) {
  requireThat(
    Number.isSafeInteger(value) && value >= 0 && value <= max,
    "Invalid integer parameter.",
  );
}
function base58decode(s, length) {
  requireThat(
    typeof s === "string" && s.length >= 1 && s.length <= 90,
    "Invalid base58 parameter.",
  );
  let n = 0n,
    zero = 0;
  for (const ch of s) {
    const x = alphabet.indexOf(ch);
    requireThat(x >= 0, "Invalid base58 character.");
    n = n * 58n + BigInt(x);
  }
  for (const ch of s) {
    if (ch !== "1") break;
    zero++;
  }
  const bytes = [];
  while (n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  requireThat(zero + bytes.length === length, "Wrong base58 byte length.");
  return Uint8Array.from([...new Uint8Array(zero), ...bytes]);
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function unbase64(s, max) {
  requireThat(
    typeof s === "string" &&
      s.length <= 4 * Math.ceil(max / 3) &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        s,
      ),
    "Expected canonical bounded base64.",
  );
  let decoded;
  try {
    decoded = atob(s);
  } catch {
    throw new GatewayError("Invalid base64.");
  }
  requireThat(
    btoa(decoded) === s && decoded.length <= max,
    "Noncanonical or oversized base64.",
  );
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
}
class Wire {
  constructor(bytes) {
    this.bytes = bytes;
    this.at = 0;
  }
  take(n) {
    requireThat(
      Number.isInteger(n) && n >= 0 && this.at + n <= this.bytes.length,
      "Truncated transaction.",
    );
    const out = this.bytes.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
  byte() {
    return this.take(1)[0];
  }
  short() {
    let n = 0,
      multiplier = 1;
    for (let i = 0; i < 3; i++) {
      const b = this.byte();
      n += (b & 127) * multiplier;
      if (!(b & 128)) {
        requireThat(
          n <= 65535 && (i === 0 || n >= 2 ** (7 * i)),
          "Noncanonical shortvec.",
        );
        return n;
      }
      multiplier *= 128;
    }
    throw new GatewayError("Invalid shortvec.");
  }
}
export function validateLaunchTransaction(
  base64,
  expectedProgram,
  { allowUnsigned = false } = {},
) {
  const bytes = unbase64(base64, 1232),
    target = base58decode(expectedProgram, 32),
    compute = base58decode(COMPUTE, 32),
    r = new Wire(bytes);
  const signatures = r.short();
  requireThat(
    signatures === 1,
    "Exactly one funding-wallet signature is required.",
  );
  const signerBytes = r.take(64);
  requireThat(
    allowUnsigned || signerBytes.some(Boolean),
    "Unsigned transactions cannot be relayed.",
  );
  const required = r.byte();
  requireThat(
    (required & 128) === 0 && required === signatures,
    "Only canonical legacy transactions are supported.",
  );
  const readonlySigned = r.byte(),
    readonlyUnsigned = r.byte(),
    count = r.short();
  requireThat(
    count >= 2 &&
      count <= 64 &&
      readonlySigned === 0 &&
      readonlyUnsigned <= count - required,
    "Invalid message account header.",
  );
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(r.take(32));
  requireThat(
    new Set(keys.map((k) => Array.from(k).join(","))).size === keys.length,
    "Duplicate account keys are noncanonical.",
  );
  r.take(32);
  const n = r.short();
  requireThat(n >= 1 && n <= 3, "Unexpected instruction count.");
  let launches = 0;
  const budgetTypes = new Set();
  for (let i = 0; i < n; i++) {
    const programIndex = r.byte();
    requireThat(
      programIndex < count && programIndex >= count - readonlyUnsigned,
      "Program must be an unsigned readonly account.",
    );
    const accounts = r.take(r.short());
    requireThat(
      accounts.length <= 20 && accounts.every((a) => a < count),
      "Invalid instruction account indexes.",
    );
    const data = r.take(r.short());
    if (same(keys[programIndex], target)) {
      launches++;
      requireThat(
        launches === 1,
        "Exactly one Qcommit instruction may be relayed.",
      );
      requireThat(
        data.length > 0 && data[0] >= 1 && data[0] <= 8,
        "Unsupported Qcommit instruction; bootstrap is operator-only.",
      );
      requireThat(
        accounts.length >= 2,
        "Missing Qcommit instruction accounts.",
      );
      const tag = data[0];
      if (tag === 1)
        requireThat(data.length === 65, "Malformed creator initialization.");
      if (tag === 2)
        requireThat(data.length === 52, "Malformed proof initialization.");
      if (tag === 3)
        requireThat(
          data.length >= 4 && data.length <= 703,
          "Malformed proof chunk.",
        );
      if (tag >= 4)
        requireThat(data.length === 1, "Unexpected Qcommit instruction data.");
    } else if (same(keys[programIndex], compute)) {
      requireThat(
        launches === 0 && accounts.length === 0 && data.length > 0,
        "Compute budget must precede the launch instruction.",
      );
      const tag = data[0];
      requireThat(!budgetTypes.has(tag), "Duplicate compute budget setting.");
      budgetTypes.add(tag);
      if (tag === 2) {
        requireThat(data.length === 5, "Invalid compute limit.");
        const units = new DataView(data.buffer, data.byteOffset, 5).getUint32(
          1,
          true,
        );
        requireThat(
          units >= 1 && units <= 1200000,
          "Compute limit exceeds policy.",
        );
      } else if (tag === 3) {
        requireThat(data.length === 9, "Invalid compute price.");
        requireThat(
          new DataView(data.buffer, data.byteOffset, 9).getBigUint64(1, true) <=
            1000000n,
          "Compute price exceeds policy.",
        );
      } else throw new GatewayError("Unsupported compute-budget operation.");
    } else
      throw new GatewayError(
        "Transaction invokes a program outside this deployment.",
      );
  }
  requireThat(
    launches === 1 && r.at === bytes.length,
    "Missing launch instruction or trailing transaction bytes.",
  );
  return bytes;
}
function options(v, extra = [], allowedEncoding = ["base64"]) {
  if (v === undefined) return;
  shape(v, ["commitment", "minContextSlot", ...extra]);
  if (v.commitment !== undefined)
    requireThat(
      ["processed", "confirmed", "finalized"].includes(v.commitment),
      "Invalid commitment.",
    );
  if (v.minContextSlot !== undefined) uint(v.minContextSlot);
  if (v.encoding !== undefined)
    requireThat(allowedEncoding.includes(v.encoding), "Unsupported encoding.");
}
function length(p, min, max = min) {
  requireThat(p.length >= min && p.length <= max, "Wrong RPC parameter count.");
}
function validateRead(method, p) {
  switch (method) {
    case "getGenesisHash":
    case "getHealth":
    case "getVersion":
      length(p, 0);
      return;
    case "getSlot":
    case "getBlockHeight":
    case "getLatestBlockhash":
      length(p, 0, 1);
      options(p[0]);
      return;
    case "getBalance":
    case "getAccountInfo":
      length(p, 1, 2);
      base58decode(p[0], 32);
      options(p[1], method === "getAccountInfo" ? ["encoding"] : []);
      return;
    case "getMultipleAccounts":
      length(p, 1, 2);
      requireThat(
        Array.isArray(p[0]) && p[0].length >= 1 && p[0].length <= 32,
        "Account list must contain1..32 addresses.",
      );
      p[0].forEach((a) => base58decode(a, 32));
      options(p[1], ["encoding"]);
      return;
    case "getMinimumBalanceForRentExemption":
      length(p, 1, 2);
      uint(p[0], 2097152);
      options(p[1]);
      return;
    case "getFeeForMessage":
      length(p, 1, 2);
      unbase64(p[0], 1232);
      options(p[1]);
      return;
    case "getSignatureStatuses":
      length(p, 1, 2);
      requireThat(
        Array.isArray(p[0]) && p[0].length >= 1 && p[0].length <= 64,
        "Signature list must contain1..64 items.",
      );
      p[0].forEach((s) => base58decode(s, 64));
      if (p[1] !== undefined) {
        shape(p[1], ["searchTransactionHistory"]);
        requireThat(
          typeof p[1].searchTransactionHistory === "boolean",
          "Invalid signature history option.",
        );
      }
      return;
    case "getTransaction":
      length(p, 1, 2);
      base58decode(p[0], 64);
      options(p[1], ["encoding", "maxSupportedTransactionVersion"], ["json"]);
      if (p[1]?.maxSupportedTransactionVersion !== undefined)
        requireThat(
          p[1].maxSupportedTransactionVersion === 0,
          "Unsupported transaction version query.",
        );
      return;
    case "getSignaturesForAddress":
      length(p, 1, 2);
      base58decode(p[0], 32);
      options(p[1], ["limit", "before", "until"]);
      if (p[1]?.limit !== undefined) {
        uint(p[1].limit, 1000);
        requireThat(p[1].limit >= 1, "Invalid history limit.");
      }
      for (const k of ["before", "until"])
        if (p[1]?.[k] !== undefined) base58decode(p[1][k], 64);
      return;
    default:
      throw new GatewayError("RPC method is not enabled.", 403);
  }
}
async function validatePayload(v, config) {
  shape(v, ["jsonrpc", "id", "method", "params"]);
  requireThat(
    v.jsonrpc === "2.0" &&
      typeof v.method === "string" &&
      v.method.length <= 64,
    "Invalid JSON-RPC envelope.",
  );
  requireThat(
    (typeof v.id === "string" && v.id.length <= 128) ||
      (Number.isSafeInteger(v.id) && v.id >= 0),
    "A bounded request ID is required.",
  );
  const p = v.params ?? [];
  requireThat(Array.isArray(p) && p.length <= 4, "Invalid RPC parameters.");
  if (v.method === "sendTransaction" || v.method === "simulateTransaction") {
    requireThat(
      config.enabled === true && typeof config.expectedProgram === "string",
      "Deployment is not enabled for transactions.",
      503,
    );
    length(p, 1, 2);
    await (config.transactionValidator ?? validateLaunchTransaction)(p[0], config.expectedProgram, {
      allowUnsigned:
        v.method === "simulateTransaction" && p[1]?.sigVerify === false,
      signal: config.signal,
    });
    const opts = p[1] ?? {};
    shape(
      opts,
      v.method === "sendTransaction"
        ? [
            "encoding",
            "skipPreflight",
            "preflightCommitment",
            "maxRetries",
            "minContextSlot",
          ]
        : [
            "encoding",
            "commitment",
            "sigVerify",
            "replaceRecentBlockhash",
            "minContextSlot",
          ],
    );
    requireThat(
      opts.encoding === "base64",
      "Transaction encoding must be explicit base64.",
    );
    if (opts.minContextSlot !== undefined) uint(opts.minContextSlot);
    const commitment = opts.preflightCommitment ?? opts.commitment;
    if (commitment !== undefined)
      requireThat(
        ["confirmed", "finalized"].includes(commitment),
        "Transaction commitment must be confirmed or finalized.",
      );
    if (v.method === "sendTransaction") {
      requireThat(opts.skipPreflight !== true, "Preflight cannot be bypassed.");
      if (opts.skipPreflight !== undefined)
        requireThat(
          typeof opts.skipPreflight === "boolean",
          "Invalid preflight flag.",
        );
      if (opts.maxRetries !== undefined) uint(opts.maxRetries, 3);
    } else {
      requireThat(
        typeof opts.sigVerify === "boolean" &&
          opts.replaceRecentBlockhash !== true,
        "Simulation must explicitly declare signature checks without replacing the blockhash.",
      );
      if (opts.replaceRecentBlockhash !== undefined)
        requireThat(
          typeof opts.replaceRecentBlockhash === "boolean",
          "Invalid blockhash flag.",
        );
    }
  } else validateRead(v.method, p);
}
async function boundedBody(body, limit, signal) {
  requireThat(body, "Missing request or response body.");
  const reader = body.getReader();
  let total = 0,
    parts = [];
  const aborted = () => { void reader.cancel("deadline").catch(() => {}); };
  signal?.addEventListener("abort", aborted, { once: true });
  try {
    while (true) {
      requireThat(!signal?.aborted, "RPC deadline exceeded.", 504);
      const { done, value } = await reader.read();
      requireThat(!signal?.aborted, "RPC deadline exceeded.", 504);
      if (done) break;
      total += value.byteLength;
      requireThat(total <= limit, "Body exceeds gateway size bound.", 413);
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of parts) {
      out.set(part, off);
      off += part.length;
    }
    return out;
  } finally {
    signal?.removeEventListener("abort", aborted);
    await reader.cancel().catch(() => {});
  }
}
function reply(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
function rateLimit(origin) {
  const now = Date.now(),
    window = Math.floor(now / 60000);
  let item = counts.get(origin);
  if (!item || item.window !== window) {
    item = { window, count: 0 };
    counts.set(origin, item);
  }
  requireThat(
    ++item.count <= 600,
    "Gateway per-isolate rate limit reached.",
    429,
  );
  if (counts.size > 64)
    for (const [key, v] of counts) if (v.window !== window) counts.delete(key);
}
export async function handleRpc(
  request,
  { upstream, expectedProgram, enabled = false, allowedOrigin, onDiagnostic, transactionValidator },
  fetchImpl = (url, options) => globalThis.fetch(url, options),
) {
  let id = null,
    stage = "request-policy";
  try {
    const url = new URL(request.url),
      match = /^\/rpc\/(mainnet-beta|devnet)$/.exec(url.pathname);
    requireThat(match && !url.search, "Unknown RPC route.", 404);
    requireThat(request.method === "POST", "Only POST is supported.", 405);
    requireThat(
      typeof allowedOrigin === "string" &&
        new URL(allowedOrigin).origin === allowedOrigin &&
        url.origin === allowedOrigin,
      "Gateway origin is not configured.",
      403,
    );
    requireThat(
      request.headers.get("origin") === allowedOrigin,
      "RPC is restricted to the same application origin.",
      403,
    );
    requireThat(
      (request.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase() === "application/json",
      "Expected application/json.",
      415,
    );
    const selected = new URL(upstream);
    requireThat(
      !selected.username &&
        !selected.password &&
        !selected.search &&
        !selected.hash &&
        RPC_UPSTREAMS[match[1]].includes(selected.href.replace(/\/$/, "")),
      "Upstream is not an allowlisted endpoint for this cluster.",
      503,
    );
    rateLimit(allowedOrigin);
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      stage = "read-request";
      const bytes = await boundedBody(
        request.body,
        MAX_REQUEST,
        controller.signal,
      );
      let value;
      try {
        value = parseJson(utf8.decode(bytes), MAX_REQUEST);
      } catch {
        throw new GatewayError("Invalid UTF-8 JSON.");
      }
      requireThat(!Array.isArray(value), "JSON-RPC batches are disabled.");
      id = value?.id ?? null;
      await validatePayload(value, { enabled, expectedProgram, transactionValidator, signal: controller.signal });
      stage = "fetch-upstream";
      const response = await fetchImpl.call(globalThis, selected.href, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(value),
        signal: controller.signal,
      });
      requireThat(
        response.status < 300 || response.status >= 400,
        "Upstream redirects are not permitted.",
        502,
      );
      requireThat(
        response.status >= 200 && response.status < 600,
        "Invalid upstream status.",
        502,
      );
      stage = "read-response";
      const received = await boundedBody(
        response.body,
        MAX_RESPONSE,
        controller.signal,
      );
      stage = "parse-response";
      let result;
      try {
        result = JSON.parse(utf8.decode(received));
      } catch {
        throw new GatewayError(
          "Upstream returned an invalid JSON-RPC response.",
          502,
        );
      }
      requireThat(
        result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          result.jsonrpc === "2.0" &&
          result.id === value.id &&
          ((Object.hasOwn(result, "result") &&
            !Object.hasOwn(result, "error")) ||
            (Object.hasOwn(result, "error") &&
              !Object.hasOwn(result, "result"))),
        "Upstream response does not match this RPC request.",
        502,
      );
      return reply(result, response.status);
    } catch (error) {
      if (controller.signal.aborted)
        throw new GatewayError("RPC deadline exceeded.", 504);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (typeof onDiagnostic === "function") {
      // Optional operator-only diagnostics; no request/response bodies, headers, or credentials.
      const name = String(error?.name ?? "Error")
        .replace(/[^A-Za-z0-9_-]/g, "")
        .slice(0, 60);
      const message = String(error?.message ?? "Unknown runtime failure")
        .replace(/https?:\/\/[^\s]+/g, "[URL]")
        .replace(/\b[A-Za-z0-9+/=]{64,}\b/g, "[data]")
        .replace(/[\r\n]/g, " ")
        .slice(0, 240);
      try {
        const pending = onDiagnostic({ stage, name, message });
        if (pending?.catch) pending.catch(() => {});
      } catch {}
    }
    return reply(
      {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32099,
          message:
            error instanceof GatewayError
              ? error.message
              : "RPC upstream unavailable.",
        },
      },
      error instanceof GatewayError ? error.status : 502,
    );
  }
}
