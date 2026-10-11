#!/usr/bin/env bash
set -euo pipefail
cd /work
[[ ${QC_ISOLATED_LOCALNET:-} == 1 ]] || exit 1
mkdir -p .runtime/deploy
node --input-type=module <<'JS'
import {Keypair,PublicKey,SystemProgram} from '@solana/web3.js';
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const wallet=Keypair.generate();
writeFileSync('.runtime/deploy/payer.keypair.json',JSON.stringify([...wallet.secretKey]),{mode:0o600});
writeFileSync('.runtime/deploy/payer.txt',wallet.publicKey.toBase58()+'\n');
writeFileSync('.runtime/deploy/bank.txt',new PublicKey(randomBytes(32)).toBase58()+'\n');
writeFileSync('.runtime/deploy/payer-account.json',JSON.stringify({pubkey:wallet.publicKey.toBase58(),account:{lamports:1000_000_000_000,data:['','base64'],owner:SystemProgram.programId.toBase58(),executable:false,rentEpoch:0,space:0}}));
JS
# No Qcommit executable or ProgramData account is preloaded. The test must deploy it.
solana-test-validator --ledger /work/.runtime/deploy/ledger --reset \
 --bind-address 127.0.0.1 --rpc-port 18899 --faucet-port 19900 \
 --gossip-port 18001 --dynamic-port-range 18002-18030 \
 --mint "$(cat .runtime/deploy/bank.txt)" \
 --account "$(cat .runtime/deploy/payer.txt)" /work/.runtime/deploy/payer-account.json \
 --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s /work/.runtime/program-fixtures/metaplex-token-metadata.so \
 --ticks-per-slot 8 --rpc-pubsub-worker-threads 1 --quiet > .runtime/deploy/validator.log 2>&1 &
validator_pid=$!
trap 'kill "$validator_pid" 2>/dev/null || true; wait "$validator_pid" 2>/dev/null || true' EXIT
node tests/deploy-localnet.mjs
