FROM mcr.microsoft.com/playwright:v1.41.0-jammy

# Set working directory
WORKDIR /app

# Install Xvfb, FFmpeg, and PulseAudio for audio/video streaming
RUN apt-get update && apt-get install -y \
    xvfb \
    ffmpeg \
    pulseaudio \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the API port
EXPOSE 3000

# Start a PulseAudio daemon and the Node.js application under Xvfb
CMD pulseaudio -D --system --disallow-exit && xvfb-run --server-args="-screen 0 1920x1080x24" node server.js
