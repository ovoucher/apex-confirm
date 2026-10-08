#!/usr/bin/env bash
# Deploy apex_register and three board_account instances to Stellar testnet, init the
# register, register three members and the custodian.
#
# WRITTEN BUT NOT EXECUTED: the build environment could not reach soroban-testnet.stellar.org
# or friendbot. Nothing in this repository has been deployed.
#
# Needs: stellar-cli 28.0.0, node 22, jq, and `cd app && npm ci && npm run build` first.
# Writes .env.testnet and var/testnet/board-keys.json (testnet secrets; never commit them).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NET="${STELLAR_NETWORK:-testnet}"
OUT="$ROOT/var/testnet"
mkdir -p "$OUT"
cd "$ROOT"

key() { stellar keys generate "$1" --network "$NET" ${2:-} >/dev/null 2>&1 || true; }
addr() { stellar keys address "$1"; }
secret() { stellar keys show "$1"; }
hexpk() { node -e 'const {StrKey}=require("@stellar/stellar-sdk");process.stdout.write(Buffer.from(StrKey.decodeEd25519PublicKey(process.argv[1])).toString("hex"))' "$1"; }
export NODE_PATH="$ROOT/app/node_modules"

echo "== keys (registrar, apex, custodian, fee payer are funded; officers are not)"
for k in apex-registrar apex-apex apex-custodian apex-source; do key "$k" --fund; done

echo "== build"
stellar contract build

echo "== deploy apex_register"
REGISTER=$(stellar contract deploy --wasm target/wasm32v1-none/release/apex_register.wasm --source apex-source --network "$NET")
echo "register: $REGISTER"

echo "== deploy and init three board_account instances (2-of-3 officers each)"
# init has no auth: run it in the same script right after deploy, and the registrar checks
# `signers` before register_member (see docs/THREAT-MODEL.md, 'board front-run').
BOARDS='[]'
for no in 1 2 3; do
  BOARD=$(stellar contract deploy --wasm target/wasm32v1-none/release/board_account.wasm --source apex-source --network "$NET")
  OFFICERS='[]'; HEXES=()
  for role in chair treasurer secretary; do
    key "apex-m$no-$role"
    HEXES+=("\"$(hexpk "$(addr "apex-m$no-$role")")\"")
    OFFICERS=$(jq -c --arg r "$role" --arg s "$(secret "apex-m$no-$role")" '. + [{role:$r, secret:$s}]' <<<"$OFFICERS")
  done
  SIGNERS="[$(IFS=,; echo "${HEXES[*]}")]"
  stellar contract invoke --id "$BOARD" --source apex-source --network "$NET" -- init --signers "$SIGNERS" --threshold 2
  stellar contract invoke --id "$BOARD" --source apex-source --network "$NET" -- signers
  BOARDS=$(jq -c --argjson no "$no" --arg b "$BOARD" --argjson o "$OFFICERS" '. + [{no:$no, board:$b, threshold:2, officers:$o}]' <<<"$BOARDS")
  echo "member $no board: $BOARD"
done
jq -n --argjson b "$BOARDS" '{warning:"TESTNET KEYS. Never commit.", boards:$b}' > "$OUT/board-keys.json"

cat > "$ROOT/.env.testnet" <<ENV
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
APEX_REGISTER_CONTRACT_ID=$REGISTER
REGISTRAR_SECRET=$(secret apex-registrar)
APEX_SECRET=$(secret apex-apex)
CUSTODIAN_SECRET=$(secret apex-custodian)
SOURCE_SECRET=$(secret apex-source)
BOARD_KEYS_FILE=$OUT/board-keys.json
APEX_SALT_KEY=$(openssl rand -hex 32)
REGISTRAR_SALT=$(openssl rand -hex 32)
CONFIRM_WINDOW_SECS=${CONFIRM_WINDOW_SECS:-120}
ATTEST_WINDOW_SECS=${ATTEST_WINDOW_SECS:-60}
APEX_DATA_DIR=$OUT
ENV
set -a; . "$ROOT/.env.testnet"; set +a
apex() { node "$ROOT/app/dist/src/cli.js" "$@"; }

echo "== init register (registrar signs), members 1-3, custodian"
apex init --registrar "$(addr apex-registrar)" --apex "$(addr apex-apex)" --config data/seed/config.json
for no in 1 2 3; do
  apex member add "$no" "$(jq -r --argjson no "$no" '.boards[] | select(.no==$no) | .board' "$OUT/board-keys.json")" "TESTNET/DT/000$no"
done
apex custodian set "$(addr apex-custodian)"
echo "deployed. Next: scripts/e2e-testnet.sh"
