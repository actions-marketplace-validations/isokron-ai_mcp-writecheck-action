# Write-safety cells against more backends (WC12)

Design note for upgrade 12 of the IsoKron loop: run the MWS write-safety cells against PostgreSQL (WC12) and Redis (WC13, the section near the end), not only against tiny-tracker's in-memory store and kronicle-lite's SQLite folder. Every result of such a run is labelled `hermetic`.

## What runs where

| Backend | Fixture server | Status |
|---|---|---|
| in-memory HTTP store | tiny-tracker (`@mcp-write-safety/tiny-tracker`, npm) | live in the lane since the lane started |
| SQLite data folder | kronicle-lite (npm) | live in the lane |
| PostgreSQL 18.7 | `pg-tracker` (`loop/fixtures/pg-tracker/`, committed here) | this change |
| Redis 8.2.11 | `redis-tracker` (`loop/fixtures/redis-tracker/`, committed here) | WC13, plan proposed and not yet accepted; see "Redis (WC13)" |

The unchanged rule holds: only these fixture servers, each with a plan hash a person accepted, get the full write test. A third-party server gets `init`, `plan` and `catalog` and never a manifest that writes.

## How the disposable backend runs

The backend is a real PostgreSQL server (the `postgres` and `initdb` binaries of the `embedded-postgres` npm package, version 18.7.0-beta.19; the package's JavaScript is not loaded) started by the fixture's own `backend` command inside the same gVisor sandbox container as the CLI and the server, exactly as tiny-tracker's backend is: `loop/sandbox/bg.mjs` starts it before the CLI's `run` and stops it after. It is **not** a GitHub `services:` container. Untrusted server code can only talk to what is inside the sandbox, and a runner service is reachable from the runner. A test asserts that no workflow of this repository has a `services:` block (`test/pg-fixture.test.mjs`, R-WC-16).

- Sandbox: gVisor, user 65534, every capability dropped, read-only root, 2 GiB memory limit, 2048 pids, a 512 MiB `/tmp`. The data directory is under `/tmp` and is gone with the container. PostgreSQL runs unprivileged as it is; checked on a hardened container with the same flags (linux/amd64): `initdb` and start take about one second.
- Network: `listen_addresses=127.0.0.1`, no Unix socket (`unix_socket_directories=`), port 4620; the control channel (below) is on 127.0.0.1:4621. The run network has no way out, and nothing in it can reach the container's loopback.
- Credentials: the database password is random per run (`random_env: PGFX_PASSWORD`), written to `initdb` through a mode 0600 file that is removed at once, `scram-sha-256`. It is also the bearer token of the control channel. It never appears in `fixtures.json` or in the manifest; the manifest lists it under `env_passthrough`, so the CLI keeps it out of its records and the credential scan (MWS-SEC-1) looks for it.
- Install: the fixture's folder is the package. `npm ci` in the sandbox's build image from the committed lockfile (every package from registry.npmjs.org with a sha512), with install scripts on, because the platform package links the PostgreSQL libraries in its install script. The install reaches registry.npmjs.org only (the same R-WC-09 path as kronicle-lite; the PR proof checks the egress).
- Binaries: `backend.mjs` pins the sha256 of the `postgres` and `initdb` executables for linux-x64 (the sandbox and CI), linux-arm64 and darwin-arm64 (local runs) from `@embedded-postgres/<platform>@18.7.0-beta.19` and checks them before every start, resolving only from the fixture's own `node_modules`. Install scripts are allowed only for `@embedded-postgres/*` platform packages (`INSTALL_SCRIPT_ALLOW`; the lock lists darwin and windows ones too, optional and skipped on Linux by their `os`). The package's JavaScript is never loaded: no source file names it, `guard.mjs` refuses any import of it at runtime, and the backend stops unless the server measures as the pinned 18.7.
- Pinning: `loop/fixtures.json` pins the folder by a digest over `package.json`, `package-lock.json` and every file of `src/` (`source.sha256`, `sourceDigest` in `loop/items.mjs`); a changed byte of the server is refused at load until a reviewed commit moves both. Every dependency is an exact version.
- Start-up cost is paid for the full write test only: `background.only: ["run"]` starts the database for the CLI's `run` and not for `plan` or `catalog`, which call no tool.

The control channel is the CLI's `control` arm at the pinned CLI: out-of-band reads and writes straight to the same PostgreSQL tables (a platform-side API over SQL, served by the backend process), never through the MCP server. A database trigger moves `version` on every row change whoever makes it, so an out-of-band write makes a later stale write real.

## Which cells run against PostgreSQL

The pinned CLI (`CLI_DEFAULT_REF`, 3af41c6) speaks HTTP to a backend and has no wire gate. The wire gate, the cells pass (`docs/CELLS.md`) and the database control arm are in later commits of `mcp-write-safety`. At the pin, `pg-tracker` runs the cells that need only the MCP surface, the control channel and the read-back. The correct build gives, in the loop's full run (144 records):

- **held** (45 records, 20 requirements): MWS-ANN-4, CONC-1, CONC-2 (update, delete), CONC-4, IN-1, IN-2, IN-3, IN-4, IN-6, IN-7, RES-1, RES-2, RES-3, RES-4, RETRY-1, RETRY-2 (sequential, simultaneous pairs, restart with the key kept in PostgreSQL), TGT-1, TGT-2, TGT-3, UPD-1;
- **self-attested** (review clauses answered by rules in the manifest): CONC-4, CONC-5, CONC-6, IN-4;
- **not observed** (a search cannot show absence): ANN-1, ANN-2, ANN-3, ANN-5, CONC-3 (pairs), SEC-1, RETRY-2 (pairs);
- **not tested, with the reason in the record**: CONC-3 held-request, RETRY-2 proxy and crash steps (they need `backend.gate`, which at the pin is HTTP only: a database wire gate for PostgreSQL, Redis and MongoDB is in `mcp-write-safety` after the pin, `docs/WIRE-GATE.md`), ATOM-1/2 and UPD-2 (pg-tracker has no multi-item or list-edit tool yet), RETRY-3 (no input_required tool), CFG-1 to CFG-4 (no read-only mode or tool filters), IN-5 (the search is not built in this preview), and the per-tool probes of create_project, delete_project, create_item, delete_item and delete_items under RES-1/2 and IN-* (not built at the pin).

About 85% of the scenarios suggested for upgrade 12 are cells that MWS's own cell matrix already has; the ones that stay out at the pin are exactly the wire-gate ones. Moving `CLI_DEFAULT_REF` to a commit with the wire gate re-opens them for PostgreSQL (and, with the Redis fixture, for Redis). That changes the plan hashes of all three fixtures, so a person accepts three new plans; it is a separate change.

Known-bad builds (`PGFX_DEFECTS`, one name each or `all`), each caught by the cells named, with the correct build holding every cell above (R-WC-17):

| Defect | What it does | Caught as |
|---|---|---|
| `lost-update` | UPDATE and DELETE leave out `AND version = $n` | MWS-CONC-2 violated on `delete_item` (update_item's same-field test is not built at the pin) |
| `empty-filter-deletes-all` | `delete_items` with no prefix deletes every item of the project | MWS-TGT-2 violated on `delete_items` |
| `idempotency-key-dropped` | the key is accepted and not kept | MWS-RETRY-2 violated on `create_item` |
| `missing-annotations` | no tool carries annotations | MWS-ANN-4 violated on every tool (catalog mode, no database) |

## The `hermetic` label

A write test's backend is hermetic when it starts with the sandbox container and ends with it, listens on loopback only, holds no data that did not come from the run, and can be reached by nothing but the server and the CLI in that container. The three fixtures qualify and carry `backend: { kind, environment: "hermetic", version }` in `loop/fixtures.json`; the loader refuses a fixture without it, or with any other environment.

The mcp-results registry (`fields/registry.yaml`) has no field for this yet, and tool-qa's ingest refuses an undeclared field. So the label uses fields the registry has:

- `observation_coverage` gets `backend_environment` (`hermetic`, or `none` when the item made no write test) and `backend_kind` (`postgresql`, `in_memory_http`, `sqlite_files`, or `none`);
- every `requirement_verdicts` entry of the full run, and the `annotation_honesty_behaviour_confirmed`, `idempotency_evidence_behaviour` and `conflict_behaviour` objects, carry `backend_environment: "hermetic"`;
- `backend_version` (a registered field) carries the engine's version string for a full run. It is the pinned label, not a reading of the target: the backend refuses to run unless the server it started reports that version, so a run that happened has that version.

The value comes from `loop/fixtures.json`, never from the target's output (R-WC-15 pins that a results file that says otherwise changes nothing). A registered field `write_test_environment` (enum `hermetic` | `none`) in mcp-results, and tool-qa's pinned registry commit moved with it, would make this a first-class field; that is a change in two other repositories and is left for phase 2.

## Cost per item (R-WC-13 timing)

The lane's budget: 20 minutes for the shard's items (no item starts after it), the last item may run 5 minutes past it, job timeout 50, pump lease 58. The PostgreSQL item adds, per item, on a GitHub runner: the install in the build image (about 17 packages, one 60 MB binary package; kronicle-lite's install with a native build takes 52 s on the same runner, so budget 30 to 60 s), `init`, `plan` and `catalog` as for any fixture (about 4 s each, no database), and the full write test with one database start (initdb and start about 1 s native, a few seconds under gVisor) and up to 650 writes (9 s native). Measured on the pull-request proof run (GitHub runner, gVisor, 25 Nov 2026): the whole item, from install to the collected output, took 19 s (install 2.7 s, then init, plan, catalog and the full write test with its single database start); tiny-tracker took 51 s and kronicle-lite 72 s in the same shard, so the PostgreSQL item is the cheapest full run of the three and adds nothing the 20-minute budget has to find room for. No item of this change can lengthen the shard beyond what R-WC-13 allows: a shard of ten items runs the same items one after the other, and an item that would start after the budget is skipped as `timeout_start`.

Plan acceptance: the owner accepted plan hash 36b151549223fe4e on 25 Nov 2026 ("Accept the plan"), after reading a summary of `dogfood/pg-tracker/plan.txt`; the hash in `fixtures.json` is that one, and a review change that moved it would need a new acceptance. The repository has no other record format for acceptances (the hashes of the other fixtures are recorded the same way, as the value in `fixtures.json`).

The fixture is not in the pump's seed. Its subject is this repository (`isokron-ai/mcp-writecheck-action`), which tool-qa's seed does not list, so the live lane never dispatches it. And a source fixture is selected only by an explicit `"fixture": "pg-tracker"` in the item (R-WC-18): if this repository were seeded as an ordinary subject, it would get the generic path (init, plan, catalog), never the full write test. The pump sends no `fixture`, so adding it to the lane is a decision about the pump's items as well as the seed.

What does change in the live lane's output once this is merged: every item's `observation_coverage` record (written for every item the lane runs) gains two keys, `backend_environment` and `backend_kind`, which are `none` for everything that is not a full write test (every third-party item, and the catalog-only runs); tiny-tracker's and kronicle-lite's full runs gain `hermetic` and `backend_version` and the label on their full-run verdict records. An item skipped before it ran writes the old `observation_coverage` unchanged. tool-qa's pinned ingest accepts the new keys: the field is registered as an object and ingest checks its type only, not its keys (`checkValueType` in `ingest/registry.mjs`), and the pull-request proof's judge (`loop/check-bundles.mjs`, tool-qa's own `analyzeBundle`) accepted bundles with the keys for all five items.

## Redis (WC13)

`redis-tracker` has the shape of pg-tracker: the same nine tools, the same manifest (`dogfood/redis-tracker/writecheck.yaml`), the same control arm, a real Redis server started by `bg.mjs` inside the fixture's own gVisor container for the CLI's `run` only. Label: `backend_kind: redis`, `backend_environment: hermetic`, `backend_version: Redis 8.2.11 (official redis image bookworm)`.

### Where the redis-server binary comes from (decision, with the evidence)

Order of preference was (a) a source build or pinned binary through the existing build image, with the sandbox repository unchanged; (b) a pinned OCI image as a second container, which needs an `images.json` entry in mcp-surface-corpus. Neither is needed as stated; the choice is a variant that keeps mcp-surface-corpus unchanged and still pins the binary by digest:

- (a) as asked is not possible. The install network's only way out is the allowlist proxy to `registry.npmjs.org` for an npm install (`PROXY_ALLOWED` in mcp-surface-corpus `src/selftest.mjs`; `registries` per kind in `src/targets.mjs`: npm gets registry.npmjs.org, PyPI gets pypi.org and files.pythonhosted.org). A Redis release tarball lives on download.redis.io and GitHub, neither reachable, and widening the list is a sandbox change.
- npm has no usable carrier (checked 25 Nov 2026): `redis-server` 1.2.2 (2022) and `redis-prebuilt` 1.0.54 (2022) are old wrappers; `redis-memory-server` 0.17.2 is maintained but its postinstall downloads and builds the Redis source from download.redis.io (`RedisBinaryDownloadUrl.js`), which the install network refuses; `@redis/*` and `ioredis` are clients; `js-valkey-server` is a JavaScript re-implementation, not Redis. Publishing our own npm package of the source would be a publish, which is the owner's call.
- (b) as stated would add an image to `images.json`, change the sandbox and its conformance pin, and put Redis in a container the server shares only a network with, so it could not be on 127.0.0.1 of the server's container, and the `hermetic` definition (reachable by nothing but the server and the CLI in that one container) would be weaker.
- Chosen: the official image is only a **file source**. `loop/fixtures.json` pins `docker.io/library/redis:8.2.11-bookworm@sha256:bb302517...` (the digest of the multi-platform index) in `binary_image`, with, per platform (linux/amd64 for the runner, linux/arm64 for local runs), the path and sha256 of the three files the server needs: `redis-server` and the two OpenSSL libraries it links (the slim Node image has none). The driver (`loop/binary-image.mjs`) pulls the image as it pulls the sandbox's own images, runs `docker create` (no network, never started) and `docker cp`, checks each file against its sha256, packs them into a volume of their own and mounts it read-only at `/opt/redis` in the fixture's sandbox container. The backend checks the same sha256 values again from the mounted volume before every start and refuses a server that does not measure as 8.2.11. No code of the image runs outside the sandbox, and only the copied `redis-server` runs at all, under the container's limits (user 65534, read-only root, every capability dropped). mcp-surface-corpus, its `images.json` and tool-qa's `sandbox_sha` are untouched. Checked on a hardened container with the same flags (linux/amd64 and linux/arm64): the binary starts in about 0.1 s.
- Redis 8.2 is AGPLv3-or-RSAL-or-SSPL licensed; the fixture only runs it in a throwaway container and does not redistribute it.

The copied set is complete: a test (R-WC-20) reads the ELF `NEEDED` entries of `redis-server` in process (no readelf) and requires each to be a pinned copied library (`libssl.so.3`, `libcrypto.so.3`) or one of `binary_image.system_libs` (`libc`, `libm`, `libstdc++`, `libgcc_s`, which the slim Node image has: it started under the same hardened flags on both platforms); the copied libraries are checked the same way. A mount may not be one of the container's own folders (`/opt/surface`, `bin`, `node`, `work`, `out`, `tools`, `yarn*`) or another fixture's.

### Subject identity

tool-qa keys history by subject, and a record carries the subject of its item. Two source fixtures on one repository name would have mixed their results (a PostgreSQL run and a Redis run as one history). So every source fixture has a subject of its own, `<repository>.<fixture id>`: `isokron-ai/mcp-writecheck-action.pg-tracker` and `isokron-ai/mcp-writecheck-action.redis-tracker`. It still matches the subject pattern ingest checks (the proof ingest accepts it), it is unique per fixture (a test asserts it), and a fixture is selected by its id together with its own subject only, so the repository's own name is the generic path and nothing else. This changes pg-tracker's subject from the repository name; it is not seeded or dispatched anywhere yet, and the plan hashes do not include the subject. The rule that two items of one shard may not share a subject is back to what it was.

### How the fixture is built

- No dependency. The Redis client is `src/resp.mjs` (RESP2 over TCP, a pool, one connection per transaction because WATCH belongs to a connection), so there is nothing to lock beyond the package itself and the folder is pinned by `source.sha256` as pg-tracker's is. Install scripts stay off, in the slim image.
- Data: one hash per item (`rfx:item:<id>`), sets of ids, a hash per project, a counter, a string per idempotency key. The version is a field of the item; every write moves it.
- Correct build: `update_item`/`delete_item` WATCH the item's key, read the version, compare it with `expected_version` and write in MULTI/EXEC, which Redis refuses if the key changed meanwhile (the control channel's out-of-band write included). An idempotency key is claimed with `SET key pending NX PX 30000`; the MULTI that writes the item replaces it with the result; a repeat reads it (`replayed: true`), another request with the same key waits for the result.
- Defects (`REDISFX_DEFECTS`, one name each or `all`), each caught by the cells named (R-WC-23):

| Defect | What it does | Caught as |
|---|---|---|
| `lost-update` | no WATCH, no version comparison: a plain write (the version still moves) | MWS-CONC-2 violated on `delete_item` |
| `empty-filter-deletes-all` | `delete_items` with no prefix deletes every item of the project | MWS-TGT-2 violated on `delete_items` |
| `idempotency-key-dropped` | the key is accepted and not kept (no `SET NX`) | MWS-RETRY-2 violated on `create_item` |
| `missing-annotations` | no tool carries annotations | MWS-ANN-4 violated on every tool (catalog mode, no Redis) |

- Sandbox: Redis listens on 127.0.0.1:4630 only (`bind`, `protected-mode yes`, no Unix socket), the control channel on 127.0.0.1:4631; `requirepass` is the random per-run `REDISFX_PASSWORD`, passed in a mode 0600 config file that is removed once the server is up; `save ""`, `appendonly no`, the data directory is under `/tmp` (the container's tmpfs, 512 MiB), `enable-debug-command`, `enable-module-command` and `enable-protected-configs` off, `maxmemory 256mb`. The server runs as 65534 in the read-only root.
- Cells: the same as PostgreSQL at the pinned CLI (the list above, with Redis for PostgreSQL); the wire-gate cells stay out for the same reason.

### Plan acceptance and the proof run

The plan is `dogfood/redis-tracker/plan.txt`, hash **5ee5a5b97a2363b8**, **proposed and not accepted**: `full.plan_hash` in `loop/fixtures.json` is `null`, so the live lane would run catalog and plan for the fixture but never its full write test; `full.proposed_plan_hash` holds the proposed hash only so that the pull-request proof can run it. The proof item says `"proof_plan": true`; `parseItems` refuses that key unless the environment is the pull-request proof (`isProofLane`: event `pull_request`, this repository, workflow `loop-fixture.yml`, none of which a dispatch can set), so the pump's worker `corpus.yml` rejects such an item whole. The driver then runs the full write test under the proposed hash, hands the summary **no** accepted hash (so the `plan_hash_and_drift` record says `accepted: null`, `drift: false`, not an acceptance), and the bundle's `logs/driver.json` says `plan_accepted: false`. When a person accepts the plan, a change moves the hash into `full.plan_hash` and removes the proposal.

### Cost per item (R-WC-13 timing)

Over pg-tracker's item the Redis one adds the image pull (about 60 MB compressed) and the copy of three files (`docker create`, three `docker cp`, a volume); it removes the 60 MB npm binary package (the fixture has no dependency, so `npm ci` fetches nothing). Redis starts in about 0.15 s; the full write test of the correct build is about 450 writes in about 6 s natively. Measured on the pull-request proof run (GitHub runner, gVisor, 25 Nov 2026): the whole redis-tracker item, from install to the collected output, took 26 s (install 1.2 s with no egress at all, then the image copy, init, plan, catalog and the full write test with its single Redis start), against 29 s for pg-tracker, 51 s for tiny-tracker and 72 s for kronicle-lite in the same shard; the native test job on the runner copies the three files out of the image in 3 s (pull included), starts Redis in 0.23 s and runs the full write test in 7.9 s (449 writes). So the item adds nothing the 20-minute shard budget of R-WC-13 has to find room for: it is one of the cheapest items, items still run one after the other, and an item that would start after the budget is skipped as `timeout_start`. R-WC-23 asserts a wide bound (Redis ready under 10 s, the write test under 2 minutes).

## Phase 2

1. (done, WC13: the Redis fixture above.)
2. Move `CLI_DEFAULT_REF` to a commit with the database wire gate, accept the new plans, add `backend.gate: { rewrite_env: PGFX_DATABASE_URL }` to the manifest so the held-request, lost-answer and restart-with-crash cells run against PostgreSQL (and, with the same change for `REDISFX_URL`, against Redis).
3. Register `write_test_environment` in mcp-results and move tool-qa's registry pin.
4. Add the subject to tool-qa's seed so the pump dispatches it (the owner's call).
