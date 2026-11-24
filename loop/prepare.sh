#!/usr/bin/env bash
# Set-up of the writecheck loop worker's job, shared by .github/workflows/corpus.yml (the worker the pump
# dispatches) and .github/workflows/loop-fixture.yml (its pull-request proof run). Run from the workspace root.
#
#   loop/prepare.sh fetch      mcp-writecheck at CLI_REF (built by dogfood/build-cli.sh), mcp-surface-corpus at
#                              SANDBOX_REF (the sandbox), tool-qa's seed at SEED_REF; every checkout is a public
#                              repository fetched by its full commit SHA, with no token, and checked to be at it
#   loop/prepare.sh sandbox    gVisor and the host firewall from that checkout: install-runsc.sh, then net-guard.sh
#                              (registering runsc restarts the Docker daemon, so the firewall comes second)
#   loop/prepare.sh selftest   mcp-surface-corpus's sandbox self test (hostile target, eleven escape attempts) and
#                              its telemetry check. The check decides, as in that repository's sandbox-selftest.yml;
#                              a failure stops the job before any target runs.
#
# TODO(sandbox-conformance): call mcp-surface-corpus's reusable sandbox-conformance.yml for the self test once it
# is merged there; until then the self test runs inline here, from the same pinned checkout.
#
# Nothing here runs third-party server code: the CLI is built before anything else, from its own lockfile with
# install scripts off (dogfood/build-cli.sh).
set -euo pipefail

sha_re='^[0-9a-f]{40}$'

fetch_at() { # repo sha dir [sparse path...]
  local repo=$1 sha=$2 dir=$3
  shift 3
  [[ "$sha" =~ $sha_re ]] || { echo "::error::$repo: not a full commit SHA"; exit 1; }
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" remote add origin "https://github.com/$repo.git"
  if [ "$#" -gt 0 ]; then
    git -C "$dir" sparse-checkout set --no-cone "$@"
  fi
  git -C "$dir" -c protocol.version=2 fetch -q --depth 1 --filter=blob:none origin "$sha"
  git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
  [ "$(git -C "$dir" rev-parse HEAD)" = "$sha" ] || { echo "::error::$repo is not at $sha"; exit 1; }
  echo "$repo at $sha"
}

case "${1:-}" in
  fetch)
    : "${CLI_REF:?}" "${SANDBOX_REF:?}" "${SEED_REF:?}"
    fetch_at isokron-ai/mcp-write-safety "$CLI_REF" mws-cli /packages/writecheck/ /spec/mws.md
    dogfood/build-cli.sh
    fetch_at isokron-ai/mcp-surface-corpus "$SANDBOX_REF" msc
    fetch_at isokron-ai/tool-qa "$SEED_REF" toolqa /history/seed-v1.json
    ;;
  sandbox)
    sudo msc/scripts/install-runsc.sh "$(command -v node)"
    sudo msc/scripts/net-guard.sh
    ;;
  selftest)
    out="${RUNNER_TEMP:?}/selftest"
    node msc/bin/sandbox-selftest.mjs --out "$out" --lane ci || echo "::warning::the self test harness reported a failure; the telemetry check decides"
    node msc/scripts/check-selftest.mjs "$out/telemetry.jsonl"
    ;;
  *)
    echo "usage: loop/prepare.sh fetch|sandbox|selftest" >&2
    exit 2
    ;;
esac
