#!/usr/bin/env bash
# One full period on testnet with three members and a 120-second confirmation window:
# open, build, post, confirm, dispute, attest, close, public report.
#
# WRITTEN BUT NOT EXECUTED: the build environment could not reach Stellar testnet.
# Run scripts/deploy-testnet.sh first (it writes .env.testnet).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env.testnet"; set +a
OUT="$APEX_DATA_DIR"
apex() { node "$ROOT/app/dist/src/cli.js" "$@"; }
TODAY=$(date -u +%Y-%m-%d)
AS_OF=$(date -u -d yesterday +%Y-%m-%d)

echo "== a three-member book, ledgers and a custodian statement (simulated)"
cat > "$OUT/book.csv" <<CSV
line_ref,cp_no,cp_name,kind,balance_kes,arrears_days,product,opened,notes
TN/DEP/1,1,Testnet Sacco One,DEP,"10,000,000.00",,Call placement,2025-01-10,
TN/DEP/2,2,Testnet Sacco Two,DEP,"8,000,000.00",,Term placement,2025-02-11,
TN/DEP/3,3,Testnet Sacco Three,DEP,"6,000,000.00",,Call placement,2025-03-12,
TN/LN/1,1,Testnet Sacco One,LOAN,"4,000,000.00",0,Development loan,2025-04-01,
TN/LN/2,2,Testnet Sacco Two,LOAN,"7,500,000.00",0,Development loan,2025-05-01,
TN/LN/3,3,Testnet Sacco Three,LOAN,"2,000,000.00",15,Liquidity loan,2025-06-01,
CSV
printf 'line_ref,kind,balance_kes,arrears_days\nTN/DEP/2,DEP,"8,000,000.00",0\nTN/LN/2,LOAN,"3,000,000.00",0\n' > "$OUT/ledger-2.csv"
cat > "$OUT/statement.csv" <<CSV
Bank,TESTNET CUSTODIAN (simulated)
Account,0001 TESTNET APEX (simulated)
Period,$AS_OF to $AS_OF
posting_date,value_date,reference,narrative,debit_kes,credit_kes,balance_kes
$AS_OF,$AS_OF,OPENING BALANCE,,,,9000000.00
$AS_OF,$AS_OF,FT1,PLACEMENT FROM MEMBER 003,,1000000.00,
$AS_OF,$AS_OF,CLOSING BALANCE,,,,10000000.00
CSV

echo "== apex: open (balance date $AS_OF), build offline, post"
# `apex open` prints the transaction hash, then the returned period id on its last line.
PERIOD=$(apex open --as-of "$AS_OF" | tee /dev/stderr | tail -n 1)
apex build --offline --data-dir "$OUT" --period "$PERIOD" --book "$OUT/book.csv"
apex post --period "$PERIOD"

echo "== member 2's board (2 of 3 officers) disputes the loan and confirms the deposit"
# ($OUT/ledger-2.csv is member 2's own view; `apex check` runs against the offline model only.)
L2=$(jq -r '.lines[] | select(.ref=="TN/LN/2") | .leaf.index' "$OUT/period-$PERIOD/packs/2.json")
D2=$(jq -r '.lines[] | select(.ref=="TN/DEP/2") | .leaf.index' "$OUT/period-$PERIOD/packs/2.json")
apex dispute --member 2 --pack "$OUT/period-$PERIOD/packs/2.json" --line "$L2" --claimed 3,000,000.00 --reason BALANCE_WRONG
apex confirm --member 2 --pack "$OUT/period-$PERIOD/packs/2.json" --lines "$D2"

echo "== members 1 and 3 confirm everything"
for no in 1 3; do apex confirm --member "$no" --pack "$OUT/period-$PERIOD/packs/$no.json" --lines all; done

echo "== custodian attests"
apex attest --custodian "$CUSTODIAN_SECRET" --period "$PERIOD" --statement "$OUT/statement.csv"

echo "== wait for the confirmation window, then close and read"
sleep $(( CONFIRM_WINDOW_SECS + 10 ))
apex close --period "$PERIOD"
apex report --period "$PERIOD" --as public
echo "done ($TODAY)"
