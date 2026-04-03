#!/bin/bash
# ARCADE3-WHEP start script
# Spins up virtual display + audio sink, then starts the Node server

set -e

export DISPLAY=:99

# ── Virtual display ────────────────────────────────────────────────────────────
echo "[start] launching Xvfb on :99"
Xvfb :99 -screen 0 1024x768x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1

# ── PulseAudio virtual sink ────────────────────────────────────────────────────
# Railway runs as root — PulseAudio requires --system flag in that case.
# We also need dbus-daemon running for PulseAudio to start cleanly.
echo "[start] starting dbus"
mkdir -p /run/dbus
dbus-daemon --system --fork || true
sleep 1

echo "[start] starting PulseAudio (system mode for root)"
pulseaudio --system --disallow-exit --disallow-module-loading=false \
  --daemonize=true --exit-idle-time=-1 || true
sleep 2

# Create virtual sink (named virtual_speaker) — ffmpeg captures from .monitor
pactl --server=unix:/var/run/pulse/native \
  load-module module-null-sink sink_name=virtual_speaker \
  sink_properties=device.description=VirtualSpeaker 2>/dev/null || true
pactl --server=unix:/var/run/pulse/native \
  set-default-sink virtual_speaker 2>/dev/null || true

echo "[start] Xvfb and PulseAudio ready"

# Export PULSE_SERVER so Node.js and all child processes (ffmpeg) find PulseAudio
export PULSE_SERVER="unix:/var/run/pulse/native"

# ── Node server ────────────────────────────────────────────────────────────────
echo "[start] starting ARCADE3-WHEP server"
exec node server-whep.js
