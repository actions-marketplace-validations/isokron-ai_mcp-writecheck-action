#!/usr/bin/env bash
# Local test of the action's script logic against tiny-tracker, the MWS sample server.
#
# It does what a job would do around the action, without GitHub: it starts tiny-tracker's backend
# on a fixed loopback port, then runs the action's script (src/main.mjs) with the inputs as
# INPUT_* variables and with GITHUB_STEP_SUMMARY and GITHUB_OUTPUT pointing at files, and applies
# the same rule as the last step of action.yml (the job status is the `exit-status` output).
#
# It does not run action.yml itself, the artifact upload, or anything on a GitHub runner.
#
#   CLI_DIR=<built packages/writecheck> TINY_TRACKER_DIR=<built tiny-tracker> test/local-test.sh [out-dir]
#
# Optional:
#   PORT (default 4610) for tiny-tracker's backend;
#   SHIPPED_MANIFEST, tiny-tracker's manifest (default: examples/tiny-tracker/writecheck.yaml of the
#     mcp-write-safety checkout this folder is in, or of MWS_REPO);
#   MWS_SPEC=<spec/mws.md> to check the registry against Annex C in the unit tests;
#   WITH_FETCH=<path or URL of the mcp-write-safety repository> also tests fetching and building the
#     CLI at the pinned commit (needs the npm registry).
#
# The bystander case needs the CLI's compiled regression tests (CLI_DIR/dist/test/regression), which
# `npm run build` makes in a checkout of the CLI; see test/bystander-fixture.mjs.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="$(dirname "$HERE")"
: "${CLI_DIR:?set CLI_DIR to a built packages/writecheck folder}"
: "${TINY_TRACKER_DIR:?set TINY_TRACKER_DIR to a built tiny-tracker folder}"
PORT="${PORT:-4610}"
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
SHIPPED_MANIFEST="${SHIPPED_MANIFEST:-${MWS_REPO:-$ACTION/../..}/examples/tiny-tracker/writecheck.yaml}"
[ -f "$SHIPPED_MANIFEST" ] || { echo "no tiny-tracker manifest at $SHIPPED_MANIFEST; set SHIPPED_MANIFEST or MWS_REPO"; exit 2; }
FAILED=0

# The shipped manifest, with its working folder pointed at the tiny-tracker build (as `demo` does).
MANIFEST="$OUT/writecheck.yaml"
sed "s|^  cwd: .*\$|  cwd: \"$TINY_TRACKER_DIR\"|" "$SHIPPED_MANIFEST" > "$MANIFEST"

# The test environment: tiny-tracker's in-memory backend on loopback, with a throwaway token (a job
# can set and mask its own first).
export TRACKER_BACKEND_TOKEN="${TRACKER_BACKEND_TOKEN:-local-test-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
export TRACKER_BACKEND_URL="http://127.0.0.1:$PORT"
BACKEND=""
FIXTURE=""
start_backend() {
  (cd "$TINY_TRACKER_DIR" && exec node dist/src/cli.js backend --port "$PORT") > "$OUT/backend.log" 2>&1 &
  BACKEND=$!
  for _ in $(seq 1 50); do grep -q '"backend"' "$OUT/backend.log" 2>/dev/null && break; sleep 0.1; done
  grep -q '"backend"' "$OUT/backend.log" || { echo "the backend did not start; see $OUT/backend.log"; exit 2; }
}
trap 'kill "$BACKEND" $FIXTURE 2>/dev/null || true' EXIT
start_backend

# output_of NAME KEY: the value the script wrote for KEY in its outputs, or nothing.
output_of() {
  [ -f "$OUT/$1.output" ] || return 0
  sed -n "s/^$2=//p" "$OUT/$1.output" | tail -1
}

# wait_ledger NAME ENTRIES: wait until the run of case NAME has written ENTRIES ledger entries in its
# state folder, or 120 s have passed.
wait_ledger() {
  local n
  for _ in $(seq 1 1200); do
    n="$( { cat "$OUT/$1.results"/state/*/ledger.jsonl 2>/dev/null || true; } | wc -l | tr -d ' ')"
    [ "${n:-0}" -ge "$2" ] && return 0
    sleep 0.1
  done
  echo "   (case $1: the ledger never reached $2 entries)"
}

# run_case NAME [NAME=VALUE ...]: one run of the action's script. Writes NAME.summary.md,
# NAME.output and NAME.log, and sets STATUS (the job status), CLI_EXIT and PLAN_HASH.
# With SIGNAL_AT=<entries> set, the script is sent SIGTERM once the run has written that many ledger
# entries, that is, in the middle of its writes (a cancelled job). A fixed delay does not work: a full
# run against tiny-tracker takes from about 12 s on a fast machine to well over 20 s on a slow one.
run_case() {
  local name="$1"; shift
  rm -rf "$OUT/$name.summary.md" "$OUT/$name.output" "$OUT/$name.results"
  local script_exit=0
  env INPUT_MANIFEST="$MANIFEST" INPUT_CLI_PATH="$CLI_DIR" INPUT_RESULTS_DIR="$OUT/$name.results" \
      INPUT_ARTIFACT_NAME="mcp-writecheck-results" \
      GITHUB_STEP_SUMMARY="$OUT/$name.summary.md" GITHUB_OUTPUT="$OUT/$name.output" "$@" \
      nice node "$ACTION/src/main.mjs" > "$OUT/$name.log" 2>&1 &
  local pid=$!
  if [ -n "${SIGNAL_AT:-}" ]; then wait_ledger "$name" "$SIGNAL_AT"; kill -TERM "$pid" 2>/dev/null || true; fi
  wait "$pid" || script_exit=$?
  # The last step of action.yml: the job fails unless the script decided on status 0.
  STATUS="$(output_of "$name" exit-status)"
  [ "$script_exit" = 0 ] || STATUS=1
  STATUS="${STATUS:-1}"
  CLI_EXIT="$(output_of "$name" cli-exit-code)"
  PLAN_HASH="$(output_of "$name" plan-hash)"
}

# expect NAME WANT_STATUS WANT_CLI_EXIT
expect() {
  local verdict=ok
  if [ "$STATUS" != "$2" ] || [ "${CLI_EXIT:-none}" != "$3" ]; then verdict=WRONG; FAILED=1; fi
  printf '%-34s job status %s (want %s)   cli exit %s (want %s)   %s\n' "$1" "$STATUS" "$2" "${CLI_EXIT:-none}" "$3" "$verdict"
}

echo "== unit tests (CLI_DIR set${MWS_SPEC:+, MWS_SPEC set})"
CLI_DIR="$CLI_DIR" nice node --test --test-reporter=tap "$HERE"/*.test.mjs > "$OUT/unit.log" 2>&1 && grep -E '^# (tests|pass|fail|skipped)' "$OUT/unit.log" || { cat "$OUT/unit.log"; FAILED=1; }

# The safety lines of a summary: the job status, the sections before the verdicts, the violated records.
show() {
  grep -E '^\*\*Job status|^### (Objects the tester|Setup not released|Needs attention)|^- `MWS-[A-Z0-9-]*` on|^- (Objects of this run|Clean-up|Creates whose|The set-up of)' "$OUT/$1.summary.md" | grep -v 'objects listed:' | cut -c1-240 | sed 's/^/   /' || true
  grep -o '^- \[MWS-[A-Z0-9-]*\]([^)]*) on `[^`]*`, scenario `[^`]*`: \*\*violated ([^)]*)\*\*[^.]*' "$OUT/$1.summary.md" | sed 's/^/   /' || true
}

echo "== correct build"
run_case plan-live INPUT_MODE=plan GITHUB_ACTIONS=true
expect "plan (tools/list from the server)" 0 0
HASH="$PLAN_HASH"; echo "   plan hash $HASH"

run_case full-correct INPUT_MODE=full INPUT_FAIL_ON=must INPUT_CONFIRM_TARGET=tiny-tracker INPUT_PLAN_HASH="$HASH"
expect "full, fail-on must" 0 0
CATALOG="$(ls "$OUT"/full-correct.results/*/catalog.json | head -1)"

show full-correct

run_case full-correct-any INPUT_MODE=full INPUT_FAIL_ON=any INPUT_CONFIRM_TARGET=tiny-tracker INPUT_PLAN_HASH="$HASH"
expect "full, fail-on any" 0 0

run_case catalog-live INPUT_MODE=catalog INPUT_FAIL_ON=any
expect "catalog (tools/list from the server), any" 0 0

run_case catalog-saved INPUT_MODE=catalog INPUT_FAIL_ON=any INPUT_CATALOG="$CATALOG"
expect "catalog (saved catalog, no server), any" 0 0

run_case plan-catalog INPUT_MODE=plan INPUT_CATALOG="$CATALOG"
expect "plan (saved catalog, no server)" 0 0
[ "$PLAN_HASH" = "$HASH" ] && echo "   same plan hash as the live plan: yes" || { echo "   same plan hash as the live plan: NO ($PLAN_HASH)"; FAILED=1; }

run_case full-wrong-hash INPUT_MODE=full INPUT_FAIL_ON=none INPUT_CONFIRM_TARGET=tiny-tracker INPUT_PLAN_HASH=0000000000000000
expect "full, wrong plan hash, fail-on none" 1 3

run_case full-no-confirmation INPUT_MODE=full INPUT_FAIL_ON=none
expect "full, no confirm-target" 1 none

# One defect per block: plan first (the catalog can differ, so the hash can), then the full runs.
defect() {
  local d="$1"; shift
  echo "== defect $d"
  run_case "plan-$d" INPUT_MODE=plan TRACKER_DEFECTS="$d"
  local h="$PLAN_HASH"; echo "   plan hash $h"
  while [ $# -gt 0 ]; do
    run_case "full-$d-$1" INPUT_MODE=full INPUT_FAIL_ON="$1" INPUT_CONFIRM_TARGET=tiny-tracker INPUT_PLAN_HASH="$h" TRACKER_DEFECTS="$d"
    expect "full, fail-on $1" "$2" "$3"
    show "full-$d-$1"
    shift 3
  done
}

# MWS-CONC-1, a MUST: fails under must and any, not under none.
defect force-by-default must 1 1 none 0 1 any 1 1
# MWS-RETRY-1, a SHOULD: fails only under any.
defect no-idempotency-key must 0 0 any 1 0
# MWS-TGT-2, a MUST, on the opt-in empty selector forms (selector.send_empty_forms): only the tester's own
# container is emptied; the bystander inventory finds nothing lost, so fail-on decides.
defect empty-filter-deletes-all none 0 1 must 1 1

# MWS-ANN-4, a SHOULD, judged in catalog mode from tools/list alone: fails only under any.
echo "== defect missing-annotations, catalog mode"
for f in must any; do
  run_case "catalog-missing-annotations-$f" INPUT_MODE=catalog INPUT_FAIL_ON="$f" TRACKER_DEFECTS=missing-annotations
  [ "$f" = must ] && want=0 || want=1
  expect "catalog, fail-on $f" "$want" 0
  show "catalog-missing-annotations-$f"
done

echo "== a run that lost objects it did not create (the CLI's regression server, case S1)"
node "$HERE/bystander-fixture.mjs" "$CLI_DIR" "$OUT" > "$OUT/bystander-fixture.json" 2> "$OUT/bystander-fixture.log" &
FIXTURE=$!
for _ in $(seq 1 50); do [ -s "$OUT/bystander-fixture.json" ] && break; sleep 0.1; done
BYS_ENV=()
while IFS= read -r line; do BYS_ENV+=("$line"); done < <(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const[k,v] of Object.entries(j.env))console.log(`${k}=${v}`);console.log(`INPUT_MANIFEST=${j.manifest}`);console.log(`INPUT_CONFIRM_TARGET=${j.confirm}`)' "$OUT/bystander-fixture.json")
run_case plan-bystander INPUT_MODE=plan "${BYS_ENV[@]}"
expect "plan" 0 0
BHASH="$PLAN_HASH"
run_case full-bystander-none INPUT_MODE=full INPUT_FAIL_ON=none INPUT_PLAN_HASH="$BHASH" "${BYS_ENV[@]}"
expect "full, fail-on none" 1 1
show full-bystander-none
kill -TERM "$FIXTURE"; wait "$FIXTURE" 2>/dev/null || true; FIXTURE=""
echo "   ground truth from the fixture's backend: $(cat "$OUT/bystander-left.json")"

echo "== a run that stopped before it finished (write budget 40)"
sed 's/write_budget: 20000/write_budget: 40/' "$MANIFEST" > "$OUT/writecheck-budget.yaml"
run_case plan-budget INPUT_MODE=plan INPUT_MANIFEST="$OUT/writecheck-budget.yaml"
run_case full-budget-none INPUT_MODE=full INPUT_FAIL_ON=none INPUT_CONFIRM_TARGET=tiny-tracker INPUT_PLAN_HASH="$PLAN_HASH" INPUT_MANIFEST="$OUT/writecheck-budget.yaml"
expect "full, fail-on none" 1 4
show full-budget-none

echo "== set-ups that fail (create.id names a field the create result does not have; Action finding A4)"
# Every resource with an object under test (ticket, ticket-replace): no write path of theirs is tested. The pinned CLI
# reports the run complete with exit 0; a CLI with the fix (e613620 on) stops it with exit 4. The job fails either way.
sed 's/}, id: id, name_path: title }$/}, id: no_such_id, name_path: title }/' "$MANIFEST" > "$OUT/writecheck-setup-fails.yaml"
run_case plan-setup-fails INPUT_MODE=plan INPUT_MANIFEST="$OUT/writecheck-setup-fails.yaml"
run_case full-setup-fails-none INPUT_MODE=full INPUT_FAIL_ON=none INPUT_CONFIRM_TARGET=tiny-tracker INPUT_PLAN_HASH="$PLAN_HASH" INPUT_MANIFEST="$OUT/writecheck-setup-fails.yaml"
case "$CLI_EXIT" in 0|4) want_exit=$CLI_EXIT ;; *) want_exit="0 or 4" ;; esac
expect "every set-up fails, fail-on none" 1 "$want_exit"
show full-setup-fails-none
# Only ticket-replace's: ticket is tested, so fail-on decides; the failed set-up is listed under Needs attention.
awk '/^  - name: ticket-replace$/ { r = 1 } r && /}, id: id, name_path: title }$/ { sub(/}, id: id, name_path: title }$/, "}, id: no_such_id, name_path: title }") } { print }' "$MANIFEST" > "$OUT/writecheck-setup-partial.yaml"
run_case plan-setup-partial INPUT_MODE=plan INPUT_MANIFEST="$OUT/writecheck-setup-partial.yaml"
run_case full-setup-partial-none INPUT_MODE=full INPUT_FAIL_ON=none INPUT_CONFIRM_TARGET=tiny-tracker INPUT_PLAN_HASH="$PLAN_HASH" INPUT_MANIFEST="$OUT/writecheck-setup-partial.yaml"
expect "one of two set-ups fails, fail-on none" 0 0
show full-setup-partial-none

echo "== a cancelled run (SIGTERM to the action's script once the run has written 100 ledger entries)"
SIGNAL_AT=100 run_case full-cancelled-none INPUT_MODE=full INPUT_FAIL_ON=none INPUT_CONFIRM_TARGET=tiny-tracker INPUT_PLAN_HASH="$HASH"
expect "full, fail-on none" 1 130
show full-cancelled-none
ls "$OUT/full-cancelled-none.results/state" >/dev/null 2>&1 && echo "   state folder in the results folder: yes ($(ls "$OUT/full-cancelled-none.results/state" | tr '\n' ' '))" || { echo "   state folder in the results folder: NO"; FAILED=1; }

echo "== a crashed test environment (the backend killed once the run has written 100 ledger entries)"
rm -rf "$OUT/full-crashed-none.results"
(wait_ledger full-crashed-none 100; kill "$BACKEND" 2>/dev/null) &
KILLER=$!
run_case full-crashed-none INPUT_MODE=full INPUT_FAIL_ON=none INPUT_CONFIRM_TARGET=tiny-tracker INPUT_PLAN_HASH="$HASH"
wait "$KILLER" 2>/dev/null || true
# The CLI reports this run as complete and exits 0 (NOTES.md, CLI problem 14); the unfinished clean-up fails the job.
expect "full, fail-on none" 1 0
show full-crashed-none
start_backend

if [ -n "${WITH_FETCH:-}" ]; then
  echo "== fetch and build the CLI at the pinned commit"
  mkdir -p "$OUT/runner-temp"
  # INPUT_CLI_PATH is given empty, so the script fetches and builds instead of using CLI_DIR.
  run_case fetch INPUT_CLI_PATH= INPUT_MODE=plan INPUT_CATALOG="$CATALOG" MCP_WRITECHECK_CLI_REPOSITORY="$WITH_FETCH" RUNNER_TEMP="$OUT/runner-temp"
  expect "plan with a fetched CLI" 0 0
  [ "$PLAN_HASH" = "$HASH" ] && echo "   same plan hash as the prebuilt CLI: yes" || { echo "   same plan hash as the prebuilt CLI: NO ($PLAN_HASH)"; FAILED=1; }
fi

echo
[ "$FAILED" = 0 ] && echo "All cases as expected. Summaries, outputs and logs: $OUT" || echo "SOME CASES WERE NOT AS EXPECTED. See $OUT"
exit "$FAILED"
