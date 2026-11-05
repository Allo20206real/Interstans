#!/usr/bin/env bash
# Tests the database rules against a local Postgres that imitates Supabase.
# Usage: supabase/tests/run.sh "<psql connection args>"   (use an empty database)
set -euo pipefail
cd "$(dirname "$0")"
P="psql $1 -v ON_ERROR_STOP=1 -q -t -A"
$P -f stub.sql >/dev/null
$P -f ../schema.sql >/dev/null 2>&1
$P -f ../schema.sql >/dev/null 2>&1   # must be safe to run twice
out=$($P -f checks.sql | grep '^ok ' || true)
echo "$out"
want=$(grep -c "select 'ok " checks.sql); got=$(echo "$out" | grep -c '^ok ' || true)
if [ "$got" -ne "$want" ]; then echo "FAILED: $got of $want checks passed"; exit 1; fi
echo "All $want checks passed"
