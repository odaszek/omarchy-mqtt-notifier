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
#
# Missing npm dependencies are fetched first (see "Dependencies" below).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
config_dir="${1:?config dir}"
state_dir="${2:?state dir}"
shift 2

deno_bin="$(command -v deno || true)"
if [[ -z $deno_bin ]]; then
  echo '{"event":"fatal","error":"Deno is not installed. Install it with: sudo pacman -S deno, then run: omarchy restart shell"}'
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

# Dependencies. `omarchy plugin add` only clones the repository and never runs
# an install step, so fetch the pinned npm packages (exact versions and
# integrity hashes from deno.lock, --frozen) on first start. The check is
# offline and takes a few milliseconds when they are already cached. The
# helper itself then runs with --cached-only: it never downloads code.
deps() { (cd "$here" && env -i "${env_args[@]}" "$deno_bin" install --frozen --entrypoint main.ts "$@"); }
if ! deps --cached-only >/dev/null 2>&1; then
  mkdir -p -m 700 "$state_dir/logs"
  if ! deps >/dev/null 2>"$state_dir/logs/dependencies.log"; then
    # Exit status other than 127: Service.qml restarts the helper with backoff,
    # so this retries until the network is up.
    echo '{"event":"fatal","error":"Could not download the MQTT library (is the network up?). Retrying; details in logs/dependencies.log"}'
    exit 75
  fi
fi

exec env -i "${env_args[@]}" "$deno_bin" run \
  --no-prompt --cached-only --frozen --config "$here/deno.json" \
  --allow-read="$here,$config_dir,$state_dir" \
  --allow-write="$config_dir,$state_dir" \
  --allow-net \
  --allow-env \
  --allow-run="secret-tool,notify-send,bwrap,$deno_bin" \
  "$here/main.ts" --config-dir "$config_dir" --state-dir "$state_dir" "$@"
