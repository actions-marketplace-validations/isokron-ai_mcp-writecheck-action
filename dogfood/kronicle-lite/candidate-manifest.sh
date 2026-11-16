#!/usr/bin/env bash
# The candidate manifest, for a dispatch with `candidate-manifest` (the pinned CLI, f573a24, reads
# key.class; 0295ed6 refused it as an unknown key). It is dogfood/kronicle-lite/writecheck.yaml
# with one resource added, `document-reput`: documents made by put_document, with a caller-chosen key,
# so that a second put_document with the same slug (a re-put of an existing document, with other
# markdown) is sent and read back. That is the call MWS-ANN-2 and MWS-ANN-5 judge a create tool by;
# without a key, put_document is only ever a first put, and both are reported not tested.
# `class: upsert` quotes put_document's own description ("Create or re-put a Markdown document by
# slug"): a re-put by design, which MWS-TGT-3 does not cover (NF-8), so no TGT-3 record is made.
# The key goes on a resource of its own, not on `document`: the CLI skips the duplicate-create checks
# (MWS-RETRY-1, MWS-RES-3) for a resource with a key, and `document` keeps them.
# Built from the main manifest each time, so the two cannot drift apart; the checks below fail the
# job if the main manifest no longer ends as expected or already has the resource.
# Exports KL_MANIFEST and KL_KNOWN (the known violations for this manifest).
#   dogfood/kronicle-lite/candidate-manifest.sh   (from the workspace root)
set -euo pipefail
dir=dogfood/kronicle-lite
src=$dir/writecheck.yaml
out=$dir/writecheck.candidate.yaml
[ "$(tail -n 1 "$src")" = '    cleanup: ephemeral' ] || { echo "::error::$src no longer ends with a resource's cleanup line"; exit 1; }
! grep -q '^  - name: document-reput$' "$src" || { echo "::error::$src already has a document-reput resource"; exit 1; }
cat "$src" - > "$out" <<'YAML'

  # Candidate only (candidate-manifest.sh): documents made by put_document with a caller-chosen key, so
  # that a re-put of an existing slug with other markdown is sent and read back (MWS-ANN-2, ANN-5).
  - name: document-reput
    create: { tool: put_document, args: { slug: "{{marker}}", title: "{{marker}}", markdown: "# {{marker}}\n\nreputres paragraph\n" }, id: slug, name_path: slug }
    read: { tool: audit_assumptions, args: { claims: [ { symbol: "{{id}}", value: 0 } ] }, object: "results[0].current", ignore: [updated_at] }
    key: { arg: slug, vary: { arg: markdown, path: markdown_hash }, class: { as: upsert, quote: "re-put" } }
    missing_id: dogfood-no-such-document
    cleanup: ephemeral
YAML
head -n "$(wc -l < "$src")" "$out" | cmp -s - "$src" || { echo "::error::$out does not start with $src"; exit 1; }
echo "KL_MANIFEST=$out" >> "$GITHUB_ENV"
echo "KL_KNOWN=$dir/known-violations-candidate.txt" >> "$GITHUB_ENV"
echo "using the candidate manifest (sha256 $(sha256sum "$out" | cut -c1-16)): $src with the document-reput resource"
