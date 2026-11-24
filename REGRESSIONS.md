# Regression ledger

One row per thing that went wrong, or could, in this repository: what it was, the tests that pin it, and the commit
that fixed it. Each test named here starts with its row's ID. IsoKron's cross-repo ledger (`docs/LEDGER.md` in
isokron-ai/tool-qa) reads this table, so keep its four columns.

- `R-INP-*`: the dispatch inputs of the T0 worker workflows (`selftest.yml`, `dogfood-*.yml`).

| ID | What it was | Pinned by | Fix |
|---|---|---|---|
| R-INP-01 | LOW. The T0 workers checked each dispatch input with `printf '%s' "$v" \| grep -Eq`, which matches line by line: a value with a newline passed when one of its lines did, and its second line then went into `$GITHUB_OUTPUT` as an output of its own (for example a forged `run_key`). Only someone who can dispatch the workflows could send one. The check is now a whole-string `[[ "$v" =~ $pattern ]]` match, in all eight workflows. | `test/workflow-inputs.test.mjs` › `R-INP-01: every T0 worker refuses a dispatch input with a newline in it`<br>`test/workflow-inputs.test.mjs` › `R-INP-01: the old grep check let a newline through, so the test above can fail` | 3a7042c |
