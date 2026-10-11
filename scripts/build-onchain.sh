#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
mkdir -p .runtime evidence
cargo test --workspace --release --locked 2>&1 | tee .runtime/rust-tests-current.log
sbf_args=(--manifest-path programs/qcommit-launch/Cargo.toml --tools-version v1.52 --jobs "$CARGO_BUILD_JOBS")
if [[ -n "${SBF_SDK_PATH:-}" ]]; then sbf_args+=(--sbf-sdk "$SBF_SDK_PATH"); fi
cargo build-sbf "${sbf_args[@]}" -- --locked 2>&1 | tee .runtime/sbf-build-current.log
