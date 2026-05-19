FROM node:20-alpine

# Build deps needed for better-sqlite3 native module
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (layer cache)
COPY dashboard/package*.json ./
RUN npm ci --only=production

# Copy server code and static assets
COPY dashboard/server.js dashboard/db.js dashboard/auth.js ./
COPY dashboard/public ./public

# Ensure data directory exists
RUN mkdir -p /app/data

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# Run as non-root user
RUN addgroup -g 1001 -S sentinel && adduser -S sentinel -u 1001 -G sentinel
RUN chown -R sentinel:sentinel /app
USER sentinel

EXPOSE 3000

ENV DB_PATH=/app/data/sentinel.db \
    NODE_ENV=production \
    PORT=3000

CMD ["node", "server.js"]
