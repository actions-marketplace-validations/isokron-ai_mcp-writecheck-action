# Security policy

This policy covers the `mcp-writecheck` GitHub Action and the plugin in `plugin/` (two Agent Skills).

## Reporting a vulnerability

Please email **hello@isokron.ai** with "Security" in the subject. Do not open a public issue.
Include the version, tag or commit, the steps to reproduce, and the impact you see.
We acknowledge reports within five business days and keep you updated until the issue is resolved.

A vulnerability in the checker itself (`@mcp-write-safety/writecheck`) or in the MWS spec belongs to
[isokron-ai/mcp-write-safety](https://github.com/isokron-ai/mcp-write-safety), which accepts
private reports through GitHub (Security > Report a vulnerability).

## Supported versions

The latest `v0` release. Fixes ship as a new `v0.x.y` release, and the `v0` tag moves to it.

## What this Action does with secrets

It needs no repository secret. The optional `cli-token` input is kept only for old workflows (the
checker's repository is public, so leave it unset); if given, only the step that fetches the checker
sees it. Mode `plan` makes no tool calls and writes nothing. Mode `full` makes real writes to whatever
system your manifest points at, so point it only at a test environment you are allowed to change.
