#!/usr/bin/env bash
# Remove the MQTT Notifier plugin.
#
#   scripts/uninstall.sh           remove the plugin; keep config, history and keyring secrets
#   scripts/uninstall.sh --purge   also delete config, history, logs and keyring secrets
set -euo pipefail

id="odach.mqtt-notifier"
plugins="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/mqtt-notifier"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/mqtt-notifier"

purge=false
[[ ${1:-} == "--purge" ]] && purge=true

omarchy plugin disable "$id" 2>/dev/null || true
if [[ -d $plugins/$id ]]; then
  rm -rf "${plugins:?}/$id"
  echo "Removed $plugins/$id"
fi

if $purge; then
  rm -rf "$config_dir" "$state_dir"
  if command -v secret-tool >/dev/null; then
    secret-tool clear service omarchy-mqtt-notifier 2>/dev/null || true
  fi
  echo "Deleted $config_dir, $state_dir and keyring secrets"
else
  echo "Kept $config_dir (brokers) and $state_dir (history). Use --purge to delete them."
fi
