#!/usr/bin/env bash
# The cli-fixed-bugs job passes only when no record of the full run on writecheck-claim.yaml is
# violated, and the two former CLI false results are not back:
#   C3  MWS-ANN-2 and MWS-ANN-5 on sea_claim: a claim placed on an unclaimed ticket (claim: null -> an
#       object) read as data removed or replaced (CLI 0295ed6);
#   C4  MWS-RETRY-1 on sea_create: `violated` because the manifest names no idempotency key, although
#       sea_create's input schema declares one (CLI 0295ed6). Since f573a24 it is `not tested`.
# The full step runs with fail-on: any, so the action must pass it too.
# Env: OUTCOME EXIT_STATUS CLI_EXIT RESULTS (from the full step).
set -euo pipefail
echo "step outcome: $OUTCOME, action exit-status: $EXIT_STATUS, CLI exit: $CLI_EXIT"
fail() { echo "::error::$1"; exit 1; }
[ -f "$RESULTS/results.json" ] || fail "no results.json in '$RESULTS'"
node -e '
const d = require(process.argv[1]);
// Values from results.json are escaped as GitHub escapes workflow-command data, so none can start a command line.
const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const rows = (req, tool) => d.results.filter((r) => r.requirement === req && r.write_path?.tool === tool);
let bad = 0;
for (const [req, tool, want] of [["MWS-ANN-2", "sea_claim", ["not observed", "held"]], ["MWS-ANN-5", "sea_claim", ["not observed", "held"]], ["MWS-RETRY-1", "sea_create", ["not tested"]]]) {
  const v = [...new Set(rows(req, tool).map((r) => esc(r.verdict)))];
  console.log(`${req} ${tool}: ${v.join(", ") || "no record"}`);
  if (v.length === 0 || v.some((x) => !want.includes(x))) { console.log(`::error::${req} ${tool} is ${v.join(", ") || "missing"}; expected ${want.join(" or ")} (the former CLI false result is back, or the check no longer runs)`); bad = 1; }
}
const violated = d.results.filter((r) => r.verdict === "violated").map((r) => esc(`${r.requirement} ${r.write_path?.tool}`));
if (violated.length) { console.log(`::error::violated records: ${[...new Set(violated)].join(", ")}`); bad = 1; }
process.exit(bad);
' "$RESULTS/results.json" || fail "a former CLI false result is back, or another record is violated"
[ "$OUTCOME" = success ] && [ "$EXIT_STATUS" = 0 ] && [ "$CLI_EXIT" = 0 ] || fail "the full step did not pass (outcome $OUTCOME, action exit-status $EXIT_STATUS, CLI exit $CLI_EXIT)"
echo "no violated record; C3 and C4 stay fixed"
