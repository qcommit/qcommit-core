#!/usr/bin/env bash
set -euo pipefail
cd /work
[[ ${QC_ISOLATED_LOCALNET:-} == 1 ]] || exit 1
node scripts/onchain-keys.mjs
solana-test-validator --ledger /work/.runtime/onchain/ledger --reset \
 --bind-address 127.0.0.1 --rpc-port 18899 --faucet-port 19900 \
 --gossip-port 18001 --dynamic-port-range 18002-18030 \
 --mint "$(cat .runtime/onchain/bank.txt)" \
 --account "$(cat .runtime/onchain/payer.txt)" /work/.runtime/onchain/genesis-payer.json \
 --account "$(cat .runtime/onchain/program.txt)" /work/.runtime/onchain/genesis-program.json \
 --account "$(cat .runtime/onchain/programData.txt)" /work/.runtime/onchain/genesis-program-data.json \
 --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s /work/.runtime/program-fixtures/metaplex-token-metadata.so \
 --ticks-per-slot 8 --rpc-pubsub-worker-threads 1 --quiet > .runtime/onchain/validator.log 2>&1 &
validator_pid=$!
trap 'kill "$validator_pid" 2>/dev/null || true; wait "$validator_pid" 2>/dev/null || true' EXIT
node tests/onchain-localnet.mjs
