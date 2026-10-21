# Production Dockerfile for getu-server with Playwright Chromium support
FROM node:22-bookworm-slim

# Install system dependencies required for Playwright / Chromium headless automation
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json* ./

# Install production and build dependencies
RUN npm install

# Install Playwright browser binary
RUN npx playwright install chromium

# Copy application source code
COPY . .

# Build TypeScript to dist/
RUN npm run build

# Default environment configuration
ENV NODE_ENV=production
ENV PORT=5000
ENV HOST=0.0.0.0
ENV DATA_STORE=file
ENV AUTOMATION_MODE=dry-run
ENV AI_ENGINE=offline

EXPOSE 5000

# Start server
CMD ["node", "dist/index.js"]
