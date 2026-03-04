#!/bin/bash

echo "==============================================="
echo "  Remote Browser - Direct Installation Setup   "
echo "==============================================="

echo "[1/2] Installing system dependencies (requires sudo)..."
echo "This will install Xvfb (Virtual Display), FFmpeg, and PulseAudio."
sudo apt-get update
sudo apt-get install -y xvfb ffmpeg pulseaudio

echo "[2/2] Installing Node.js dependencies..."
npm install

echo "==============================================="
echo "  Setup Complete!                              "
echo "  Run ./run.sh to start the server.            "
echo "==============================================="
