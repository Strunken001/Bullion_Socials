#!/bin/bash

echo "==============================================="
echo "  Starting Remote Browser Server Locally       "
echo "==============================================="

# Attempt to start pulseaudio daemon. This might fail if the user's desktop environment 
# already provides a running pulseaudio/pipewire instance, but we can safely ignore the error.
pulseaudio -D --exit-idle-time=-1 2>/dev/null || echo "PulseAudio daemon already running or started."

# Run the Node server wrapped in Xvfb
echo "Launching server on http://localhost:3000 ..."
xvfb-run --server-args="-screen 0 1920x1080x24" node server.js
