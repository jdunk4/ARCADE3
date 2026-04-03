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
# This creates a virtual_speaker sink so ffmpeg can capture emulator audio.
echo "[start] starting PulseAudio"
pulseaudio --start --exit-idle-time=-1 --daemonize=false &
PULSE_PID=$!
sleep 1

# Create virtual sink (named virtual_speaker) — captures from .monitor
pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description=VirtualSpeaker || true
pactl set-default-sink virtual_speaker || true

echo "[start] Xvfb and PulseAudio ready"

# ── Node server ────────────────────────────────────────────────────────────────
echo "[start] starting ARCADE3-WHEP server"
exec node server-whep.js
