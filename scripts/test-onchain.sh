#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
QC_ROOT=$PWD
QC_NODE=${QC_NODE:-$(command -v node)}
QC_SOLANA=${QC_SOLANA:-$(dirname "$(command -v solana-test-validator)")}
QC_IMAGE=${QC_IMAGE:-quantum-seal-localnet:0.1.0}
test -f target/deploy/qcommit_launch.so
test -f .runtime/program-fixtures/metaplex-token-metadata.so
mkdir -p .runtime/onchain evidence
QC_CIDFILE=$(mktemp .runtime/onchain/container.XXXXXX)
rm "$QC_CIDFILE"
cleanup() {
  if [[ -s "$QC_CIDFILE" ]]; then
    QC_CID=$(cat "$QC_CIDFILE")
    if [[ "$QC_CID" =~ ^[0-9a-f]{64}$ ]] && docker inspect "$QC_CID" >/dev/null 2>&1; then
      timeout 20 docker stop --time 5 "$QC_CID" >/dev/null 2>&1 || true
      timeout 10 docker rm "$QC_CID" >/dev/null 2>&1 || true
      if docker inspect "$QC_CID" >/dev/null 2>&1; then
        echo "Owned test container cleanup unconfirmed: $QC_CID" >&2
        return 1
      fi
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --cidfile "$QC_CIDFILE" --runtime runc --name qcommit-onchain-localnet --rm --network none --cpus 4 --memory 4g --memory-swap 4g \
 --pids-limit 512 --cap-drop ALL --security-opt no-new-privileges \
 --security-opt "seccomp=$QC_ROOT/scripts/seccomp-localnet.json" \
 --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m \
 --mount "type=bind,src=$QC_ROOT,dst=/work" \
 --mount "type=bind,src=$QC_NODE,dst=/tools/node,readonly" \
 --mount "type=bind,src=$QC_SOLANA,dst=/tools/solana,readonly" \
 -e QC_ISOLATED_LOCALNET=1 -e PATH=/tools/solana:/tools:/usr/bin:/bin \
 "$QC_IMAGE" bash scripts/onchain-inside.sh
