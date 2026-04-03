# ARCADE3 — WHEP Streaming Server
# Based on the ARCADE2 Dockerfile pattern but adds:
#   - @roamhq/wrtc native build deps
#   - ffmpeg rawvideo output (already present)
#   - PulseAudio virtual sink for audio capture

FROM node:20-slim

# ── System packages ────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium + virtual display (same as ARCADE2)
    chromium \
    xvfb \
    xauth \
    # ffmpeg for video/audio capture
    ffmpeg \
    # PulseAudio for virtual audio sink
    pulseaudio \
    pulseaudio-utils \
    # wrtc native build deps
    libatomic1 \
    # cleanup
    && rm -rf /var/lib/apt/lists/*

# ── PulseAudio config ──────────────────────────────────────────────────────────
# Create a virtual audio sink so ffmpeg can capture game audio
COPY default.pa /etc/pulse/default.pa

# ── App ────────────────────────────────────────────────────────────────────────
WORKDIR /app
COPY package*.json ./
# Install all deps (including patch-package which @roamhq/wrtc needs in its postinstall hook)
RUN npm install

COPY . .

# ── Start script ───────────────────────────────────────────────────────────────
# start.sh launches Xvfb + PulseAudio + the Node server
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 3000
CMD ["/start.sh"]
