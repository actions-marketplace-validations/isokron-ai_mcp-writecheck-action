# Regression ledger

One row per thing that went wrong, or could, in this repository's loop worker (`loop/`, `corpus.yml`,
`loop-fixture.yml`): what it was, the test that pins it, and the commit that fixed it. Each test named here starts
with its row's ID.

- `R-WC-*`: the writecheck loop worker (pull request 61).

| ID | What went wrong | Test | Fix |
|---|---|---|---|
| R-WC-01 | The tools volume held mcp-surface-corpus's `sandbox/` only; its network logger imports `../src/dns.mjs`, so the logger did not start and every unit (the controls first) failed on the first fixture run. The volume now holds `sandbox/` and `src/`, and the driver refuses to pack a volume whose code imports a file that is not in it. | `test/loop.test.mjs`: "R-WC-01: the tools volume carries what its code imports" | this commit |
