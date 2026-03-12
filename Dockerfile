# ── Stage: production ────────────────────────────────────────────────────────
# Base: official Playwright image with Chromium pre-installed.
# Target: Linux Docker container on Windows Server (Docker Desktop / WSL2 backend).
#
# Port exposed: 3000  (map as -p 3000:3000 or via docker-compose.yml)
# ──────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# ── System packages ───────────────────────────────────────────────────────────
# Xvfb:       virtual framebuffer → gives Chromium a real display without hardware
# ffmpeg:     audio/video pipeline utilities
# pulseaudio: virtual audio device so Web Audio API works without sound card
# dbus-x11:   required by PulseAudio on Ubuntu 22.04 (jammy)
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    ffmpeg \
    pulseaudio \
    pulseaudio-utils \
    dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

# ── App setup ─────────────────────────────────────────────────────────────────
WORKDIR /app

# Install deps first (layer-cached; only re-runs if package*.json changes)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# ── Environment ───────────────────────────────────────────────────────────────
ENV NODE_ENV=production \
    # Tell Playwright where to find the pre-installed Chromium
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # Xvfb display number used by Chromium
    DISPLAY=:99 \
    # PulseAudio run as the app user (not root) avoids permission issues
    PULSE_SERVER=unix:/run/pulse/native

# ── Port ──────────────────────────────────────────────────────────────────────
EXPOSE 3000

# ── Health check ──────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# ── Entrypoint ────────────────────────────────────────────────────────────────
# 1. Start PulseAudio with a null (virtual) output sink — no real audio hardware needed
# 2. Start Xvfb on display :99 (1920×1080 24-bit) — virtual framebuffer for Chromium
# 3. Wait briefly for both to initialise
# 4. Start the Node.js server
CMD pulseaudio --start --exit-idle-time=-1 --system=false 2>/dev/null; \
    Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset & \
    sleep 1.5 && \
    node server.js
