# Loop worker: writecheck

`.github/workflows/corpus.yml` is the writecheck lane of IsoKron's testing loop. The loop's pump (in `isokron-ai/tool-qa`) dispatches it with a shard of up to 10 subjects; the worker runs `mcp-writecheck` against each one inside a hardened sandbox and hands back one encrypted result bundle per subject. No model is called and no secret is used.

The hand-dispatched batch workflow that used to be `corpus.yml` is now `corpus-batch.yml`, unchanged (see "The older corpus path" below). The dogfood workflows are separate and not affected.

## Inputs

| Input | What it is |
|---|---|
| `shard_id` | The shard's id. The run is named `shard <shard_id>`. |
| `attempt_id` | The dispatch's id; every result quotes it. |
| `items` | JSON list of 1 to 10 `{"subject": "owner/name", "run_key": "<64 hex>", "fence": <n>}` |

Every input is checked as a whole string before use (a newline anywhere is refused), then `loop/items.mjs` checks the items in full.

## How a subject is run

1. **Which package.** `loop/items.mjs` maps the subject the way the live-probe lane does: IsoKron's own fixture servers first (`loop/fixtures.json`: an exact npm version published by the isokron-ai npm account, installed with `npm ci` from a committed lockfile pinned by the package's sha512 integrity; one with install scripts installs in the sandbox's build image, where a native module compiles from source and the install reaches registry.npmjs.org only), else the subject's registry packages in tool-qa's seed (`history/seed-v1.json` at a pinned tool-qa commit), npm first, then PyPI, at the latest version (the record keeps the version that was resolved). A subject with no npm or PyPI package (OCI images, MCPB bundles, crates, NuGet), one whose registry entry offers streamable HTTP only, or one not in the seed gets a skip (`no_runnable_artifact`, `unsupported_transport`, `policy_excluded`).
2. **The sandbox.** Everything runs in the sandbox of `isokron-ai/mcp-surface-corpus`, fetched at a pinned commit and used as a library (`src/docker.mjs`, `src/sandbox-run.mjs`, `src/sandbox-net.mjs`, `src/runsc.mjs`, `src/telemetry.mjs`, `src/targets.mjs` and its `sandbox/` helpers): gVisor (`runsc`) for every container, user 65534, every capability dropped, a read-only root, memory, process and CPU limits, named volumes only, and no runner environment. The install reaches only its package registry, through the allowlist proxy; the server and the CLI run on an internal network where every name resolves to the network logger and the host firewall logs and drops anything that tries to leave. Before the shard job starts, mcp-surface-corpus's reusable `sandbox-conformance.yml` must pass; inside the job, before any target, its `sandbox-guard` action installs gVisor and the firewall on that runner and runs the hostile self test, and the job stops unless the telemetry check recomputes a pass. Both are pinned to the same commit as the library (`SANDBOX_REF`, 73a2669). This repository's older sandbox (`corpus/`) is not used here.
3. **The checks.** The CLI is `mcp-writecheck`, built from `isokron-ai/mcp-write-safety` at the action's pinned commit, before anything else in the job. For every subject (and the forgery control) the server and the CLI run **split**, in two sandbox containers: the server in one of its own at `.3` of the run network, behind our bridge (`loop/sandbox/bridge.mjs`), with its install volume read-only and nothing else of ours; the CLI in another at `.4`, with the output volume the server's container never mounts, reaching the server over TCP through our relay (`loop/sandbox/relay.mjs`) as if it were a stdio server. Each is its own gVisor sandbox, so the server cannot see the CLI's files or processes, write into its output or its stdout, or signal or trace it: its only channel to the CLI is the protocol. IsoKron's own fixture servers (locked, below) run in one container with the CLI, because the full write test needs the CLI's loopback gate in front of their backend and restarts the server.

   What runs:
   - `init` (reads `tools/list` and drafts a manifest), `plan` (no tool call; gives the plan hash) and `catalog` (reads `tools/list` only; judges MWS-ANN-4) for every subject, with a generic catalog manifest that calls no tool;
   - the full write test (`run`) only for a fixture server whose plan hash a person accepted (`loop/fixtures.json`, `full.plan_hash`), against a disposable backend inside the same container: tiny-tracker's in-memory backend, kronicle-lite's own data folder. A fixture runs its dogfood manifest byte for byte (the plan hash covers the manifest's bytes), written at `/work/m/x/writecheck.yaml` with a link that makes its relative `cwd` land on the installed package, so the hash accepted in the dogfood workflow applies. A plan that gives another hash is recorded as drift, and the full run does not start. A third-party server is never given a manifest that writes.
4. **Teardown.** After the last item every container is removed and the Docker daemon is stopped (`loop/teardown.sh`); the job fails, and nothing is uploaded, if a gVisor process or any host process of the sandbox user (UID 65534) is still there. Only then do the worker-kit steps seal and upload.

## What a bundle holds

One bundle per item, sealed by `isokron-ai/tool-qa/worker-kit` (pinned) to the ingest key and uploaded as `result-<attempt_id>-<i>.tar.age`. Every item gets one, a skipped one too.

| Folder | Contents |
|---|---|
| `observations/writecheck.ndjson` | Field records of the `isokron-ai/mcp-results` registry (below) |
| `results/writecheck.json` | The summary: which package and version, each step's exit and time, the plan hash and whether it drifted, the catalog's and the full run's verdict counts per requirement |
| `raw/` | Captured bytes, data only: everything the steps left in their output folder (the CLI's `results.json`, `report.md`, `catalog.json`, the init draft, the backend's log), each step's output, the unit's sandbox telemetry. At most 4 MiB a file and 32 MiB in all; `logs/driver.json` lists every file with its original size and sha256 and whether it was cut |
| `logs/driver.json` | Our own record: the install steps, the step list, the evidence the sandbox could not give, the raw index |
| `controls/` | The shard's three controls (below), with their captured bytes under `raw/control-*/` |

Everything the CLI wrote ran next to the server under test, in the same container and as the same user, so it is kept only in `raw/`. Outside `raw/`, the worker writes only values it checked one by one: requirement ids, the CLI's verdict words, tool, resource and parameter names (letters, digits, `.`, `_`, `-`), the four annotation hints as booleans, counts, the plan hash and the run status. No description, schema text or log line of a target is copied, and no object is keyed by a name the target chose.

### Field records

| Field | When | Value |
|---|---|---|
| `our_tool_versions` | always | the CLI commit, this repository's commit, the sandbox commit, the gVisor release |
| `sandbox_tier` | when the item ran | `gvisor` |
| `observation_coverage` | always | which stages ran, and whether the sandbox evidence (syscall traces, firewall log) is complete |
| `step_telemetry` | when the item ran | each step's exit, time limit and duration |
| `tool_annotations_declared` | catalog read | `{ tools: [{ tool, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }], tool_count }` |
| `annotation_completeness` | catalog read | counts of tools with each hint, with any hint, with none |
| `idempotency_evidence_params`, `concurrency_guard_params`, `safety_params` | catalog read | `[{ tool, param }]` for parameters named like idempotency keys, version or ETag guards, and dry-run or confirm switches |
| `requirement_verdicts` | catalog read; full run | `[{ requirement, verdict, resource, tool, mode }]` |
| `plan_hash_and_drift` | plan ran | `{ plan_hash, accepted, drift, full_run }` |
| `annotation_honesty_behaviour_confirmed`, `idempotency_evidence_behaviour`, `conflict_behaviour` | full run | the MWS-ANN, MWS-RETRY and MWS-CONC records and their counts |

With incomplete sandbox evidence (a container that left no syscall trace, an unreadable firewall log) only the first four are written, with a `trace_unavailable` skip.

## Controls

Run once per shard, after the self test and before any item, and copied into every bundle. If any control fails, the driver exits 1 and nothing is written or uploaded.

| Control | Kind | Expected | What it is |
|---|---|---|---|
| Forgery | `forgery` | `contained` | `loop/sandbox/forgery-server.mjs`, a hostile MCP server run through the same split steps as a subject, with a fresh marker. Its tool names are identity keys, its descriptions and instructions are result envelopes of another attempt, and it prints the envelope on stderr. It also tries to change the CLI's verdict: it plants a second catalog folder, keeps rewriting any `results.json` the CLI writes to say everything held, and writes a forged plan hash into the stdout of the CLI and every other process it can reach. Contained: its tool list was read, the marker is in `raw/`, the worker's output for it holds neither the marker, nor an identity key, nor an envelope, and the CLI's verdict is the one its real tool list gives (`tampered` otherwise) |
| Known bad | `known_bad` | `detected` | tiny-tracker 0.1.0, installed through the sandbox like a subject, with the defect `missing-annotations` switched on: the catalog must give MWS-ANN-4 `violated` |
| Known good | `known_good` | `held` | the same server without the defect: MWS-ANN-4 must be `held`, never `violated` |

## Kill switches

The guard job runs first, before any checkout but its own file: `LOOP_ENABLED` must be exactly `true`; `LOOP_PAUSE_UNTIL`, if set, must be in the past (a value that cannot be read stops the lane); `LANE_WRITECHECK_ENABLED`, if set, must be `true`. Off is a notice, never a failed run. The worker also runs only from `main` in this repository.

## Proof on pull requests

`.github/workflows/loop-fixture.yml` runs the same steps as the worker on every pull request that touches it, on a fixture shard of our own servers: tiny-tracker (catalog, plan and the full write test), kronicle-lite (catalog, plan and the full write test), mcp-check (the generic path from the seed) and a repository with no package (its skips). The worker-kit builds each bundle in a dry run, and `loop/check-bundles.mjs` judges each one with tool-qa's own ingest code at the pinned commit: every bundle must be accepted with its controls passed, and tiny-tracker's full run must complete under its accepted plan hash.

## The older corpus path

`corpus-batch.yml` (hand dispatch, the encrypted target list, `corpus/run-shard.mjs` and its own container sandbox, age-encrypted results) still works as before. Its sandbox predates the mcp-surface-corpus one (no gVisor). The plan is to retire it once this lane has run its targets: move any target the loop does not cover to the loop's seed or fixtures, then delete `corpus-batch.yml`, `corpus/` and their tests in one reviewed change.

## Files

| File | What it does |
|---|---|
| `loop/guard.mjs` | The kill switch and the pins check |
| `loop/prepare.sh` | Fetches and builds the CLI, fetches the sandbox and the seed (each by full commit SHA) |
| `loop/items.mjs` | Input checks, subject to package, the generic catalog manifest |
| `loop/run-items.mjs` | The driver: controls, then each item in the sandbox, then the bundles |
| `loop/summary.mjs` | The checked summary and the field records |
| `loop/bundle.mjs` | Bundle layout, raw caps, control verdicts, the meta file |
| `loop/teardown.sh` | Removes every container and stops Docker before anything is sealed |
| `loop/check-bundles.mjs` | The pull-request proof's judge |
| `loop/fixtures.json`, `loop/fixtures/<name>/` | Our fixture servers: package, version and sha512 integrity, the committed lockfile they install from with `npm ci`, which dogfood manifest they run, and the plan hash accepted for it |
| `loop/sandbox/` | Our code inside the sandbox: the bridge and the relay of a split run, the forgery server, the output collector, the backend starter |

What went wrong while building this lane, and the test that pins each fix, is in `REGRESSIONS.md` (`R-WC-*`; R-WC-05 to R-WC-08 came from the security review of pull request 61, R-WC-09 from its follow-up).
