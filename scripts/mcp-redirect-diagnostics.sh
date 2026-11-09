#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s [CONTAINER [SINCE [FORMAT]]]\n' "${0##*/}"
  printf 'Defaults: seha-agent-control-mcp-1 30m table\n'
  printf 'Formats: table, json, csv\n'
}

if [[ $# -eq 1 && ( "${1-}" == "-h" || "${1-}" == "--help" ) ]]; then
  usage
  exit 0
fi

if [[ $# -gt 3 ]]; then
  usage >&2
  exit 2
fi

container="${1-seha-agent-control-mcp-1}"
since="${2-30m}"
format="${3-table}"

if [[ -z "$container" || -z "$since" ]]; then
  printf 'Container and time window must not be empty.\n' >&2
  exit 2
fi

case "$format" in
  table|json|csv) ;;
  *)
    printf 'Unsupported format: %s. Use table, json, or csv.\n' "$format" >&2
    exit 2
    ;;
esac

docker logs --since "$since" --timestamps -- "$container" 2>&1 \
  | docker exec -i -- "$container" \
      python -m agent_control_mcp.redirect_diagnostics --format "$format" \
  || {
    status=$?
    printf 'MCP redirect diagnostics failed (exit %s). Check Docker access, the container name, and the time window.\n' "$status" >&2
    exit "$status"
  }
