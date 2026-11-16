# MCP Write Safety (plugin)

Two agent skills for MCP tools that create, update or delete state, each rule tied to a requirement ID in the
[MCP Write-Safety Requirements (MWS 0.9)](https://isokron.ai/mws?utm_source=claude-plugins&utm_medium=directory&utm_campaign=skills):

- `mcp-write-safe-builder`: build rules for the authors of MCP servers.
- `mcp-write-safe-caller`: call rules for agents that use write tools.

Install:

```sh
claude plugin marketplace add isokron-ai/mcp-writecheck-action
claude plugin install mcp-write-safety@isokron
```

The skills here are copies of [`skills/`](../skills/) in this repository, kept identical by a test. The test tool that
checks a server against the same requirements is [mcp-writecheck](https://github.com/isokron-ai/mcp-write-safety).

Licence: Apache-2.0 (`LICENSE`). The MWS mark used as the icon belongs to IsoKron and is shown under its usage policy
(IsoKron's own MWS packages may display it).

By IsoKron.
