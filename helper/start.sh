#!/usr/bin/env bash
# Start the MQTT Notifier helper with an explicit permission set and a
# minimal environment. Used by Service.qml and by the integration tests.
#
#   start.sh CONFIG_DIR STATE_DIR [helper args...]
#
# Permissions:
#   read   this directory (code), the config dir, the state dir
#   write  the config dir (first-run example config), the state dir
#   net    MQTT brokers (any host: broker hosts come from the config at runtime)
#   run    secret-tool (keyring), notify-send (desktop notifications),
#          bwrap + deno (the parser worker sandbox)
#   env    all — the environment is cleared below, so nothing sensitive is in it
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
config_dir="${1:?config dir}"
state_dir="${2:?state dir}"
shift 2

deno_bin="$(command -v deno || true)"
if [[ -z $deno_bin ]]; then
  echo '{"event":"fatal","error":"deno is not installed. Run the plugin install script or: sudo pacman -S deno"}'
  exit 127
fi
deno_bin="$(readlink -f "$deno_bin")"

mkdir -p -m 700 "$config_dir" "$state_dir"

env_args=(
  HOME="$HOME"
  PATH=/usr/local/bin:/usr/bin
  LANG=C.UTF-8
  NO_COLOR=1
  DENO_DIR="${DENO_DIR:-$HOME/.cache/deno}"
  DENO_NO_UPDATE_CHECK=1
)
[[ -n ${DBUS_SESSION_BUS_ADDRESS:-} ]] && env_args+=(DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS")
[[ -n ${XDG_RUNTIME_DIR:-} ]] && env_args+=(XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR")

exec env -i "${env_args[@]}" "$deno_bin" run \
  --no-prompt --cached-only --frozen --config "$here/deno.json" \
  --allow-read="$here,$config_dir,$state_dir" \
  --allow-write="$config_dir,$state_dir" \
  --allow-net \
  --allow-env \
  --allow-run="secret-tool,notify-send,bwrap,$deno_bin" \
  "$here/main.ts" --config-dir "$config_dir" --state-dir "$state_dir" "$@"
