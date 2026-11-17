# Corpus: batch runs against third-party MCP servers

`.github/workflows/corpus.yml` runs `mcp-writecheck`, dispatched by hand in batches of 3 to 5, against a pinned
list of open-source MCP servers that IsoKron did not write. Its purpose is to test this action and the CLI on servers
built by other people: crashes, time limits, harness errors and false positives are what it is
looking for. It is not a findings channel, and it publishes no verdicts.

## What is public and what is not

| Item | Where |
|---|---|
| The workflow, the driver (`run-shard.mjs`), the helper scripts and the container images (`images.json`) | This folder, in clear text |
| The target list (package, version, artifact sha256, lockfiles, licence, how to start the backend and the server) | `targets.json.age`, encrypted; decrypted at run time with the `CORPUS_TARGETS_KEY` secret |
| Results: `results.json`, `report.md`, the CLI's ledger, logs and run metadata | Encrypted to the archive key in `recipients.txt` before upload; the private key is held by IsoKron on its own machine, never in this repository or in CI |
| Logs and job summary | Only `automated candidate, unreviewed: not a finding` and one `run finished, exit N` line per target, in an order shuffled per run |

Job and artifact names are generic (`corpus-shard-N`). Nothing is cached between runs.

## How a target is isolated

Every target is treated as hostile. Nothing a target ships runs on the runner itself:

- Install, set-up, the CLI and the server run in containers of the digest-pinned image in
  `images.json`, as user `10001`, with `--cap-drop ALL`, `no-new-privileges`, a read-only root,
  a tmpfs `/tmp`, and pid, memory and CPU limits (`--cpus 2`, or fewer if Docker has fewer).
  The target's own `bin` folder comes last on `PATH`, so a package that ships a `node`, `npm`, `uv`
  or `sh` cannot replace the tools that run the CLI.
- Only Docker volumes are mounted: the target's own work volume, the CLI (read-only) and, for PyPI
  targets, `uv` (read-only). Never the workspace, `RUNNER_TEMP`, `_actions`, the home folder or the
  Docker socket. Files go in through stdin; results come out through a helper that copies regular
  files and folders only, under a size cap. Our helper containers carry the target's label and a
  time limit, so one stuck on something the target planted is removed with it.
- Command lines are redacted where they are logged, never where they run: in every logged `docker run`
  or `docker exec` line, the values of volatile captures, the values of `--env NAME=VALUE` whose NAME
  looks like a secret (TOKEN, SECRET, PASSWORD, PASSWD, PWD, KEY, CREDENTIAL, AUTH, COOKIE, SESSION, DSN,
  DATABASE_URL, CONNECTION_STRING, `*_URL`, `*_URI`; for a URL-like name given as a plain URL, only its
  `user:password@`) and the password of any `scheme://user:password@` URL become `<redacted:NAME>`.
  Docker gets the real values. `meta.env_names` keeps the server env's names.
- Output is bounded: each command's log keeps 64 MiB, captured output 16 MiB, and a `results.json`
  over 4 MiB is recorded by sha256 and size only (parsing tens of MiB of nested JSON costs about a
  gigabyte of heap). Of a `results.json` the driver keeps only
  `run.status` (a string of 64 characters at most) and `run.writes` (a finite number), and records at
  most 200 results folders per target. One target's output never stops the shard, and
  every target gets its `meta.json`.
- The install step has network egress (registries). Everything after it (set-up, the CLI, the
  server) runs on an `--internal` network that only that target's backends share. `net-guard.sh`
  keeps every container network away from the runner and the cloud metadata addresses; it stops
  the job if forwarded traffic does not pass through its rules. Docker Engine 26.0.0 or later is
  required (older engines let `--internal` networks resolve outside names, CVE-2024-29018).
- Backends are digest-pinned too, on the internal network only, with `no-new-privileges` and
  every capability dropped except an allowlist of five: `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`,
  `SETUID`. A backend gets those five by default (the official postgres, redis and mongo images start
  as root, take their data folder and drop to their own user, and exit at once without them); an
  entry can narrow it with `cap_add`. Anything outside the allowlist refuses the entry when the list
  is loaded. These are for backends only: every container that runs target code, including the CLI's
  container and so the server under test, keeps `--cap-drop ALL` with nothing added. No host port is
  published. A backend that does not become ready has its own output (`docker logs`, capped like every
  log) and its container state written to `backend-N.log` in the encrypted bundle before it is removed.
- The server under test's stderr is kept for the record. The CLI starts the server through
  `sandbox/stderr-tee.mjs` (ours, read-only in the CLI volume): stdin and stdout pass untouched,
  stderr goes to the CLI in full as before, and its first 4 MiB per server process (at most 16
  processes per target; `CORPUS_STDERR_CAP`) are written under `/work/out/server-stderr/`. That folder
  comes back with the rest of the target's output into the encrypted bundle
  (`sandbox/server-stderr/`, listed with sizes and sha256s in `meta.json`); nothing of it is printed.
  Init and the generic catalog manifest are wrapped; a hand-written full manifest is run as written,
  because its plan hash was accepted as written.
- With `full.repeats` above 1, our helper copies `/work` (as the sandbox user, no network, links and
  special files as entries, never followed) into a volume of its own after install, and restores it
  before each later repeat. That volume is mounted only by that helper; the driver refuses to mount it
  in any container that runs target code. The copy and the restore run under bash with `pipefail`, and
  their success is the helper's exit status: no status file is written anywhere a target could plant a
  forged one or block it with a fifo.
- Every output a step leaves in `/work/out` is moved, right after that step's container has exited (so
  no target process runs) and before any later step runs target code, into a second helper-only volume
  by another helper, which lists every file with its sha256: the config-source copy (before set-up),
  the init draft (after init), the catalog's `results/catalog-*` folders with their `catalog.json`
  (after catalog, before the first full run), and each full repeat's `results/full-<i>` and
  `state/full-<i>`. Later target code cannot change them, and the bundle is checked against the
  listings at copy-out (`meta.evidence[].tampered`, `full_runs[].results_tampered`). `plan` writes no
  file (its output is the step's log, written by the host), and `surface.json` is written by the host.
- Every volume the driver uses must be new: one that exists already (`docker volume inspect`) is
  refused, since `docker volume create` would hand it back. Our helpers are bounded like the sandboxes
  (`--memory 2g`, `--pids-limit 256`, the same CPUs) and each has a time limit.
- Three more of our helpers run inside the target's own sandbox container, never on the host, and
  only for the encrypted record: a version probe (`node -v`, `python3 -V`) and `sandbox/config-source.mjs`
  (reads the installed package and copies a selection into `/work/out/config-source/`), both after
  install with no network; and `sandbox/surface.mjs`, which starts the server like the CLI does, on
  the internal network, and sends `initialize` and `tools/list` only. Their output is written by the
  host into the target's folder; none of it is printed.
- Our in-container helpers (`sandbox/*.mjs`) come from the checked-out commit of this repository.
  `meta.json` records the sha256 of each (`sandbox_tools_sha256`); the hashes are recorded for the
  archive, not pinned or checked against a fixed value.
- With `CORPUS_INSTALL_CA_FILE` (a machine behind a TLS-inspecting proxy; never set on CI), the CA is
  written once at shard set-up into the CLI volume (`/opt/mwsc/_corpus-ca/install-ca.pem`), which
  every target container mounts read-only, and is given to install and set-up fetch only
  (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`). Target code cannot replace or remove it; its sha256 is
  recorded as `install_ca` in `meta.json`.
- Containers get a fixed environment: no GitHub file commands (`GITHUB_ENV`, `GITHUB_STEP_SUMMARY`
  and the rest), no `ACTIONS_*` or `RUNNER_*`, no token, and a `HOME` and caches inside the target's
  own volume.
- Dependencies are hash-locked: npm targets install with `npm ci` from a pinned `package-lock.json`
  (install scripts off unless the list says otherwise, and then only inside the container); PyPI
  targets with `uv pip install --require-hashes` from a lock compiled for the platform, wheels only
  unless the list says otherwise. Before installing, the driver checks the lock: npm packages only
  from `https://registry.npmjs.org/`, each with an integrity hash (the target itself only from its
  checked artifact); PyPI lines only `name==version` with sha256 hashes (no URL, VCS, file or index
  option). Anything else is a harness error.
- On IsoKron's Mac (lane `mac`, or the driver running on macOS), the install network reaches the
  Mac's own loopback and LAN through Docker Desktop, and no guard runs inside its VM. So targets
  with `install_scripts` or `allow_build` (target code during install) are refused there; they run
  on the CI runners only.

What stays on the runner: the decrypted list (deleted by the driver before the first target
runs), the secrets, the encrypt step and the upload.

## Target list format

The list is `isokron-corpus-targets/2`, encrypted (`targets.json.age`). The fields below were added
after the format was first written. All are optional and additive, so the format name stays `/2`: a
list without them reads as before, except that a backend without `cap_add` now gets the default five
capabilities instead of none.

| Field | Meaning |
|---|---|
| `full.manifest` templates | In a hand-written manifest the driver fills only its own names: `{{tdir}}`, `{{bin}}`, `{{pkgdir}}`, `{{host}}`, `{{hostN}}`, `{{portN}}` and the backends' set-up captures. The CLI's own names (`{{id}}`, `{{field}}`, `{{value}}`, `{{version}}`, ... as `RESERVED_VARS` in the CLI's `manifest.ts`) are never filled, even by a capture of the same name, and any other `{{...}}` is left as written for the CLI, which fails loudly on a name it does not know. A driver name the target does not set (`{{host1}}` with one backend) is a harness error. In commands, env and set-up every unknown name is still a harness error |
| `setup[]` as `{ "fetch": { "url", "sha256", "dest", "strip_components" } }` | A set-up step may be this object instead of a shell line, so an entry needs no git (the images have none, and set-up has no egress). `url`: https on `github.com`, `codeload.github.com`, `registry.npmjs.org` or `files.pythonhosted.org`, no credentials, port, query or fragment; a GitHub archive must name a 40-hex commit. `sha256`: required, 64 lower-case hex. `dest`: a folder under `/work` (default `src`; not `out`, `home`, `dl`, `pkg`, `venv`, `bin`, `python` or `.fetch`). `strip_components`: 0 to 5 (default 0). Our helper (`sandbox/fetch.mjs`, read-only in the CLI volume; user 10001, no capability, read-only root) fetches it on the install network while no target code runs, follows redirects only to the same hosts, caps it at 256 MiB (`CORPUS_FETCH_CAP`) and checks the sha256; the driver checks the helper's sha256 line against the pin too. Only then is it unpacked by `tar` in a sandbox container with no network. A mismatch or refusal is a harness error and nothing is unpacked. Shell lines and fetch steps run in the order listed; `meta.json` records each fetch (`setup_fetch`) |
| `backends[].snapshot` | Optional `{ "exec": [argv...], "user"? }`, run with `docker exec` in the backend like a set-up step (same templates). It prints the fixture's state as text, e.g. `psql ... -c "SELECT * FROM mwsc_items ORDER BY id"`. It runs before the first CLI step that writes (the first full run) and after the last; see `backend_state` below. Anything else refuses the target at load |
| `backends[].setup[].volatile` | Optional `true` on a set-up step with `capture`: its value is new on every backend start (a service that mints an access token). Its name may be used in `server.env` only; in `server.command` or `full.manifest` it refuses the target at load, so the manifest and its plan hash stay the same on every repeat. Between full repeats a changed volatile capture does not refuse the repeat: the new value replaces the old and the server env is filled again before the repeat's set-up and CLI steps; `full_runs[].volatile_refreshed` names it (never the value, which may be a secret), and its output is not copied into the backend's log. A non-volatile capture that changes still refuses the repeat |
| `full.repeats` | Optional, 1 to 5 (default 1). The full run is made that many times against fresh state; see `full_runs` below |
| `full.timeout_s` | Optional, seconds per full repeat (1 to 7200). Each repeat (its reset, re-plan, snapshots and run) then has that limit of its own, and the target's limit is `timeout_s + repeats x full.timeout_s`. Without it, the repeats share what is left of `timeout_s` |
| `timeout_s` | Optional, seconds for install to catalog (1 to 7200; default 600, or the list's `defaults.timeout_s`). On the CI lane the sum of a shard's target limits may not pass 330 minutes (the job stops at 360, GitHub's hosted maximum): a list that plans more is refused at load, naming the target that passes the budget, and nothing of the shard runs |
| `canary` | Optional, `"good"` or `"bad"`: a known-good or known-bad server. Nothing changes in how it runs; `meta.canary` records it |
| `dropped[]` (list level) | Retired targets: each entry has `id` and `dropped_at` (`YYYY-MM-DD` or an ISO time), and may have other fields (`reason`). An id is never reused: a target whose id is in `dropped[]` is refused at load, unless that entry has `reused_by_grandfathered: true`, which is accepted for `t08` only (reused on 16 Nov 2026, the day before the rule; `GRANDFATHERED_IDS` in the driver). Any other id with the flag, or a `dropped[]` without `id` and `dropped_at`, refuses the whole list |
| `bins[0]` | Read (not required) by the config-source copy: the bin whose entry point is copied. Without it, the server command's first word when it names a file in the bin folder |
| `backends[].cap_add` | Optional list, a subset of `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`, each at most once. Absent: those five. `[]`: none. Anything else (another capability, a `CAP_` prefix, lower case, a duplicate, not a list) refuses the target when the list is loaded, before anything of it is fetched or started |

Every entry is checked when the list is loaded. An entry that fails is recorded as a harness error
(`refused at load: ...`, exit 125) and nothing of it runs; the other targets run. A target id that is
not `[a-z0-9][a-z0-9-]{0,31}`, or that would name one of the driver's own Docker objects (`cli`, `tools`,
`uvsrc`, `shard`, or one ending in `-clean`, `-evidence`, `-egress`, `-run`, `-b<N>`, `-h<N>` or
`-<N>`), refuses the whole list.

## The run record (`meta.json`, `isokron-corpus-run/3`)

One `meta.json` per target, in the encrypted bundle. Format `/3` (17 Nov 2026) adds the fields
below to `/2`; every `/2` field keeps its name and meaning, except that a full run now writes to
`results/full-<i>/` and `state/full-<i>/` (see `full_runs`). A value the driver cannot determine is
`null` with a sibling `<field>_why` string; nothing is guessed. `shard.json` carries the same format
name.

| Field | Meaning |
|---|---|
| `surface` | The server surface, from `surface.json` (`{ initialize, tools, captured_at, ... }`, compact JSON: the server's `initialize` result and its `tools/list` result with every page's tools joined). `file`; `sha256_jcs`, the sha256 of the RFC 8785 canonical form of `{ initialize, tools }` (null when `tools/list` did not answer); `protocol_version`; `server_info` `{ name, version }`; `capabilities_keys`; `instructions_sha256`; `tool_count`; `tools[]` `{ name, description_sha256, input_schema_sha256_jcs, output_schema_sha256_jcs, annotations }` (the first 1000; `tools_omitted` counts the rest); `tools_pages`; `step` (exit, ms, time limit). The probe's output is untrusted (the server shares its container and user): every field is type-checked and bounded, a string over its limit (256 characters, 64 for versions) is null with a reason rather than cut, `annotations` keeps only `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` with values of their type (`annotations_dropped` counts the rest), and every null field has its `_why`. An answer that cannot be recorded (one nested too deep to serialise) gives `surface: null` with the reason; it never stops the target. The probe offers protocol revision `2025-11-25`, the CLI's own |
| `env` | `node_version`, `python_version` (as the server under test sees them, inside its container; kept only when version-shaped, `^v?\d[\w.+-]{0,62}$`); `docker_server_version`; `runner_image` (`ImageOS/ImageVersion`, null off GitHub's runners); `cli_commit`, `cli_version`; `spec_ref`, the spec text the CLI build says it follows (its `SPEC_TEXT`, e.g. `spec/0.9-review@15f71e5`): **key on this one**; `spec_sha256`, the sha256 of `spec/mws.md` at the CLI commit (the workflow checks it out beside the package; `--spec FILE` names another), which can be a later text than `spec_ref` names and is kept as a check only; `backends[]` `{ image_tag, image_digest }` from the list; `images[]` `{ role, image_tag, image_digest }` from `images.json` |
| `config_source` | `[{ path, sha256, bytes, rule, file }]`: from the installed package, the manifest (`package.json` or the dist-info `METADATA`), `README*`, `LICENSE*`, the entry point `bins[0]` resolves to (and a Python console script's module), then files under 256 KiB whose path in the package matches `config\|settings\|env\|options`; at most 40 files and 4 MiB, in that order. `path` is relative to `/work`; the copy is `sandbox/config-source/<path>`. `config_source_skipped` lists what did not fit or could not be read; `config_source_entry` names the bin. The package folder must be its own real path inside `/work`, and no file is read through a symlink anywhere on its path (each component is checked). The helper's listing is untrusted and type-checked. A file the server changed after the copy is marked `changed_after_copy` with `sha256_in_bundle` |
| `backend_state` | `[{ backend, before: { file, sha256, bytes }, after: {...} }]` for each backend with a `snapshot`: `backend-N-before.txt` (before the first full run) and `backend-N-after.txt` (after the last one that ran). With `full.repeats` > 1, `repeats[]` adds `backend-N-full-I-before.txt` / `-after.txt` around each repeat. Captures are capped (16 MiB, `truncated: true`) and never logged. Null with a reason when no CLI step that writes ran or the exec failed |
| `full_runs` | `[{ i, results_dir, cli_exit, writes, status, plan_hash, fresh_state, ... }]`, one per full repeat: `results_dir` is `sandbox/results/full-<i>`, `writes` and `run_status` come from its `results.json`, `status` classifies the CLI step like `status` does. Fresh state before each repeat after the first: `/work` is restored from a clean copy taken after install and before any set-up (kept by our helper in a volume of its own that no target container mounts; `/work/out` is left as it is), every backend is removed with its volumes, started again from its pinned image and seeded again by its `setup`, the list's own `setup` runs again, and the manifest is written again (`reset` says what was done). A seed capture whose value changes refuses that repeat, since the manifest was filled with the first value. `fresh_state` is true when all of that held, false with `fresh_state_why` otherwise (no clean copy could be made: the repeat still runs, on the state the last one left plus the reset backends and set-up). Each later repeat is planned again first and refused (`not_started`, `plan_drift_repeat`) unless its plan hash is the accepted one; no later repeat runs. Evidence: `results_sha256` is the combined hash of the listing our helper made when it moved the repeat's results and state out of `/work` (per file in `full-<i>-files.json`; null with a reason if the move failed); `results_tampered` says whether the bundle still matches it; `planted_after_move` marks a `results/full-<i>` or `state/full-<i>` that a later repeat recreated in `/work/out` (removed, the moved copy is kept). The CLI steps are `full`, `plan-2`, `full-2`, ... in `steps` |
| `timeout_s`, `time_limits` | `timeout_s` is now the whole target's limit; `time_limits` is `{ base_s, full_s, repeats, total_s }` |
| `canary` | As given in the list, or null |
| `env_names` | The names of the server env (`server.env` in the list), sorted; never the values |
| `install_retries` | Present only if an `npm ci` install failed (not by time limit) and was tried once more: `[{ step, first_exit, first_signal, first_ms }]` |
| `evidence` | `[{ step, paths, moved, files, file_count, sha256, moved_paths, tampered, planted_after_move? }]`, one per step whose output was moved before the full repeats (`config-source`, `init`, `catalog`): `sha256` is the combined hash of the listing made when it was moved (per file in `evidence-<step>-files.json`), `tampered` whether the bundle still matches it, `planted_after_move` that something was found again at a moved path (or, for the catalog, any `results/catalog-*` folder) in `/work/out` at the end: removed, the moved copy is kept. `moved: false` with `sha256_why` when the move failed (the output then comes back from `/work/out` as before) |

`surface.json`, `backend-N-*.txt` and `config-source/` are written only into the target's folder of
the bundle, which is encrypted before upload like the rest.

## What `exit N` means

`N` is the status of our tool or of the harness for one target, never a verdict:

| N | Meaning |
|---|---|
| 0 | The CLI ran to completion (whatever it found) |
| 2, 3, 4, 130 | The CLI's own usage or manifest error, refusal, stopped run, interruption |
| 70 | The CLI crashed |
| 124 | The target hit its time limit |
| 125 | Harness error: download, checksum, a missing lock, install, backend start, set-up, a container that did not start |

A shard fails only when some target's `N` is not 0. A server's verdicts never fail a job.

## Rules the corpus keeps

- Every backend runs inside the job (Docker on the runner). No target is pointed at an external
  service or account.
- Every target is pinned: the exact registry artifact by sha256, the dependency tree by lockfile
  hashes, images by digest. Each run records the server version and artifact sha256, the lock's
  sha256, the source commit where the registry carries one, the CLI commit, the spec version, the
  manifest hash, the image digests, the runner image and the date.
- Open-source licences that permit running the software, only.
- Standard GitHub-hosted runners and a few dozen targets at most; the long tail runs on IsoKron's own
  hardware with the same driver, the same containers and the same record format.
- Manual dispatch only, from `main`, in batches of 3 to 5 targets named in the `only` input (`t13,t09,t08`). There is no schedule (17 Nov 2026), so enabling the workflow starts nothing. An ID that is not in the list matches nothing: that shard runs nothing and still goes green, so check the IDs against the list before dispatching. No `pull_request` or `pull_request_target` trigger.
- Catalog and plan modes for every target. A full run happens only for a target whose hand-written
  manifest and plan hash a person has read and accepted, and only against its in-job backend.

## Secrets

| Secret | Where | Use |
|---|---|---|
| `CORPUS_TARGETS_KEY` | The `corpus` environment only (deployment branch `main`); never a repository secret, or the environment's branch rule does not protect it | The age identity that decrypts `targets.json.age`; used by one step |
| `MWS_CLI_TOKEN` | Not used | The CLI is checked out from the public `isokron-ai/mcp-write-safety` without a token. No step of the workflow reads `MWS_CLI_TOKEN`; the job stops before the checkout unless the repository variable `MWS_CLI_PUBLIC` is `true` |

## Running the driver locally

Needs Docker Engine 26.0.0 or later (Linux containers; Docker Desktop or colima on a Mac).

```sh
node corpus/run-shard.mjs --targets targets.json --cli <built mcp-writecheck package> \
  --out out --lane ci [--shard 1 --shards 4] [--only t01,t02] [--consume-targets] [--spec spec/mws.md]
```

Unit tests: `node --test test/corpus.test.mjs test/corpus-data.test.mjs test/corpus-jcs.test.mjs test/corpus-workflow.test.mjs`. The sandbox against a
real daemon: `CORPUS_DOCKER_TESTS=1 node --test test/corpus-container.test.mjs` (add
`CORPUS_SMOKE_CLI=<built mcp-writecheck package>` for the real CLI, `CORPUS_DOCKER_NET=1` for the PyPI
and set-up fetch tests, which need registry egress from containers, and `CORPUS_INSTALL_CA_FILE`
behind a TLS-inspecting proxy). The backend test pulls `redis:7-alpine` by digest;
`CORPUS_BACKEND_SMOKE_IMAGE` names another digest-pinned reference of the same image (a mirror).
