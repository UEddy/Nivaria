# Nivaria running as Taste Gap only, for a small host. docker-compose.yml runs
# it with the database on a named volume (see "Run with Docker" in README.md).
FROM node:20-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ENABLE_SCRAPER=false \
    PRODUCT_MODE=taste \
    PORT=3000 \
    DATABASE_PATH=/app/data/nivaria.db

WORKDIR /app

# Production dependencies only. --ignore-scripts skips the postinstall that
# installs Chromium and its system packages: the scraper is off in this image,
# and no production dependency needs an install script (sql.js and bcryptjs
# are plain JavaScript and WebAssembly).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY . .

# The database lives on the volume mounted here. An empty named volume takes
# this directory's owner on first mount, so the node user can write to it.
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
