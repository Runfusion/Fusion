#!/bin/sh
# FNXC:DockerRun 2026-08-23-02:13:
# Optionally start `tailscaled` before the dashboard, because the image shipping the `tailscale` CLI
# is not enough to make the remote-access feature work. Fusion's tunnel spawns a bare
# `tailscale funnel <port>`, which needs a running daemon on the DEFAULT socket; with no daemon it
# dies instantly with "failed to connect to local tailscaled" and exit 1, surfacing in the UI as an
# unexplained process failure (operator report: "starting tailscale tunnel in container is failing
# with process exited 1").
#
# The daemon is OPT-IN via a leading `--tailscale` argument (or `FUSION_TAILSCALE=1`), not on by
# default: most containers never use remote access, and a background daemon they did not ask for is
# a process, a listening socket, and an identity in someone's tailnet. The flag is consumed here and
# STRIPPED from the argument list, so everything after it stays a normal Fusion CLI invocation and
# `docker run fusion --tailscale dashboard --port 8080` behaves exactly like the documented form.
#
# Userspace networking (`--tun=userspace-networking`) is deliberate: it needs neither `NET_ADMIN` nor
# `/dev/net/tun`, so the documented `docker run` keeps working unchanged, and it is sufficient for
# `tailscale serve`/`funnel`, which proxy to a local port rather than route packets. The SOCKS5/HTTP
# proxy listeners are the standard userspace-mode escape hatch for outbound tailnet access, which has
# no route out otherwise.
#
# Startup is BEST-EFFORT and never fails the container: a daemon that will not start must still leave
# the operator with a dashboard, and the tunnel preflight reports the unusable backend by itself.
#
# Login is NOT automated here — `tailscale up` requires an interactive auth URL or an operator's auth
# key, so the daemon comes up logged-out and the operator authenticates once. State lives under
# /var/lib/tailscale, which the image symlinks into /home/node/.tailscale so the documented
# `-v <vol>:/home/node` mount persists that login across container recreates.
set -e

tailscale_enabled="${FUSION_TAILSCALE:-0}"
from_source="${FUSION_FROM_SOURCE:-0}"

# Rotate the argument list, dropping the flags this wrapper owns. The shift/append idiom is used
# rather than string concatenation so arguments containing spaces survive intact.
argc=$#
i=0
while [ "$i" -lt "$argc" ]; do
  arg="$1"
  shift
  case "$arg" in
    --tailscale) tailscale_enabled=1 ;;
    --no-tailscale) tailscale_enabled=0 ;;
    --from-source) from_source=1 ;;
    --no-from-source) from_source=0 ;;
    *) set -- "$@" "$arg" ;;
  esac
  i=$((i + 1))
done

# FNXC:DockerRun 2026-08-31-14:24:
# Liveness is decided by an actual RUNNING PROCESS, never by the socket FILE. `docker restart` reuses
# the container's writable layer, so /var/run/tailscale/tailscaled.sock survives a stop with no
# daemon behind it; a `[ ! -S ... ]` guard then reads that corpse as "already running", skips startup,
# and the box comes back with remote access silently dead — the dashboard healthy, `tailscale` itself
# answering `connect: connection refused`. Measured on a live restart. The stale file is removed
# before starting, because tailscaled will not bind over it.
tailscaled_running() {
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    case "$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null)" in
      *tailscaled*) return 0 ;;
    esac
  done
  return 1
}

if [ "$tailscale_enabled" = "1" ] && [ -x /usr/sbin/tailscaled ]; then
  if ! tailscaled_running; then
    rm -f /var/run/tailscale/tailscaled.sock
    /usr/sbin/tailscaled \
      --tun=userspace-networking \
      --socks5-server=localhost:1055 \
      --outbound-http-proxy-listen=localhost:1055 \
      >/var/log/tailscaled.log 2>&1 &
  fi
fi

# FNXC:DockerSourceUpdate 2026-09-01-01:22:
# Requirement: a remote contributor whose ONLY access is the Fusion dashboard of this container must
# be able to pull new source, rebuild it, and run it — without a shell, the Docker socket, or an
# image rebuild — and must never be able to brick the container doing so.
#
# Two things had to change here for that to be possible.
#
# (1) SUPERVISION. This script used to end in `exec node .../bin.js`, so the dashboard WAS pid 1 with
# no parent to respawn it. `hasLiveSupervisingParent()` therefore reported unsupervised, the System
# panel's Restart button was permanently dead in the container, and any restart would simply have
# ended the container. The loop below is that missing supervisor: it relaunches ONLY on
# FUSION_RESTART_EXIT_CODE (86), the code the dashboard sets on a requested restart, and propagates
# every other exit code so a crash, `docker stop`, or an operator `fn` exit still ends the container
# with its real status instead of being papered over by a restart loop.
#
# FUSION_SUPERVISOR_PID stamps THIS shell's pid. FUSION_RESTART_SUPERVISED alone is inherited by
# every process the dashboard spawns, so a nested `fn dashboard` would otherwise advertise
# restartSupported and then vanish on restart with nobody listening; the dashboard only trusts the
# flag when the stamped pid is its real parent.
#
# Signals are FORWARDED, not swallowed. As pid 1 a shell ignores signals with a default disposition,
# so without these traps `docker stop` would hang for its full timeout and then SIGKILL — losing the
# graceful engine/database teardown. `shutting_down` also suppresses relaunch, so a restart racing a
# stop cannot resurrect the dashboard after the operator asked the container to end.
#
# (2) RUN-FROM-SOURCE. The image serves the baked build at /app, which has no .git and no build
# scripts, so pulling and rebuilding there is impossible. `--from-source` (or FUSION_FROM_SOURCE=1)
# runs the CLI out of the source checkout at FUSION_SOURCE_ROOT instead — a real git checkout with
# node_modules already installed, mounted on a persistent volume — which is what makes
# `POST /system/source/update` (git pull -> build -> restart) meaningful. The flag is consumed and
# STRIPPED exactly like --tailscale so the remaining arguments stay a normal Fusion CLI invocation.
#
# A missing source build FAILS LOUDLY rather than falling back to /app: a container that silently
# serves different code than the operator asked for is the exact failure this feature exists to
# avoid, and the fallback would look identical to a successful update.
app_root="${FUSION_APP_ROOT:-/app}"
source_root="${FUSION_SOURCE_ROOT:-/home/node/fusion}"

if [ "$from_source" = "1" ]; then
  entry="$source_root/packages/cli/dist/bin.js"
  if [ ! -f "$entry" ]; then
    echo "fusion: --from-source was requested but no built CLI exists at $entry" >&2
    echo "fusion: clone/checkout Fusion at $source_root and run 'pnpm install && pnpm build' there," >&2
    echo "fusion: or set FUSION_SOURCE_ROOT to a built checkout. Refusing to fall back to $app_root." >&2
    exit 1
  fi
  echo "fusion: running from source checkout $source_root" >&2
else
  entry="$app_root/packages/cli/dist/bin.js"
fi

FUSION_RESTART_EXIT_CODE=86
FUSION_RESTART_SUPERVISED=1
FUSION_SUPERVISOR_PID=$$
export FUSION_RESTART_SUPERVISED FUSION_SUPERVISOR_PID

child_pid=""
shutting_down=0

forward_signal() {
  shutting_down=1
  if [ -n "$child_pid" ]; then
    kill -"$1" "$child_pid" 2>/dev/null || true
  fi
}

trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT
trap 'forward_signal HUP' HUP

while :; do
  node "$entry" "$@" &
  child_pid=$!

  # `wait` returns early when a trapped signal arrives, so keep waiting until the child is really
  # gone; otherwise a forwarded SIGTERM would be mistaken for the child's own exit status.
  exit_code=0
  while :; do
    exit_code=0
    wait "$child_pid" || exit_code=$?
    kill -0 "$child_pid" 2>/dev/null || break
  done
  child_pid=""

  if [ "$shutting_down" = "1" ]; then
    exit "$exit_code"
  fi
  if [ "$exit_code" != "$FUSION_RESTART_EXIT_CODE" ]; then
    exit "$exit_code"
  fi
  echo "fusion: restart requested (exit $FUSION_RESTART_EXIT_CODE) — relaunching" >&2
done
