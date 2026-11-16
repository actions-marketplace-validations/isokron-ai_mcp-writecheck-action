#!/usr/bin/env bash
# Two former CLI bugs, now plain expectations (fixed in the CLI from e613620 on; the pin f573a24 has both
# fixes). Each case must make the CLI stop the run (exit 4, run status `stopped`), and the action must
# fail the job.
#   TRAP=<name> CLI_EXIT=<exit> EXIT_STATUS=<action status> RESULTS=<run folder> [CRASH_LOG=<file>] \
#     dogfood/tiny-tracker/expect-trap.sh
# backend-crash  the backend is killed during the run (CRASH_LOG must show it happened before the run
#                ended). Until e613620 the run was reported complete with exit 0 (NOTES.md, CLI problem 14).
# setup-fails    every resource's set-up fails (results.json must show it). Until e613620: exit 0, complete
#                (Action finding A4).
# A return of either bug (exit 0, or a run reported complete) fails the step, whatever cli-ref was chosen.
# A trap that did not happen as designed fails the step too.
set -euo pipefail
fail() { echo "::error::$1"; exit 1; }
[ -n "${CLI_EXIT:-}" ] || fail "trap $TRAP did not run (no CLI exit status)"
[ -n "${RESULTS:-}" ] && [ -f "$RESULTS/results.json" ] || fail "trap $TRAP: no results.json"
status=$(node -e 'console.log(require(process.argv[1]).run?.status ?? "")' "$RESULTS/results.json")
echo "trap $TRAP: CLI exit $CLI_EXIT, run status $status, action exit-status ${EXIT_STATUS:-none}"
case "$TRAP" in
  backend-crash)
    [ -f "${CRASH_LOG:-}" ] && cat "$CRASH_LOG"
    crashed=$(sed -n 's/^crashed at \([0-9]*\).*/\1/p' "${CRASH_LOG:-/dev/null}" | head -1)
    [ -n "$crashed" ] || fail "trap backend-crash: the backend was not crashed (see the crash log above); nothing to judge"
    ended=$(node -e 'const t=Date.parse(require(process.argv[1]).run?.ended ?? ""); console.log(Number.isFinite(t) ? t : 0)' "$RESULTS/results.json")
    [ "$ended" -gt "$crashed" ] || fail "trap backend-crash: the backend was killed after the run ended; nothing to judge"
    ;;
  setup-fails)
    n=$(node -e 'const d=require(process.argv[1]); console.log(d.results.filter((r) => /^setup failed:/.test(r.reason ?? "")).length)' "$RESULTS/results.json")
    [ "$n" -gt 0 ] || fail "trap setup-fails: no record says the set-up failed; the trap did not happen as designed"
    ;;
  *) fail "unknown trap $TRAP" ;;
esac
[ "${EXIT_STATUS:-}" = 1 ] || fail "the action did not fail the job ($TRAP)"
[ "$CLI_EXIT" = 4 ] && [ "$status" = stopped ] || fail "the CLI did not stop the run ($TRAP): exit $CLI_EXIT, run status $status; expected exit 4 and stopped (the former CLI bug is back)"
echo "trap $TRAP: the CLI stopped the run (exit 4) and the action failed the job, as required"
