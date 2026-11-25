# Write-safety cells against more backends (WC12)

Design note for upgrade 12 of the IsoKron loop: run the MWS write-safety cells against PostgreSQL (this change) and Redis (next), not only against tiny-tracker's in-memory store and kronicle-lite's SQLite folder. Every result of such a run is labelled `hermetic`.

## What runs where

| Backend | Fixture server | Status |
|---|---|---|
| in-memory HTTP store | tiny-tracker (`@mcp-write-safety/tiny-tracker`, npm) | live in the lane since the lane started |
| SQLite data folder | kronicle-lite (npm) | live in the lane |
| PostgreSQL 18.7 | `pg-tracker` (`loop/fixtures/pg-tracker/`, committed here) | this change |
| Redis | `redis-tracker` | phase 2, see the end |

The unchanged rule holds: only these fixture servers, each with a plan hash a person accepted, get the full write test. A third-party server gets `init`, `plan` and `catalog` and never a manifest that writes.

## How the disposable backend runs

The backend is a real PostgreSQL server (the `postgres` and `initdb` binaries of the `embedded-postgres` npm package, version 18.7.0-beta.19; the package's JavaScript is not loaded) started by the fixture's own `backend` command inside the same gVisor sandbox container as the CLI and the server, exactly as tiny-tracker's backend is: `loop/sandbox/bg.mjs` starts it before the CLI's `run` and stops it after. It is **not** a GitHub `services:` container. Untrusted server code can only talk to what is inside the sandbox, and a runner service is reachable from the runner. A test asserts that no workflow of this repository has a `services:` block (`test/pg-fixture.test.mjs`, R-WC-16).

- Sandbox: gVisor, user 65534, every capability dropped, read-only root, 2 GiB memory limit, 2048 pids, a 512 MiB `/tmp`. The data directory is under `/tmp` and is gone with the container. PostgreSQL runs unprivileged as it is; checked on a hardened container with the same flags (linux/amd64): `initdb` and start take about one second.
- Network: `listen_addresses=127.0.0.1`, no Unix socket (`unix_socket_directories=`), port 4620; the control channel (below) is on 127.0.0.1:4621. The run network has no way out, and nothing in it can reach the container's loopback.
- Credentials: the database password is random per run (`random_env: PGFX_PASSWORD`), written to `initdb` through a mode 0600 file that is removed at once, `scram-sha-256`. It is also the bearer token of the control channel. It never appears in `fixtures.json` or in the manifest; the manifest lists it under `env_passthrough`, so the CLI keeps it out of its records and the credential scan (MWS-SEC-1) looks for it.
- Install: the fixture's folder is the package. `npm ci` in the sandbox's build image from the committed lockfile (every package from registry.npmjs.org with a sha512), with install scripts on, because the platform package links the PostgreSQL libraries in its install script. The install reaches registry.npmjs.org only (the same R-WC-09 path as kronicle-lite; the PR proof checks the egress).
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
- `backend_version` (a registered field) carries the engine's version string for a full run.

The value comes from `loop/fixtures.json`, never from the target's output (R-WC-15 pins that a results file that says otherwise changes nothing). A registered field `write_test_environment` (enum `hermetic` | `none`) in mcp-results, and tool-qa's pinned registry commit moved with it, would make this a first-class field; that is a change in two other repositories and is left for phase 2.

## Cost per item (R-WC-13 timing)

The lane's budget: 20 minutes for the shard's items (no item starts after it), the last item may run 5 minutes past it, job timeout 50, pump lease 58. The PostgreSQL item adds, per item, on a GitHub runner: the install in the build image (about 17 packages, one 60 MB binary package; kronicle-lite's install with a native build takes 52 s on the same runner, so budget 30 to 60 s), `init`, `plan` and `catalog` as for any fixture (about 4 s each, no database), and the full write test with one database start (initdb and start about 1 s native, a few seconds under gVisor) and up to 650 writes (9 s native). Measured on the pull-request proof run (GitHub runner, gVisor, 25 Nov 2026): the whole item, from install to the collected output, took 19 s (install 2.7 s, then init, plan, catalog and the full write test with its single database start); tiny-tracker took 51 s and kronicle-lite 72 s in the same shard, so the PostgreSQL item is the cheapest full run of the three and adds nothing the 20-minute budget has to find room for. No item of this change can lengthen the shard beyond what R-WC-13 allows: a shard of ten items runs the same items one after the other, and an item that would start after the budget is skipped as `timeout_start`.

The fixture is not in the pump's seed. Its subject here is this repository (`isokron-ai/mcp-writecheck-action`), which tool-qa's seed does not list, so the live lane never dispatches it until a person adds the subject to the seed in tool-qa: nothing in the live lane changes with this pull request.

## Phase 2

1. Redis: a `redis-tracker` fixture with the same shape (a real `redis-server`, started in the container by the same `bg.mjs` path, on 127.0.0.1, `requirepass` random per run, no persistence; correct and defect builds: SET without a version check, key-per-object with `WATCH`/`MULTI` for versions, an idempotency key kept with `SET NX`). The binary has to come from somewhere the sandbox can install with a pinned integrity: npm has no maintained package with a Redis server binary, so this needs a decision (a pinned OCI image run as a second sandbox container on the run network, which means an image digest in mcp-surface-corpus's `images.json`, or a source build in the build image).
2. Move `CLI_DEFAULT_REF` to a commit with the database wire gate, accept the new plans, add `backend.gate: { rewrite_env: PGFX_DATABASE_URL }` to the manifest so the held-request, lost-answer and restart-with-crash cells run against PostgreSQL.
3. Register `write_test_environment` in mcp-results and move tool-qa's registry pin.
4. Add the subject to tool-qa's seed so the pump dispatches it (the owner's call).
