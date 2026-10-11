# Same-origin RPC gateway

`handleRpc(request, configuration, fetchImpl = fetch)` is a dependency-free Web Worker handler except for the repository's pure bounded JSON parser. It exposes only `/rpc/mainnet-beta` and `/rpc/devnet`.

```js
return handleRpc(request, {
  upstream: 'https://api.mainnet-beta.solana.com',
  expectedProgram: independentlyVerifiedDeployment.program,
  enabled: independentlyVerifiedDeployment.enabled,
  allowedOrigin: 'https://your-application.example',
});
```

The deployment/operator must supply trusted configuration. Do not derive `upstream`, `expectedProgram`, `enabled` or `allowedOrigin` from request parameters or body. The gateway restricts upstream URLs to exact fixed constants for their corresponding cluster, sends no caller authentication/Cookie/Origin headers, and uses manual redirects with an explicit rejection of every3xx response before reading its body. No redirect target is fetched. Provider credentials and arbitrary endpoints are not supported.

Only same-origin JSON POSTs are accepted. No external CORS permission or batch API is exposed. Request bodies are capped at32 KiB, response bodies at3 MiB, and the whole request at15 seconds. Bounded per-isolate request counting limits a single configured origin to600 requests/minute; this is an abuse bound, not a distributed rate-limit SLA.

Reads are restricted to the exact methods/parameters needed by the SDK. Simulation and transaction submission remain disabled until `enabled === true` and a program ID is provided. Transaction parsing enforces canonical legacy wire format, one funding-wallet signature slot, a maximum1,232-byte packet, exactly one expected Qcommit user instruction(tags1..8), and only bounded optional compute-budget instructions. Operator bootstrap and loader operations are rejected. Unsigned simulation requires explicit `sigVerify: false`; submission requires nonzero signature bytes and mandatory RPC preflight. Cryptographic signature verification remains with the RPC/runtime and launch program.

The gateway does not independently turn a selected program ID into trusted deployment evidence. The browser SDK still checks actual genesis, deployed bytecode, immutable policy, configuration, creator authorization and execution receipts. The operator must enable routes only after those deployment checks pass.

`server/tests/rpc.test.mjs` uses mocked upstream responses and synthetic transactions. It makes no real network call and does not demonstrate a mainnet launch.

The optional trusted `onDiagnostic({stage,name,message})` callback receives internal error diagnostics with URLs and long data tokens redacted. It receives no request/response body, headers or configuration and does not alter the public generic error response. Native fetch is invoked with the Worker global receiver; injected test fetch implementations receive the same receiver.
