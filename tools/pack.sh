#!/usr/bin/env bash
# Thin wrapper so the packaging step is one obvious command. See tools/pack.mjs.
set -euo pipefail
exec node "$(dirname "$0")/pack.mjs"
