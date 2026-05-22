#!/bin/bash
# Launcher for the nanoclaw LaunchAgent. Waits for network/DNS to be ready
# before starting node, because launchd fires the agent before macOS has
# reliably brought DNS up on boot. Without this, startup DNS lookups for
# discord.com / googleapis fail with ENOTFOUND and the bot stays offline.
#
# A single successful dscacheutil probe is NOT enough — we've seen the probe
# pass at boot and node's actual getaddrinfo fail seconds later. Require
# multiple consecutive successes across multiple hosts before exec'ing node.

set -e

LOG="/Users/albot/projects/nanoclaw/logs/nanoclaw.log"
HOSTS=(discord.com www.googleapis.com)
REQUIRED_STREAK=3   # consecutive all-hosts-resolve successes
WAIT_INTERVAL=2     # seconds between probes
MAX_WAIT=300        # seconds total

log() {
  echo "[$(date '+%H:%M:%S.000')] [launch.sh] $*" >>"$LOG"
}

probe_all() {
  for host in "${HOSTS[@]}"; do
    if ! /usr/bin/dscacheutil -q host -a name "$host" 2>/dev/null | grep -q '^ip_address:'; then
      return 1
    fi
  done
  return 0
}

log "waiting for DNS/network (need ${REQUIRED_STREAK} consecutive resolutions of: ${HOSTS[*]})"

ELAPSED=0
STREAK=0
while (( ELAPSED < MAX_WAIT )); do
  if probe_all; then
    STREAK=$(( STREAK + 1 ))
    if (( STREAK >= REQUIRED_STREAK )); then
      log "network stable after ${ELAPSED}s (streak=${STREAK}), starting node"
      break
    fi
  else
    if (( STREAK > 0 )); then
      log "DNS flaked after streak=${STREAK} at ${ELAPSED}s, resetting"
    fi
    STREAK=0
  fi
  sleep "$WAIT_INTERVAL"
  ELAPSED=$(( ELAPSED + WAIT_INTERVAL ))
done

if (( ELAPSED >= MAX_WAIT )); then
  log "timed out waiting for network after ${MAX_WAIT}s, starting anyway"
fi

cd /Users/albot/projects/nanoclaw

# Pipes spawn `node <file>` via child_process.spawn with a bare command, so
# `node` must be resolvable on PATH inside the NanoClaw process. The plist's
# minimal PATH doesn't include Homebrew, so add it here.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/albot/.local/bin"

exec /opt/homebrew/bin/node /Users/albot/projects/nanoclaw/dist/index.js
