#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
usage() {
    cat <<'USAGE'
Usage: ./deploy-local.sh [start|stop|edit-config|check] [options]
  --project NAME                 Saved project (default: agent-control)
  --proxy-network NAME           Existing shared ingress network; none disables
  --public-url URL               Canonical HTTPS origin; local clears it
  --mcp-config FILE              Existing protected MCP configuration input
  --configure-mcp                Interactive MCP configuration
  --db-reset                    Explicit destructive database reset (start only)
  --force-checks                Full regression checks during start
  --agent-sharing-diagnostics    Enable protected diagnostics during start
  --candidate FILE --candidate-sha256 HASH --expected-preflight HASH
  --read-only                   Pinned release preflight without deployment

Uses the same PowerShell deployment core as deploy-local.ps1. On native Linux,
PowerShell runs automatically in a Docker helper when pwsh is not installed.
The deployment never manages the shared proxy, network or certificates.
Application data is retained unless --db-reset is explicitly requested.
USAGE
}
command=start
if (($#)) && [[ $1 != -* ]]; then
    command=$1
    shift
fi
case "$command" in
    start|stop|edit-config|check) ;;
    *) printf 'Unknown command: %s\n' "$command" >&2; exit 2 ;;
esac
arguments=("$command")
candidate=''
release_requested=false
while (($#)); do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --project) parameter=-Project ;;
        --proxy-network) parameter=-ProxyNetwork ;;
        --public-url) parameter=-PublicUrl ;;
        --mcp-config) parameter=-McpConfig ;;
        --candidate) parameter=-Candidate; release_requested=true ;;
        --candidate-sha256) parameter=-CandidateSha256; release_requested=true ;;
        --expected-preflight) parameter=-ExpectedPreflight; release_requested=true ;;
        --db-reset) arguments+=(-DbReset); shift; continue ;;
        --force-checks) arguments+=(-ForceChecks); shift; continue ;;
        --agent-sharing-diagnostics) arguments+=(-AgentSharingDiagnostics); shift; continue ;;
        --configure-mcp) arguments+=(-ConfigureMcp); shift; continue ;;
        --read-only) arguments+=(-ReadOnly); release_requested=true; shift; continue ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
    if (($# < 2)) || [[ -z $2 || $2 == -* ]]; then
        printf 'Option %s requires a value.\n' "$1" >&2
        exit 2
    fi
    arguments+=("$parameter" "$2")
    if [[ $parameter == -Candidate ]]; then candidate=$2; fi
    shift 2
done
if [[ $release_requested == true && ! $candidate =~ [^[:space:]] ]]; then
    printf 'Release parameters require a nonempty --candidate. No ordinary deployment was started.\n' >&2
    exit 2
fi
if command -v pwsh >/dev/null 2>&1; then
    exec pwsh -NoLogo -NoProfile -File "$root/deploy-local.ps1" "${arguments[@]}"
fi
if [[ $(uname -s) != Linux ]]; then
    printf 'Install PowerShell 7 on macOS/Windows; the no-host-PowerShell Docker launcher supports native Linux (Ubuntu).\n' >&2
    exit 1
fi
for dependency in docker git stat; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
        printf 'Required command is missing: %s\n' "$dependency" >&2
        exit 1
    fi
done
endpoint=${DOCKER_HOST:-}
if [[ -z $endpoint || -n ${DOCKER_CONTEXT:-} ]]; then
    endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
fi
if [[ $endpoint != unix:///* ]]; then
    printf 'The Linux launcher requires a local Unix Docker socket; remote engines are unsafe for protected host bind mounts.\n' >&2
    exit 1
fi
socket=${endpoint#unix://}
config=${DOCKER_CONFIG:-"$HOME/.docker"}
if [[ ! -S $socket || $root == *,* || $socket == *,* || $config != /* || $config == *,* ]]; then
    printf 'Docker socket/configuration must be local absolute paths; bind paths cannot contain commas.\n' >&2
    exit 1
fi
if [[ $(docker info --format '{{.OSType}}') != linux ]]; then
    printf 'A Linux Docker engine is required.\n' >&2
    exit 1
fi
security=$(docker info --format '{{json .SecurityOptions}}')
if [[ $security == *rootless* ]]; then
    printf 'The Docker-contained launcher needs native host networking for loopback diagnostics; rootless engines are not supported.\n' >&2
    exit 1
fi
uid=$(id -u)
gid=$(id -g)
work="$root/artifacts/local-launcher/$uid"
(umask 077; mkdir -p -- "$work")
case "$(uname -m)" in
    x86_64) powershell_base=mcr.microsoft.com/powershell:7.5-azurelinux-3.0 ;;
    aarch64|arm64) powershell_base=mcr.microsoft.com/powershell:7.5-azurelinux-3.0-arm64 ;;
    *) printf 'The Docker-contained launcher supports native Linux x86_64 and ARM64.\n' >&2; exit 1 ;;
esac
image=$(docker build --quiet --build-arg "POWERSHELL_BASE=$powershell_base" - < "$root/scripts/local-launcher.Dockerfile")
if [[ ! $image =~ ^sha256:[a-f0-9]{64}$ ]]; then
    printf 'Launcher build did not return an immutable image identity.\n' >&2
    exit 1
fi
run=(run --rm --init --network host --read-only --cap-drop ALL --security-opt no-new-privileges
    --user "$uid:$gid" --group-add "$(stat -L -c '%g' "$socket")"
    --mount "type=bind,source=$root,target=$root"
    --mount "type=bind,source=$socket,target=$socket"
    --workdir "$root" --env "HOME=$HOME" --env "DOCKER_CONFIG=$config"
    --env "TMPDIR=$work" --env "XDG_CACHE_HOME=$work/cache"
    --env "XDG_CONFIG_HOME=$work/config" --env DOTNET_EnableDiagnostics=0
    --env POWERSHELL_TELEMETRY_OPTOUT=1 --env POWERSHELL_UPDATECHECK=Off)
if [[ -d $config ]]; then
    run+=(--mount "type=bind,source=$config,target=$config")
fi
checkout_input() {
    local path=$1 directory
    [[ $path == "$root/"* ]] || return 1
    directory=$(cd -- "${path%/*}" && pwd -P) || return 1
    [[ $directory == "$root" || $directory == "$root/"* ]]
}
for ((index=0; index<${#arguments[@]}; index++)); do
    if [[ ${arguments[index]} != -McpConfig ]]; then continue; fi
    input=${arguments[index+1]}
    if [[ $input != /* ]]; then input="$PWD/$input"; fi
    if [[ ! -f $input || -L $input || $input == *','* || $input == *$'\n'* || $input == *$'\r'* ]]; then
        printf 'MCP configuration must be a non-linked file without commas/newlines in its absolute path.\n' >&2
        exit 1
    fi
    arguments[index+1]=$input
    if ! checkout_input "$input"; then
        run+=(--mount "type=bind,source=$input,target=$input,readonly")
    fi
    inputs=$(docker "${run[@]}" "$image" -NoLogo -NoProfile -File "$root/scripts/local-launcher-inputs.ps1" -McpConfig "$input")
    while IFS= read -r path; do
        [[ -n $path ]] || continue
        if [[ ! -f $path || -L $path ]]; then
            printf 'An MCP secret input is missing or symbolic; restore the original protected file.\n' >&2
            exit 1
        fi
        # Saved project secrets must remain writable through the checkout mount.
        if ! checkout_input "$path"; then
            run+=(--mount "type=bind,source=$path,target=$path,readonly")
        fi
    done <<< "$inputs"
done
if [[ -t 0 && -t 1 ]]; then run+=(-it); else run+=(-i); fi
for variable in DOCKER_HOST DOCKER_CONTEXT AGENT_CONTROL_DEPENDENCY_IMAGE AGENT_CONTROL_MCP_DEPENDENCY_IMAGE; do
    if printenv "$variable" >/dev/null 2>&1; then run+=(--env "$variable"); fi
done
exec docker "${run[@]}" "$image" -NoLogo -NoProfile -File "$root/deploy-local.ps1" "${arguments[@]}"
