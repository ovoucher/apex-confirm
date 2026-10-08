#!/usr/bin/env bash
# One period, command by command, against the offline register model (no network).
# The full two-period journey with every seeded response is `apex simulate`; this script
# shows the individual commands each role runs. Test keys only (data/seed/keys.test.json).
#
#   cd app && npm run build && cd .. && scripts/demo-offline.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SEED="$ROOT/data/seed"
DIR="${DEMO_DIR:-$ROOT/var/demo}"
KEYS="$SEED/keys.test.json"
rm -rf "$DIR"
apex() { node "$ROOT/app/dist/src/cli.js" "$@" --offline --data-dir "$DIR"; }

REGISTRAR=$(jq -r .registrar.public "$KEYS")
APEX=$(jq -r .apex.public "$KEYS")
CUSTODIAN=$(jq -r .custodian.public "$KEYS")
export APEX_SALT_KEY=$(jq -r .apex_salt_key "$KEYS")
export REGISTRAR_SALT=$(jq -r .registrar_salt "$KEYS")

echo "== registrar: init, 40 members (member 38 inactive), custodian"
apex init --registrar "$REGISTRAR" --apex "$APEX" --config "$SEED/config.json" --at 2026-08-31T09:00:00Z
tail -n +2 "$SEED/members.csv" | while IFS=, read -r no _name licence board active _notes; do
  apex member add "$no" "$board" "$licence" --at 2026-08-31T09:00:00Z >/dev/null
  if [ "$active" = "false" ]; then apex member deactivate "$no" --at 2026-08-31T09:00:00Z; fi
done
apex custodian set "$CUSTODIAN" --at 2026-08-31T09:00:00Z

echo "== apex: open, validate + build, post"
apex open --as-of 2026-08-31 --at 2026-09-01T07:00:00Z
if apex build --period 1 --book "$SEED/apex-book-2026-08-dirty.csv" --at 2026-09-01T07:05:00Z | grep -E "^error|validation failed"; then
  echo "unexpected: the dirty book was accepted"; exit 1
fi
apex build --period 1 --book "$SEED/apex-book-2026-08.csv" --at 2026-09-01T07:05:00Z | grep -v '^info'
apex post --period 1 --at 2026-09-01T07:10:00Z

echo "== custodian: attest cash from the statement (day 3)"
apex attest --custodian "$CUSTODIAN" --period 1 --statement "$SEED/custodian-statement-2026-08-31.csv" --at 2026-09-03T10:00:00Z

echo "== member 5: check the pack against its own ledger (proposals only)"
apex check --member 5 --pack "$DIR/period-1/packs/5.json" --ledger "$SEED/member-ledgers/5.csv" --at 2026-09-04T08:00:00Z

echo "== member 5's board: confirm the four matching lines, dispute the overstated loan"
LINE=$(jq -r '.lines[] | select(.ref=="APX/LN/2024/0158") | .leaf.index' "$DIR/period-1/packs/5.json")
OTHERS=$(jq -r --arg l "$LINE" '[.lines[] | .leaf.index | tostring | select(. != $l)] | join(",")' "$DIR/period-1/packs/5.json")
apex confirm --member 5 --pack "$DIR/period-1/packs/5.json" --lines "$OTHERS" --at 2026-09-04T09:00:00Z
apex dispute --member 5 --pack "$DIR/period-1/packs/5.json" --line "$LINE" --claimed 25,000,000.00 --reason BALANCE_WRONG --evidence "$SEED/member-ledgers/5.csv" --at 2026-09-04T09:01:00Z

echo "== member 5 cannot confirm the same line twice"
apex confirm --member 5 --pack "$DIR/period-1/packs/5.json" --lines "$LINE" --at 2026-09-04T09:02:00Z || echo "(exit $?)"

echo "== member 33: claim the omitted deposit"
apex omitted --member 33 --period 1 --claimed 12,000,000.00 --at 2026-09-05T09:00:00Z

echo "== registrar: verify the full salted file against the posted root"
apex verify-tree --period 1 --tree "$DIR/period-1/tree.json" --at 2026-09-05T10:00:00Z

echo "== anyone: close before the window ends fails; after it, mark overdue and close"
apex close --period 1 --at 2026-09-05T10:00:00Z || echo "(exit $?)"
apex watch --at 2026-09-11T07:10:01Z
apex close --period 1 --at 2026-09-11T07:10:02Z

echo "== pages"
apex pages --out "$DIR/web" --at 2026-09-11T07:11:00Z
