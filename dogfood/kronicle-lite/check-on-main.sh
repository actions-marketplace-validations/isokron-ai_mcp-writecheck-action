#!/usr/bin/env bash
# The kronicle-lite commit checked out at kl/ must be on isokron-ai/kronicle-lite's main. GitHub serves a
# commit of any fork through the parent repository, so a full SHA alone (dogfood/check-ref.sh) does not
# show that the commit is IsoKron's; this runs before kronicle-lite is installed or built.
#   dogfood/kronicle-lite/check-on-main.sh   (from the workspace root)
set -euo pipefail
head=$(git -C kl rev-parse HEAD)
git -C kl fetch -q --unshallow origin main 2>/dev/null || git -C kl fetch -q origin main
if ! git -C kl merge-base --is-ancestor "$head" FETCH_HEAD; then
  echo "::error::the kronicle-lite commit is not on isokron-ai/kronicle-lite's main"
  exit 1
fi
echo "kronicle-lite $head is on main"
