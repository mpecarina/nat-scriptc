#!/usr/bin/env bash
#
# examples/interfaces-up.sh — report the interfaces that are UP on a host, with
# their IPv4 addresses.
#
# This is the whole extensibility loop in one script: a declarative parser pack
# (examples/parsers.json) turns `ip -br addr` text into JSON, `nat --json` emits
# the nested result, and `jq` consumes the parser's structured `.parsed` output.
# The script is meaningless without the pack — its filter depends on the shape
# `{ interfaces: [{ name, up, addresses: ["10.0.0.1/24", …] }] }`.
#
# Usage:
#   examples/interfaces-up.sh <host> [extra nat args...]
#
# Requirements: jq, and either a built binary (set NAT=dist/nat) or Node 24+ to
# run the CLI from source.
set -euo pipefail

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  echo "usage: interfaces-up.sh <host> [extra nat args...]" >&2
  exit 2
fi

host="$1"
shift

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "interfaces-up.sh: jq is required" >&2; exit 1; }

nat() {
  if [[ -n "${NAT:-}" ]]; then
    "$NAT" "$@"
  else
    node "$here/../cli/nat.ts" "$@"
  fi
}

printf 'host\tinterface\tstate\tipv4\n'

nat run "$host" \
  --driver linux \
  -c "ip -br addr" \
  --parsers "$here/parsers.json" \
  --json "$@" \
| jq -r '
    .results[]
    | .hostAlias as $host
    | .commands[]
    | select(.command == "ip -br addr")
    | .parsed.interfaces[]
    | select(.up)
    | [
        $host,
        .name,
        .state,
        ( [ .addresses[] | select(test(":") | not) ] | join(",") )
      ]
    | @tsv
  '
