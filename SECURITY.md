# Security boundaries

Qcommit implements post-quantum **creator launch authorization**. The program and
client have executed with synthetic funds on an isolated validator. Public
mainnet deployment, genuine Phantom-extension validation and an independent
cryptographic/smart-contract audit remain pending. No NIST module validation,
formal verification or audited custody claim is made.

## What the proof establishes

A valid SLH-DSA signature binds the exact approved fields to its creator key,
subject to the algorithm's assumptions and implementation correctness. Establish
who owns that key through an independent trusted fingerprint channel. A creator
label or key inside the same untrusted receipt does not authenticate a person.

Production approvals use pure SLH-DSA-SHA2-128s over a domain-separated application
SHA-256 digest, with context `Qcommit.Launch.v1`. Registration and launch have
different digest domains. This is not the formal HashSLH-DSA interface. Canonical
byte encoding and application framing are part of the security boundary.

The historical preview API remains isolated under `Qcommit.LaunchPreview.v1`.
Its JSON receipts and Python receipt CLI establish only off-chain approval and
must not be accepted by the production program.

## What the on-chain program enforces

Creator activation requires an actual post-quantum possession proof. Launch
approval binds deployment/genesis, creator, payer, monotonic nonce, expiry,
recipient, exact token settings and authority policies. Bounded uploader-specific
proof accounts cannot be changed after sealing. Final execution verifies its
proof and nonce/expiry again before atomic mint/distribution/metadata/record
creation. Failure rolls back program effects, but network fees may still be paid.

Execution rent is capped on chain. Cumulative network-fee limits are enforced by
the client using confirmed history; a Solana program cannot retroactively cap
fees charged by previous transactions. Proof rent is separate, and reclamation
requires an explicit close transaction by the uploader. Partial uploads can leave
paid accounts until deliberately completed or closed.

The recipient's tokens remain ordinary SPL assets. Subsequent transfers, funding
wallets, Solana consensus and external programs do not inherit post-quantum
protection from the launch proof. A valid launch does not establish honesty,
liquidity, token value, lawful behavior or sound economics.

## Deployment, RPC and retries

The production client checks the actual cluster genesis, program bytes and loader,
upgrade policy and immutable deployment configuration before submission. Mainnet
mode rejects mutable upgrade authority. Publishing source is not proof that a
network deployment matches it; verify the actual deployed binary and commitment.
Immutability also means a defect cannot be repaired by simply upgrading the program.

Execution receipts re-read successful transactions, exact instructions, immutable
records, original token distribution, authority state and metadata through the
configured RPC. Public networks require finalized results and appropriate
program-deployment history. RPC evidence is not a cryptographic light-client
proof. A compromised or inconsistent RPC is a remaining trust boundary.

Keep every transaction journal record and the original signed approval. A lost
RPC acknowledgement does not prove that a transaction failed. The client exposes
the locally derived signature and requires history/nonce reconciliation; do not
replace the approval or repeat execution merely because a browser timed out.

Metadata hashes commit to bytes but do not guarantee hosting availability or
that a remote URI currently serves the committed bytes. Fetching and comparing
those bytes is a separate verification step.

## Creator keys and backups

Version 1 has one lifetime creator key. Rotation/recovery is not implemented.
Loss prevents future approvals for that identity; compromise permits approvals
within the program's payer/nonce/expiry policies. Preserve a tested encrypted
backup and a separately protected passphrase before registration.

The vault uses PBKDF2-HMAC-SHA256 with 600,000 iterations, random 32-byte salt, and
AES-256-GCM with random 12-byte IV and 128-bit tag. Algorithm, format, public key,
label and KDF profile are authenticated. Fixed KDF bounds prevent an untrusted
vault from reducing cost or requesting unbounded work. Passphrase length is not
an entropy or password-strength estimate.

The separate website can retain only the encrypted vault when the user opts in.
Unlocked creator keys remain in a crypto worker with best-effort clearing and
three-minute idle locking. A worker is not hardware isolation. Compromised
same-origin code, browser extensions, XSS, debugging or a compromised operating
system can capture keys/passphrases. JavaScript cannot guarantee erasure of all
copies. HTTPS is necessary for browser cryptography but does not remove these
custody risks. CLI key input must be explicit and owner-only; no default wallet
or credential is loaded implicitly.

## Validation and disclosure

Use locked dependencies, review their provenance and licenses, reproduce both
signature and actual program tests, inspect the exact source/deployment hashes,
and obtain independent review before relying on this implementation for valuable
assets. The current local evidence is described in [README.md](README.md) and
[docs/LAUNCH_PROGRAM.md](docs/LAUNCH_PROGRAM.md). Passing selected vectors and
adversarial tests does not establish complete FIPS conformance or eliminate
implementation risk.

Report vulnerabilities privately using the repository's GitHub Security reporting
channel. Never post secret keys, seed phrases, runtime vaults or account credentials
in public issues. No funded bug bounty is offered by this repository.

Published NIST sigGen fixtures contain deliberately public test secret keys.
These are test data and must never protect assets.
