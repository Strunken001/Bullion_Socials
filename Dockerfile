FROM mcr.microsoft.com/playwright:v1.41.0-jammy

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the API port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
