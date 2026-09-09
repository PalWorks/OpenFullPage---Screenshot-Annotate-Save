#!/usr/bin/env bash
# Everything CI runs, in one command.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== package =="
./tools/pack.sh

echo
echo "== invariants and unit tests =="
node --test 'test/**/*.test.js'

echo
echo "== icons match their design source =="
node tools/make-icons.mjs --check

if command -v go >/dev/null; then
  echo
  echo "== verify-crx =="
  (cd tools/verify-crx && test -z "$(gofmt -l .)" && go vet ./... && go build -o verify-crx .)
  ./tools/verify-crx/verify-crx zip "dist/openfullpage-$(cat VERSION).zip" .
else
  echo
  echo "== verify-crx skipped (Go not installed) =="
fi

echo
echo "All checks passed. End-to-end capture is separate: node test/e2e/run.mjs"
