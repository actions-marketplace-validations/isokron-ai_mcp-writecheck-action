#!/usr/bin/env bash
# Checks the corpus workflow's `only` input (ONLY_IN) and derives the shard count from it.
# Reads nothing but ONLY_IN (and, in the shard jobs, PLAN_SHARDS and SHARD); never a secret.
#
#   corpus/check-batch.sh output "$GITHUB_OUTPUT"   # plan job: shards=K, matrix=[1,...,K]
#   corpus/check-batch.sh env "$GITHUB_ENV"         # shard job: CORPUS_ONLY=..., CORPUS_SHARDS=K
#
# The whole value must match: a bash regex, not grep (grep -x matches line by line, so a value with
# a newline could add lines to GITHUB_ENV). Every check runs before anything is written, and only a
# value that passed is written. An ID may appear once, compared by number (t09 and t009 are the
# same). K = min(MAX_SHARDS, number of IDs); an empty value (every target) gets MAX_SHARDS. In env
# mode, PLAN_SHARDS (the plan job's K) must equal the K derived here, SHARD must be between 1 and K,
# and the matrix itself must agree: JOB_TOTAL (strategy.job-total) == K and JOB_INDEX
# (strategy.job-index) + 1 == SHARD, so the matrix cannot disagree with the validated input.
set -euo pipefail

MAX_IDS=40
MAX_SHARDS=16

mode=${1:-}
file=${2:-}
if { [ "$mode" != env ] && [ "$mode" != output ]; } || [ -z "$file" ]; then
  echo "::error::usage: corpus/check-batch.sh env|output FILE"
  exit 2
fi

only=${ONLY_IN-}
re="^t[0-9]{2,3}(,t[0-9]{2,3}){0,$((MAX_IDS - 1))}\$"
if [ -n "$only" ] && ! [[ "$only" =~ $re ]]; then
  echo "::error::only must be comma-separated target IDs such as t13,t09 (at most $MAX_IDS)"
  exit 1
fi

n=0
if [ -n "$only" ]; then
  IFS=, read -r -a ids <<<"$only"
  n=${#ids[@]}
  declare -A seen=()
  # Keyed on the number, not the text: t09 and t009 count as the same ID.
  for id in "${ids[@]}"; do
    num=$((10#${id#t}))
    if [ -n "${seen[$num]+x}" ]; then
      echo "::error::only names a target ID twice"
      exit 1
    fi
    seen[$num]=1
  done
fi

if [ "$n" -eq 0 ] || [ "$n" -gt "$MAX_SHARDS" ]; then shards=$MAX_SHARDS; else shards=$n; fi

if [ "$mode" = env ]; then
  if [ "${PLAN_SHARDS-}" != "$shards" ]; then
    echo "::error::the planned shard count does not match the batch"
    exit 1
  fi
  if ! [[ "${SHARD-}" =~ ^[0-9]{1,2}$ ]] || [ "$SHARD" -lt 1 ] || [ "$SHARD" -gt "$shards" ]; then
    echo "::error::this shard is not in the planned matrix"
    exit 1
  fi
  # The matrix itself: exactly K jobs, and this job is the SHARD-th of them.
  if ! [[ "${JOB_TOTAL-}" =~ ^[0-9]{1,3}$ ]] || ! [[ "${JOB_INDEX-}" =~ ^[0-9]{1,3}$ ]] \
    || [ "$JOB_TOTAL" -ne "$shards" ] || [ "$((10#$JOB_INDEX + 1))" -ne "$SHARD" ]; then
    echo "::error::the job matrix does not match the planned shards"
    exit 1
  fi
  {
    echo "CORPUS_ONLY=$only"
    echo "CORPUS_SHARDS=$shards"
  } >>"$file"
else
  matrix=$(seq -s, 1 "$shards")
  {
    echo "shards=$shards"
    echo "matrix=[$matrix]"
  } >>"$file"
fi
