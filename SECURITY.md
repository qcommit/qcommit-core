# Security boundaries

No independent cryptographic or smart-contract audit, audited custody or NIST
module validation is claimed. The hosted launchpad uses Meteora DBC; this core
provides portable creator signatures and offline verification.

## What a creator proof establishes

A valid signature establishes that the included fields were signed by the holder
of the corresponding SLH-DSA secret key, within the assumptions and correctness
of the algorithm and implementation. To attach that signature to a particular
creator, the verifying user must independently pin the expected key/fingerprint.
An arbitrary label and a key supplied inside the same receipt are not identity
verification. A mathematically valid signature can be expired or future-dated.

The profiles use pure SLH-DSA-SHA2-128s to sign an application SHA-256 digest.
The historical preview uses `Qcommit.LaunchPreview.v1`; current Meteora creator
commitments use the distinct `Qcommit.MeteoraLaunch.v1` context. It is not the
standardized HashSLH-DSA interface.
The application digest and framing are part of the security boundary.

## What is not established

The offline core verifier does not query program accounts, mints, supplies,
metadata availability or transaction confirmation. The website separately
submits user-signed transactions and checks confirmed Meteora pool identity.
Those RPC checks do not establish on-chain enforcement of the creator signature.
A signature does not guarantee
a project's honesty, liquidity, token value, legal compliance, or safe economics.
Solana consensus, ordinary funding-wallet signatures, RPCs, and external programs
remain outside Qcommit's post-quantum creator-authorization boundary.

## Creator backup

The preview vault uses PBKDF2-HMAC-SHA256 with 600,000 iterations, a random 32-byte
salt, and AES-256-GCM with a random 12-byte IV and a 128-bit tag. Algorithm,
format, public key, label, and KDF profile are authenticated metadata. KDF settings
are fixed: an untrusted file cannot lower the cost or request unbounded work.
A passphrase length check is not an entropy estimate or a password-security claim.

The optional browser persistence feature stores only the encrypted vault. The
unlocked key lives in a worker, with best-effort zeroing and a three-minute idle
lock. Workers are not hardware isolation. Same-origin malicious code, broad
browser extensions, XSS, swap, debugging, or a compromised OS can defeat this
custody model. JavaScript cannot guarantee erasure of all copies or strings.

## Release process

Review dependency sources and licenses, generate and commit a verified lockfile,
run Noble-to-native integration tests, extend ACVP coverage, fuzz both parsers,
and commission review before publishing security claims. Do not publish private
keys, runtime vault files or seed phrases. The GitHub repository and hosted
website do not imply an independent audit or
a funded bug bounty.

Published NIST sigGen fixtures contain deliberately public test secret keys.
They are test data, not production signing keys; never use them to protect assets.
