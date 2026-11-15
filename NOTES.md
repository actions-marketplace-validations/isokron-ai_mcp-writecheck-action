# Integrations: notes for review

Draft of 14 November 2026, re-targeted on 15 November 2026. Nothing here is pushed or published.

Written against `mcp-writecheck` at commit `0295ed6` (branch `cli/resync-516`, PR #6) and the spec at commit `e2bb9b0` (`spec/mws.md` on `spec/0.9-review`, MWS 0.9, 37 requirements: 26 MUST, 11 SHOULD). Tested with tiny-tracker at `b9265fe` (branch `examples/tiny-tracker-resync`, PR #7). The 14 November draft was written against CLI `e94270a` and spec `516c4ed`.

## What is here

| Path | What |
|---|---|
| `action.yml` | Composite action: obtain the CLI (the only step that gets `cli-token`), run the script, upload the results folder, set the job status. |
| `contract.mjs` | The one file that holds everything expected to change: the CLI's source and pinned commit, its commands, flags, exit statuses, output lines, file names and the results fields the action reads, the requirement registry, the spec URL and the anchor rule. |
| `src/` | `main.mjs` (inputs, running the CLI, outputs), `install.mjs` (fetch and build), `summary.mjs` (the job-status rule, the safety facts and the summary text; pure functions). No dependencies. |
| `test/` | Unit tests (25, in `contract.test.mjs`, `summary.test.mjs`, `install.test.mjs`); `local-test.sh`, the run against tiny-tracker; `bystander-fixture.mjs`, a test environment in which a run loses objects it did not create (from the CLI's own regression suite). |
| `examples/mcp-writecheck.yml` | Example workflow: `plan` and `catalog` on pull requests, `full` on main. |
| `README.md`, `TESTING.md`, `RUNNER-TEST.md` | Use; the local test and what is untested; the plan for the first run on a GitHub runner. |
| `skills/mcp-write-safe-builder/SKILL.md` | The 37 requirements as build rules, and how to add the check to CI. Unchanged since 14 November apart from two fact fixes in its CI section (review, below). |
| `skills/mcp-write-safe-caller/SKILL.md` | Rules for an agent that calls write tools. The 14 November draft plus the two P-7 lines (owner-approved, 15 November). |
| `LICENSE`, `NOTICE` | Apache-2.0 for `integrations/` (the licence text, and the notice: Stormhaven Enterprises LLC (IsoKron) and Joshua Bryan), and the CC BY 4.0 attribution of the spec the skills restate. |

## Decided since 14 November (owner, 15 November)

- **npm name:** `@mcp-write-safety/writecheck` (bin `mcp-writecheck`) and `@mcp-write-safety/tiny-tracker`. Not published; the npm organization is still to be created.
- **Where the action lives:** its own public repository, so that it can be listed on the Marketplace (`action.yml` at the root). The proposed name and layout are in the delivery's INDEX.md. Until it exists, this folder (committed first to an `integrations/action` branch of `mcp-write-safety`) is the source, and its README shows `uses:` for this location.
- **Licence of `integrations/`:** Apache-2.0, the action and the skills.
- **Visibility:** public.

## Design choices

### The action

Every rule of the 14 November draft is kept. Changes are marked.

1. **The default mode writes nothing.** `mode` defaults to `plan`. A workflow has to say `full` to make writes. *New:* a third mode, `catalog`, runs the CLI's new `catalog` command: verdicts from `tools/list` alone (MWS-ANN-4), no tool call, no write. It is never the default.
2. **No automatic confirmation.** The CLI has no `--yes`: a run needs the target string and the plan hash typed back. The action requires both as inputs in mode `full` and never feeds `run` a hash from a plan it has just built. A changed catalog, manifest or host therefore stops the full job until a person reads the new plan and updates the workflow. This is deliberate friction and it is the CLI's own design; an "auto" value for `plan-hash` would be a `--yes` under another name.
3. **The job status is decided by the action, from `results.json`.** The CLI exits 1 only for a violated MUST, so `fail-on: any` cannot come from the exit status. The rule is in `decide()` in `src/summary.mjs`:
   - *new:* a run that lost an object the tester did not create (any record with a non-empty `numbers.bystanders_lost`) fails the job whatever `fail-on` says, and so does setup the run left on the platform (`safety.setup_unresolved`, which the CLI's series A adds; read where present). Both hold whether or not the run completed, and both are given as reasons beside a violated record, not instead of it;
   - *new, not in the brief:* a clean-up that did not finish (`cleanup.failed` or `cleanup.unknown` non-empty, or `cleanup.stopped` set) fails the job whatever `fail-on` says. Reason: the local test killed tiny-tracker's backend 20 s into a run, and the CLI reported the run `complete` with exit status 0 (CLI problem 14); without this rule the job was green under every `fail-on`. With an open ledger the next run is refused anyway (exit 3), so the failure only comes one run earlier and says why. Objects left on purpose (`cleanup: leave`, `ephemeral`) do not fail the job;
   - a run that did not complete (CLI exit other than 0 or 1, no readable results, or `run.status` other than `complete`) fails the job whatever `fail-on` says;
   - otherwise only `violated` records count: none for `none`, those of a MUST for `must`, all for `any`;
   - under `must` and `any` the action is never more lenient than the CLI: exit status 1 fails the job even if the action found no such record.
   Leftovers alone, a changed canary and a fixture not restored are shown and annotated as warnings and do not fail the job by themselves.
4. **A requirement is a MUST if the spec or the CLI's record says so.** Kept as a guard. At `0295ed6` the CLI's registry equals Annex C (37 IDs, same levels, same order), so the rule changes nothing today; `test/contract.test.mjs` now asserts that there is no difference.
5. **The summary follows the tester rules of the spec** that apply to any report: one row per requirement and write path, no total, percentage, count of verdicts or grade (section 5.2); a verdict printed with its level (8.2, rule 12); `violated` records printed with their full reason and notes. *Changed:* a `violated` or `platform` record is now printed with its `attribution` (server, platform or unresolved), which the CLI writes as a field since the re-sync (8.2, rule 3). *New:* the safety facts come before the verdicts, in the order report.md uses: objects the tester did not create that were lost, setup not released, then "Needs attention" (leftovers, clean-up that failed or is unknown, canaries, fixtures). What the bystander inventory covered is in a fold.
6. **All 37 requirements get a row.** At `0295ed6` the CLI writes a record for every requirement (`not tested` with the reason where no check reached it), so "no record in this run" now appears only for a run that stopped.
7. **Text from the results is treated as untrusted.** Reasons, notes and bystander names can quote strings the server under test produced. They are escaped for Markdown, write paths and names are put in code spans that cannot be closed from inside, the plan is fenced with a fence longer than any run of backticks in it, and the CLI's console output is bracketed with `::stop-commands::` so that it cannot issue workflow commands.
8. **No input is interpolated into a shell command.** Inputs reach the script as environment variables. *Review:* the contract test now also scans `run: |` blocks.
9. **The state folder is inside the results folder**, so the ledger of an interrupted run is in the artifact and `mcp-writecheck cleanup` can use it. The upload step runs `always()`, also after a crash or a cancellation. (Now tested locally: a cancelled run leaves `state/<run id>/` in the results folder.) *Review:* it uploads the folder and name the script resolved (trimmed, defaulted), which the script writes as outputs before anything else, and falls back to the raw inputs when the script never ran.
10. **No sales text, no badge, no telemetry, no upsell on failure.** The action contacts the git host of the CLI, the npm registry (for the CLI's build dependencies, with audit, funding and the update check off) and the artifact service. Third-party actions are pinned by commit SHA.
11. **Node is required, not installed.** The action checks for Node 22 and says what to add.
12. **No baseline, no signing.** The CLI's `--baseline` and `--sign` are not exposed. CLI problem 8 still applies.
13. *New:* **The results folder is the one the CLI names.** The action reads the last `results: <folder>/report.md` line that `run` and `catalog` print (the last, so that text a server printed earlier cannot win; the same for the plan-hash lines), and falls back to a new folder holding `results.json`. `catalog` reuses `catalog-<fingerprint>/` for the same catalog, so "a new folder" alone would miss it.
14. *Review:* **The token reaches one step.** `cli-token` goes only to the "Obtain mcp-writecheck" step (`main.mjs obtain`), which masks it and the header made from it, refuses a `cli-ref` that is not a full 40-character SHA, and gives it to git only for the fetch, through `GIT_CONFIG_*` variables, with global and system git configuration and hooks off. The run step, which starts the server under test, never has it in its environment. `MCP_WRITECHECK_CLI_REPOSITORY` (the local test's clone) is ignored on a GitHub runner, and a token is sent only to an https repository.
15. *Review:* **The CLI runs in its own process group** (`detached`), so a signal to the job's process group reaches it once, through the script, and not twice (a second signal makes the CLI exit without its clean-up). The run step `exec`s node so that a signal to the step's shell reaches the script. Only the first signal is passed on: a runner cancels with SIGINT and then SIGTERM, and the CLI takes a second signal as "exit now, without clean-up" (review round 2). The runner's final kill still bounds the clean-up at about 10 s; the CLI should ignore SIGTERM after SIGINT and EPIPE on its output (CLI lane).

No design rule of the draft was made wrong by the CLI changes. Rule 4 no longer has an effect and could be dropped (owner decision 1 below).

### The skills

Unchanged, apart from the two P-7 lines in the caller skill.

1. **Builder.** One rule per requirement, in the spec's order, each with its ID, level and applicability condition. The rule restates the requirement sentence. A unit test checks that the skill has exactly the 37 IDs of the registry, in order, at the right levels; it cannot check the wording.
2. **Caller.** MWS puts no requirement on callers (section 2 puts agents out of scope). The skill says so, and presents its rules as what a careful caller does given what a server must, should and may do.
3. **Both skills tell the agent not to run a write test on its own judgment** of what is a test environment, and not to put a plan hash into a workflow that the user has not seen. Both tell it not to call a server "compliant" or "passing".
4. **Attribution.** Each skill ends with the attribution line the spec's section 16 asks for.

**The skills are behind the spec and the CLI.** They name spec commit `516c4ed`. Between `516c4ed` and `e2bb9b0` the IDs and levels are unchanged, but the requirement sentences of MWS-RES-2 (R9-1, unknown outcome; R10, retry exceptions), MWS-RETRY-2 (R8-1, R8-3) and MWS-ANN-4 (R10: `destructiveHint` on every tool not declared read-only) changed, and so did the applicability of MWS-TGT-3. The builder skill's CI section also says the CLI checks 29 of the 37 IDs and names the eight it lacks (now wrong: all 37 have records), and points to the action in `integrations/github-action` of the MWS repository (now: its own repository). Neither is a CLI command or flag, so this series leaves them; the commands and flags the builder skill quotes (`init --out --env --`, `plan -m`) are still right. Re-deriving the four rules and correcting the two CI sentences is a separate change for whoever owns the skills; `test/contract.test.mjs` pins the skills' spec commit as `SKILLS_SPEC_COMMIT` until then.

## What still depends on undecided things

| Undecided | Where it shows | What to change when it is decided |
|---|---|---|
| npm publication (name decided) | `contract.mjs` (`CLI_SOURCE`); `src/install.mjs` implements only the git source; the `cli-token` input; README "Until the CLI is published"; the example workflow; builder skill ("not yet published to npm"). | Replace `CLI_SOURCE` with the npm form, add the install branch, test it, and remove `cli-token`. `cli-ref` then becomes a version, which is a change of the input's meaning. |
| Visibility of `mcp-write-safety` | The fetch needs `cli-token` while it is private. | If it becomes public before npm publication, `cli-token` becomes optional at once. |
| The public spec page | `spec-url` default `https://isokron.ai/mws`; `requirementUrl()` in `contract.mjs` assumes the anchor is the ID in lower case. The page answered 404 on 14 November (not re-checked). | Check one link per area on the live page. |
| The standalone repository's name and first release | `uses:` in README, example and builder skill; the Marketplace listing (`name`, `description`, `branding` in `action.yml`; `branding` is not set yet). | Create the repository, add `branding`, tag a release, replace the placeholder SHA in the example. |
| The CLI after series A and the R9-1/R10 set | `safety.setup_unresolved` is read where present; the R10 changes (ANN-4 on every non-read-only tool, the TGT-2 operator declaration, the RES-2 retry exceptions) are in the spec but not in `0295ed6`. | Move `CLI_DEFAULT_REF`; re-run the tests with `CLI_DIR` and `MWS_SPEC`; check `results.json` for new fields. |

## CLI problems: status at `0295ed6`

"Ran" means observed in the local test; "read" means found in the source.

1. **Registry behind the spec.** *Fixed* (ran: `requirements`; `test/contract.test.mjs`). 37 IDs, the spec's levels, Annex C's order; `PLATFORM_LISTED` equals Annex C's `platform available` column; the README has a coverage table. Five short forms are worded differently from Annex C (MWS-IN-2, IN-7, CFG-2, CFG-4, ANN-2); the action prints Annex C's. The CLI is pinned to spec `098621b`, whose Annex C equals `e2bb9b0`'s.
2. **No attribution field.** *Fixed* (read, and seen in results): `results[].attribution`. The summary prints it.
3. **No catalog-only verdict path.** *Fixed* (ran): `mcp-writecheck catalog`, which this action exposes as mode `catalog`.
4. **The plan hash depends on the environment.** *Unchanged* (ran): the plan names every host given to the server (`Hosts reached or given to the server: 127.0.0.1:4610`). The README and the example still set the same URL in both jobs and a fixed port. `plan` still has no machine-readable output.
5. **A refused run leaves a folder behind.** *Unchanged* (read: `run` creates `<out>/<run id>/` before the confirmation). The action uses the `results:` line, then a new folder holding `results.json`.
6. **Exit status 1 does not mean the run completed.** *Unchanged* (read: `exit: interrupted ? 130 : … === 1 ? 1 : stopped ? 4 : 0`). The action checks `run.status`. In the series-A CLI, unreleased setup exits 4 and outranks 1.
7. **Exit status 1 is the only verdict signal.** *Unchanged*; the action reads `results.json`.
8. **The baseline outcome is not in the results.** *Unchanged* (read).
9. **`plan` and `catalog` without a saved catalog need a server that starts.** *Unchanged* (ran: tiny-tracker without `TRACKER_BACKEND_URL` exits 2, and the CLI exits 4).
10. **The CLI branch does not contain tiny-tracker.** *Unchanged*: tiny-tracker is on `examples/tiny-tracker-resync`; the CLI branch has only its manifest. The local test takes the server from `TINY_TRACKER_DIR`.
11. **Small things.** The schema's `$id` is still a placeholder (`https://mws.invalid/…`); redaction still skips credential values shorter than six characters; `tenant guard matched: …` is still printed without the redactor (read).
12. *New:* **`catalog` reuses its folder.** `catalog` writes `<out>/catalog-<fingerprint>/` and overwrites it for the same catalog (read). Harmless in CI; it is why design rule 13 exists.
13. *New:* **A bystander loss cannot be produced with tiny-tracker.** Its selector tool stays in the project it is given, and the CLI's loader refuses a selector not bound to the tester's own container (ran: `selector.args: must bind the container with {{scope}}`). The local test uses the server of the CLI's regression case S1 instead (`test/bystander-fixture.mjs`), which needs the CLI's compiled tests. A tiny-tracker defect that loses a bystander would make this case reproducible from the published packages.
14. *New:* **A test environment that fails during the run gives a `complete` run and exit status 0** (ran: tiny-tracker's backend killed 20 s into a run). Every later check is `not tested` (166 records, mostly "setup failed: could not create the object under test … 502"), the clean-up stops after three failures (`cleanup.stopped`: "3 cleanup calls failed in a row; the rest is left in the ledger") with 61 failed deletes and 9 unknown creates, and `run.status` is `complete`. A run whose backend is unreachable should be `stopped` with exit 4. The action fails the job on the unfinished clean-up instead (design choice 3).
15. *Review:* **The ledger holds unredacted server error text** (read: `objects.ts` writes `short(r.text, 200)` of a failed create or delete into the ledger; `run.ts` copies the ledger to `<run>/ledger.jsonl`). The action uploads both `state/` and the run folder, so a server that echoes a credential in an error puts it into an artifact that every reader of the repository can download. Fix in the CLI: pass ledger reasons through the redactor. The README's artifact section says so until then.

## Second-agent review, 15 November (landing on `integrations/action`)

A read-only review of the series on safety and correctness. No finding on: a green job for a run the CLI reported incomplete, stopped or with a lost bystander (every path traced); `confirm-target` and the plan-hash gate; shell injection from inputs. Findings and what was done:

| Finding | Done |
|---|---|
| S1. `run.stopped_reason`, `cleanup.stopped` and a JSON parse error reached the job status line unescaped (a server could add an image, a link or a fake status line) | Escaped in `decide()` and `readResults()`; annotations get the plain text. Unit test added. |
| S2. A signal to the job's process group reached the CLI twice, and a second signal skips its clean-up | `detached` child; `exec node` in action.yml. Design rule 15. |
| S3. `cli-ref` accepted a branch or tag with a warning | Refused unless 40 lower-case hex characters; the fetched commit is always checked. Unit test added. |
| S4. `MCP_WRITECHECK_CLI_REPOSITORY` could redirect the fetch, and the token, in production | Ignored when `GITHUB_ACTIONS` is `true`; a token goes only to an https repository. |
| S5. The token was in the run step's environment (readable from `/proc` by the server under test), unmasked, and given to every git command with the job's global configuration | Own obtain step; masked (token, header, base64); fetch-only, with global and system configuration and hooks off. README input table states the least scope. RUNNER-TEST's `cancelled` job no longer puts the token in git's argv. Design rule 14. |
| S6. The ledger in the artifact can hold unredacted server error text | CLI problem 15; README artifact section. Not fixable in the action without dropping the ledger. |
| S7. The upload used the raw `results-dir`, the script the trimmed one | Upload uses the resolved outputs. |
| S8. README warned against `pull_request_target` for mode `full` only; fork pull requests fail red while the CLI is private | Warning covers every mode; the example's plan job skips fork pull requests until the CLI is published. |
| S9. The skills' restatements of MWS-RES-2, MWS-RETRY-2, MWS-ANN-4 and the applicability of MWS-TGT-3 are wrong at `e2bb9b0`, not only stale, so moving the cited commit would not be a pure fact fix | Not changed: the skills still cite `516c4ed`, which their text matches. The builder skill's CI section got the two pure fact fixes (all 37 IDs have a check and a record at `0295ed6`, verified; the action's repository). Re-deriving the four rules stays with the skills' owner, before launch. |
| Nits | The levels comment in `summary.mjs`; the last match of the CLI's output lines; RUNNER-TEST's `steps.run.outcome` moved to `env`. |

The local test was re-run after the fixes (TESTING.md, "Re-run after the review"). It showed two faults of `test/local-test.sh`, not of the action: the cancelled and crashed cases fired a fixed 20 s into a run, and on a fast machine a run ends in about 12 s, so neither case was exercised (both now fire once the run has written 100 ledger entries); and Node 23 and later print the unit tests in the spec format, which the script's TAP filter did not read (it now asks for TAP). `actionlint` 1.7.12 finds nothing in the example workflow.

Round 2 (the same reviewer, on the fixes and on the public repository's two workflows): no blocker; every finding above fixed with no new problem. One remaining issue: SIGINT followed by SIGTERM still cut the CLI's clean-up short, because both were passed on; the script now passes on only the first. A detached CLI does not outlive a killed script for long (it dies on EPIPE at its next write). For the public repository's `selftest.yml`: tiny-tracker `b9265fe` and spec `e2bb9b0` are reachable only on `examples/tiny-tracker-resync` and `spec/0.9-review`; move the pinned refs when those branches are merged and deleted.

Also from the review, for the runner test: the runner's cancel sequence (SIGINT, then SIGTERM, then a kill) can be shorter than the CLI's clean-up grace. RUNNER-TEST's `cancelled` row now asks for that to be recorded.

## Decisions for the owner

1. **The MUST rule (design choice 4).** It has no effect at `0295ed6`. Keep it as a guard, or drop it and take the record's level alone.
2. **Whether to expose a baseline.** Teams with known violations cannot adopt `fail-on: must` without one. It needs the CLI to write the baseline outcome to a file (problem 8).
3. **The clean-up rule (design choice 3).** This series fails the job when the clean-up did not finish, whatever `fail-on` says; the brief asked only for a lost bystander. Keep it, or fix the CLI so that a run whose test environment failed is `stopped` (problem 14) and drop the rule. Keeping both does no harm.
4. **Whether the caller skill is published under the MWS name**, given that the spec scopes callers out. The skill is explicit that its rules are not MWS requirements.
5. **Artifact retention.** The capture can hold data from the test environment. The draft uses the repository's default retention.
6. **Marketplace metadata:** `branding` (icon and colour) and the listing name; `name: mcp-writecheck` may collide with another listing.

## Before any release

- [ ] Run the action on a GitHub runner: `RUNNER-TEST.md`.
- [ ] Re-derive the four changed rules of the builder skill (and the caller skill's MWS-RETRY-2 line) against the published spec; move `SKILLS_SPEC_COMMIT`. The two CI sentences were fixed in review.
- [ ] Run `node --test test/*.test.mjs` with `CLI_DIR` and `MWS_SPEC` pointing at the release candidates of both.
- [ ] Have a second reader check every rule of both skills against the requirement sentence of the published spec. The tests check IDs and levels only.
- [ ] Try both skills with an agent on a real task.
- [ ] Publish the spec page and follow one requirement link per area from a real summary.
- [ ] Publish the CLI to npm; switch `CLI_SOURCE`; retest the install path; remove `cli-token`.
- [ ] Replace the placeholder commit SHA in `examples/mcp-writecheck.yml` and in the README snippets with the release commit.
- [ ] Re-check the pinned commits of `actions/upload-artifact` (v7.0.2), `actions/checkout` (v7.0.1) and `actions/setup-node` (v7.1.0); they were read from the tag lists on 14 November 2026.
- [ ] Look at a real artifact from a server other than tiny-tracker for data that should not be there.

## Not done

- An install path for an npm package (there is no package to test it against).
- `--baseline`, `--sign`, `--review`, `rerun`, `cleanup` and `recheck` as action features.
- Annotations on pull-request lines, a pull-request comment, SARIF. `junit.xml` is in the artifact for teams that want a test reporter.
