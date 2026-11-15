# The first run on a GitHub runner: plan

Not run. Nothing here has been created: no repository, no secret, no push. This file says what Joshua or the coordinator sets up, and what the run must show.

The local test (`TESTING.md`) runs the action's script outside GitHub. What only a runner can show is listed under "What has not been tested" in `TESTING.md`; every item there is covered by a step below.

## What is decided, and what still blocks the run

Decided by the owner on 15 November 2026: the action gets its **own public repository** (proposed: `isokron-ai/mcp-writecheck-action`), so that it can be listed on the Marketplace; `integrations/` (the action and the skills) is **Apache-2.0**; the npm name of the CLI is `@mcp-write-safety/writecheck`.

What still blocks the run, and who acts:

| Blocker | Why it blocks | Who |
|---|---|---|
| The CLI is not on npm, and `isokron-ai/mcp-write-safety` is private | The action fetches the CLI from that repository, so **the run needs `cli-token` even though the action's repository is public.** Without it the fetch fails with "repository not found". This lasts until the CLI is published to npm or the repository is made public. | Joshua: create the token (below) |
| The action's repository does not exist | Variant B below needs it. Variant A does not: it vendors the action into the test repository. | Joshua or the coordinator: create it from `integrations/` (layout in the delivery's INDEX.md) |
| The test repository does not exist | Both variants. | Joshua or the coordinator |
| The organization's Actions policy | The test repository must be allowed to run `actions/checkout`, `actions/setup-node` and `actions/upload-artifact` (pinned by SHA), and, for variant B, `isokron-ai/mcp-writecheck-action`. | Joshua, in the organization's Actions settings |

Nothing else blocks it. The licence and the location are decided; the npm organization is not needed for this run.

## The secret

One secret, in the test repository: **`MWS_CLI_TOKEN`**.

- A fine-grained personal access token, resource owner `isokron-ai`, repository access **only** `isokron-ai/mcp-write-safety`, permission **Contents: read-only**, and nothing else. Expiry: 7 days is enough for this run.
- If the organization requires approval of fine-grained tokens, approve it.
- It is used for two things only: the action's one `git fetch` of the CLI (input `cli-token`; only the action's own "Obtain mcp-writecheck" step gets it, and it masks the token; that step passes it to git as an HTTP header through `GIT_CONFIG_*` variables for the fetch alone, never in argv or a URL, with global and system git configuration and hooks switched off; the run step, which starts the server, never has it), and the test workflow's checkout of tiny-tracker from the same repository.

No other secret is needed. tiny-tracker's backend token is generated inside each job and lives only there; the default `GITHUB_TOKEN` is used read-only (`permissions: contents: read`).

## The test repository

Private, for example `isokron-ai/mwsv-action-runner-test` (the `mwsv-` prefix marks lane objects). It holds no server code of its own: the job checks tiny-tracker out of `mcp-write-safety` with the token.

```text
mwsv-action-runner-test/
├── .github/
│   ├── actions/
│   │   └── mcp-writecheck/          # variant A only: action.yml, contract.mjs and src/ from the root of isokron-ai/mcp-writecheck-action
│   │       ├── action.yml
│   │       ├── contract.mjs
│   │       └── src/
│   │           ├── install.mjs
│   │           ├── main.mjs
│   │           └── summary.mjs
│   └── workflows/
│       └── mcp-writecheck-runner-test.yml
├── writecheck.yaml                  # tiny-tracker's manifest from mcp-write-safety@0295ed6, cwd changed (below)
└── README.md                        # one line: what this repository is for, and that it is temporary
```

`writecheck.yaml` is `examples/tiny-tracker/writecheck.yaml` of `mcp-write-safety` at `0295ed6`, with one line changed so that the server is started from the checked-out tiny-tracker:

```yaml
  cwd: tt/examples/tiny-tracker
```

(The manifest resolves `cwd` relative to its own folder, the repository root.)

### Variant A, before the action's repository exists

Copy `action.yml`, `contract.mjs` and `src/` from the root of this repository into `.github/actions/mcp-writecheck/` and use `uses: ./.github/actions/mcp-writecheck`. This tests everything except resolving the action from another repository by SHA.

### Variant B, after the action's repository exists

Delete `.github/actions/` and replace each `uses: ./.github/actions/mcp-writecheck` with `uses: isokron-ai/mcp-writecheck-action@<full commit SHA of its first release commit>`. Run it once more. This is the run that counts for the Marketplace.

## The workflow

`.github/workflows/mcp-writecheck-runner-test.yml`. It is started by hand (`workflow_dispatch`) in two rounds:

1. **Round 1**, with `plan_hash` empty: the `plan` and `catalog` jobs run, and the `full` jobs are skipped. A person opens the `plan` job's summary, reads the plan, and copies the hash.
2. **Round 2**, with `plan_hash` set to that hash: every job runs.

The hash is typed in by a person, never taken from a plan job's output: that is the action's design rule 2, and the run must follow it.

```yaml
name: mcp-writecheck runner test

on:
  workflow_dispatch:
    inputs:
      plan_hash:
        description: The plan hash from round 1's plan job, after reading the plan. Empty for round 1.
        required: false
        default: ''

permissions:
  contents: read

env:
  # The same backend URL in every job, so that every job arrives at the same plan hash.
  TRACKER_BACKEND_URL: http://127.0.0.1:4610

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Check out tiny-tracker
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: isokron-ai/mcp-write-safety
          ref: b9265fe3d768a40f316837cf31528e856ff809d8 # examples/tiny-tracker-resync
          token: ${{ secrets.MWS_CLI_TOKEN }}
          path: tt
          sparse-checkout: examples/tiny-tracker
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - name: Build tiny-tracker
        working-directory: tt/examples/tiny-tracker
        run: npm ci --ignore-scripts --no-audit --no-fund && npm run build
      - name: A backend token for this job only
        run: |
          t="$(openssl rand -hex 16)"
          echo "::add-mask::$t"
          echo "TRACKER_BACKEND_TOKEN=$t" >> "$GITHUB_ENV"
      # plan starts the server for tools/list only; nothing is sent to the backend, so none is started.
      - id: plan
        uses: ./.github/actions/mcp-writecheck
        with:
          manifest: writecheck.yaml
          mode: plan
          artifact-name: plan
          cli-token: ${{ secrets.MWS_CLI_TOKEN }}
      - name: Check
        env:
          EXIT_STATUS: ${{ steps.plan.outputs.exit-status }}
          PLAN_HASH: ${{ steps.plan.outputs.plan-hash }}
        run: |
          test "$EXIT_STATUS" = 0
          echo "$PLAN_HASH" | grep -Eq '^[0-9a-f]{16}$'
          echo "Plan hash $PLAN_HASH. Read the plan in this job's summary before using it in round 2."

  catalog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Check out tiny-tracker
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: isokron-ai/mcp-write-safety
          ref: b9265fe3d768a40f316837cf31528e856ff809d8 # examples/tiny-tracker-resync
          token: ${{ secrets.MWS_CLI_TOKEN }}
          path: tt
          sparse-checkout: examples/tiny-tracker
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - name: Build tiny-tracker
        working-directory: tt/examples/tiny-tracker
        run: npm ci --ignore-scripts --no-audit --no-fund && npm run build
      - name: A backend token for this job only
        run: |
          t="$(openssl rand -hex 16)"
          echo "::add-mask::$t"
          echo "TRACKER_BACKEND_TOKEN=$t" >> "$GITHUB_ENV"
      - id: correct
        uses: ./.github/actions/mcp-writecheck
        with:
          manifest: writecheck.yaml
          mode: catalog
          fail-on: any
          artifact-name: catalog-correct
          cli-token: ${{ secrets.MWS_CLI_TOKEN }}
      # MWS-ANN-4 is a SHOULD and fail-on is any: this step is expected to fail, and is checked after.
      - id: defect
        continue-on-error: true
        uses: ./.github/actions/mcp-writecheck
        env:
          TRACKER_DEFECTS: missing-annotations
        with:
          manifest: writecheck.yaml
          mode: catalog
          fail-on: any
          artifact-name: catalog-missing-annotations
          cli-token: ${{ secrets.MWS_CLI_TOKEN }}
      - name: Check
        env:
          A: ${{ steps.correct.outputs.exit-status }}
          B: ${{ steps.defect.outputs.exit-status }}
          B_OUTCOME: ${{ steps.defect.outcome }}
          B_CLI: ${{ steps.defect.outputs.cli-exit-code }}
        run: |
          echo "correct $A (want 0); missing-annotations $B (want 1), cli $B_CLI (want 0), outcome $B_OUTCOME (want failure)"
          test "$A" = 0 && test "$B" = 1 && test "$B_CLI" = 0 && test "$B_OUTCOME" = failure

  full:
    if: inputs.plan_hash != ''
    runs-on: ubuntu-latest
    # Each matrix job starts its own in-memory backend on its own runner, so the cases cannot be each other's second writer.
    strategy:
      fail-fast: false
      matrix:
        include:
          - { case: correct-must, defect: '', fail_on: must, want_status: 0, want_cli: 0, hash: '' }
          - { case: force-by-default-must, defect: force-by-default, fail_on: must, want_status: 1, want_cli: 1, hash: '' }
          - { case: force-by-default-none, defect: force-by-default, fail_on: none, want_status: 0, want_cli: 1, hash: '' }
          - { case: wrong-hash-none, defect: '', fail_on: none, want_status: 1, want_cli: 3, hash: '0000000000000000' }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Check out tiny-tracker
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: isokron-ai/mcp-write-safety
          ref: b9265fe3d768a40f316837cf31528e856ff809d8 # examples/tiny-tracker-resync
          token: ${{ secrets.MWS_CLI_TOKEN }}
          path: tt
          sparse-checkout: examples/tiny-tracker
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - name: Build tiny-tracker
        working-directory: tt/examples/tiny-tracker
        run: npm ci --ignore-scripts --no-audit --no-fund && npm run build
      - name: A backend token for this job only
        run: |
          t="$(openssl rand -hex 16)"
          echo "::add-mask::$t"
          echo "TRACKER_BACKEND_TOKEN=$t" >> "$GITHUB_ENV"
      - name: Start tiny-tracker's backend (the test environment; in memory, gone with the job)
        working-directory: tt/examples/tiny-tracker
        run: |
          nohup node dist/src/cli.js backend --port 4610 > "$RUNNER_TEMP/backend.log" 2>&1 &
          for i in $(seq 1 50); do grep -q '"backend"' "$RUNNER_TEMP/backend.log" && break; sleep 0.1; done
          grep -q '"backend"' "$RUNNER_TEMP/backend.log"
      - id: run
        continue-on-error: true
        uses: ./.github/actions/mcp-writecheck
        env:
          TRACKER_DEFECTS: ${{ matrix.defect }}
        with:
          manifest: writecheck.yaml
          mode: full
          fail-on: ${{ matrix.fail_on }}
          confirm-target: tiny-tracker
          plan-hash: ${{ matrix.hash != '' && matrix.hash || inputs.plan_hash }}
          artifact-name: full-${{ matrix.case }}
          cli-token: ${{ secrets.MWS_CLI_TOKEN }}
      - name: Check
        env:
          STATUS: ${{ steps.run.outputs.exit-status }}
          CLI: ${{ steps.run.outputs.cli-exit-code }}
          OUTCOME: ${{ steps.run.outcome }}
          WANT_STATUS: ${{ matrix.want_status }}
          WANT_CLI: ${{ matrix.want_cli }}
        run: |
          echo "exit-status $STATUS (want $WANT_STATUS), cli-exit-code $CLI (want $WANT_CLI), outcome $OUTCOME"
          test "$STATUS" = "$WANT_STATUS" && test "$CLI" = "$WANT_CLI"
          if [ "$WANT_STATUS" = 0 ]; then test "$OUTCOME" = success; else test "$OUTCOME" = failure; fi

  # A full run cut by a step timeout about a minute in (a whole run takes about two). The CLI is
  # built first and given as cli-path, so that the cut lands inside the run and not in the build.
  # Open question this answers: does the upload step inside the composite action (if: always())
  # still run when the composite step itself is cut? The last step lists the folder either way.
  cancelled:
    if: inputs.plan_hash != ''
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Check out tiny-tracker
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: isokron-ai/mcp-write-safety
          ref: b9265fe3d768a40f316837cf31528e856ff809d8 # examples/tiny-tracker-resync
          token: ${{ secrets.MWS_CLI_TOKEN }}
          path: tt
          sparse-checkout: examples/tiny-tracker
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - name: Build tiny-tracker
        working-directory: tt/examples/tiny-tracker
        run: npm ci --ignore-scripts --no-audit --no-fund && npm run build
      - name: A backend token for this job only
        run: |
          t="$(openssl rand -hex 16)"
          echo "::add-mask::$t"
          echo "TRACKER_BACKEND_TOKEN=$t" >> "$GITHUB_ENV"
      - name: Start tiny-tracker's backend (the test environment; in memory, gone with the job)
        working-directory: tt/examples/tiny-tracker
        run: |
          nohup node dist/src/cli.js backend --port 4610 > "$RUNNER_TEMP/backend.log" 2>&1 &
          for i in $(seq 1 50); do grep -q '"backend"' "$RUNNER_TEMP/backend.log" && break; sleep 0.1; done
          grep -q '"backend"' "$RUNNER_TEMP/backend.log"
      - name: Build the CLI at the pinned commit
        run: |
          git init -q "$RUNNER_TEMP/cli"
          # The token goes to git through GIT_CONFIG_* variables, as the action does: not in argv.
          HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
          echo "::add-mask::$HEADER"
          GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_COUNT=1 \
            GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" GIT_CONFIG_VALUE_0="$HEADER" \
            git -C "$RUNNER_TEMP/cli" fetch -q --depth 1 https://github.com/isokron-ai/mcp-write-safety.git 0295ed6494d99ce5467f0d6e94e91a5c436a18c2
          unset HEADER TOKEN
          git -C "$RUNNER_TEMP/cli" checkout -q --detach FETCH_HEAD
          cd "$RUNNER_TEMP/cli/packages/writecheck" && npm ci --ignore-scripts --no-audit --no-fund && npm run build
        env:
          TOKEN: ${{ secrets.MWS_CLI_TOKEN }}
      - id: run
        timeout-minutes: 1
        continue-on-error: true
        uses: ./.github/actions/mcp-writecheck
        with:
          manifest: writecheck.yaml
          mode: full
          fail-on: none
          confirm-target: tiny-tracker
          plan-hash: ${{ inputs.plan_hash }}
          artifact-name: full-cancelled
          cli-path: ${{ runner.temp }}/cli/packages/writecheck
      - name: What the cut run left
        if: always()
        env:
          OUTCOME: ${{ steps.run.outcome }}
        run: |
          echo "outcome: $OUTCOME"
          find mwsc-results -maxdepth 3 | sort
```

The checkout of tiny-tracker and the step that builds the CLI in the `cancelled` job are the only places the workflow itself uses the token; the action uses it for its own fetch.

## What the run must show

Round 2, with the hash read from round 1. Each item closes one entry of "What has not been tested" in `TESTING.md`.

| Check | Where to look | Expected |
|---|---|---|
| The runner accepts `action.yml` and runs its three steps | every job | No "invalid action" error; the three steps appear in the log |
| The CLI is fetched over HTTPS with `cli-token` | log of any job, step "Run mcp-writecheck" | `Fetching mcp-writecheck at 0295ed6… from https://github.com/isokron-ai/mcp-write-safety.git`, `npm ci`, the build, then the version line. The token appears nowhere in the log (search for its first characters). |
| Without `cli-token` the fetch fails with a clear reason | optional: re-run `plan` with the input removed | The job fails; the summary says "fetching the CLI at … (if the repository is private, the cli-token input must be able to read it)" |
| The job-status rule | `full` matrix, `Check` steps | All four cases as in the matrix: `correct-must` 0/0, `force-by-default-must` 1/1, `force-by-default-none` 0/1, `wrong-hash-none` 1/3 |
| Composite outputs survive a failing last step | the `Check` steps after a failed `run` step | `exit-status` and `cli-exit-code` are set although the step's outcome is `failure` |
| `catalog` mode | `catalog` job | correct build 0; `missing-annotations` 1 with CLI exit 0 |
| Environment variables reach the composite action and the server | `full` and `catalog` | `TRACKER_DEFECTS` set on the step changes the verdicts; `TRACKER_BACKEND_URL` and the token set on the job reach tiny-tracker (it starts) |
| The plan hash is the same in the plan job and the full jobs | `plan` summary against the `full` summaries' "Plan hash" row | Equal |
| The rendered job summary | each job's summary page | Tables render; `<details>` folds open; `<br>` separates write paths; links point to `https://isokron.ai/mws#mws-…`; no raw Markdown escapes visible in a normal cell |
| Workflow commands | logs | `::error::` lines appear as annotations on the run; nothing the CLI prints between `::stop-commands::` and its end token is interpreted (the CLI's output appears as plain text inside the folded group) |
| The artifact upload, also after a failure | artifacts of the run | One artifact per step (`plan`, `catalog-correct`, `catalog-missing-annotations`, `full-<case>`, `full-cancelled`); a failed case still has its artifact |
| Cancellation | `cancelled` job | The action step ends as timed out; its log shows the CLI's "SIGTERM: stopping; cleaning up" line (if the runner sends SIGTERM rather than SIGKILL); the last step lists `mwsc-results/state/<run id>/`. Whether the artifact `full-cancelled` exists answers the open question in the job's comment; if it does not, the action needs its upload outside the composite, or the README must tell users to add one. Also record whether the CLI's clean-up finished: the runner's cancel sequence (SIGINT, then SIGTERM some seconds later, then a kill) can be shorter than the CLI's clean-up grace, and a second signal makes the CLI exit without cleaning up. Look for the CLI's clean-up lines and for an open ledger in `state/` |
| Node | log | The action's Node check passes on `ubuntu-latest` with `setup-node` 22 |

Then variant B: the same with `uses: isokron-ai/mcp-writecheck-action@<sha>`, which adds one check: the runner resolves a public action by SHA.

## What Joshua or the coordinator does

1. Create the fine-grained token above and add it to the test repository as `MWS_CLI_TOKEN`.
2. Create the private test repository with the layout above (variant A: copy `action.yml`, `contract.mjs` and `src/` from the root of this repository).
3. Check the organization's Actions policy allows the actions used (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, and for variant B `isokron-ai/mcp-writecheck-action`).
4. Start round 1 from the Actions tab. Read the plan in the `plan` job's summary. Start round 2 with the hash.
5. Download the artifacts, and keep the run's URL. Compare each row of the table above, and record the outcome in `TESTING.md` under a new heading "On a GitHub runner".
6. After the action's own repository exists: variant B.
7. Delete the test repository and revoke the token when done.

Agents in this lane do not do any of these steps.
