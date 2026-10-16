# syntax=docker/dockerfile:1

FROM node:22.17.0-alpine AS base

WORKDIR /app

ENV NODE_ENV=production

# Security / runtime dependencies
RUN apk add --no-cache dumb-init

# Persistent directories must exist *and* be owned by the runtime user in every
# stage. Compose mounts named volumes over /app/data and /app/backups; when the
# mount point is missing from the image Docker creates the volume as root:root,
# which the `node` user (uid 1000) cannot write to -> SQLite errcode 14
# "unable to open database file".
RUN mkdir -p /app/data /app/backups && \
    chown node:node /app/data /app/backups

# --------------------------------------------------------------------
# Dependencies
# --------------------------------------------------------------------
FROM base AS dependencies

COPY package*.json ./

# Install exactly what's in package-lock.json
RUN npm ci --omit=dev && \
    npm cache clean --force && \
    mkdir -p /app/node_modules

# --------------------------------------------------------------------
# Development image
# --------------------------------------------------------------------
FROM base AS development

ENV NODE_ENV=development

COPY package*.json ./

RUN npm ci && \
    npm cache clean --force

COPY . .

# Run as the built-in non-root node user
USER node

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]

CMD ["npm", "start"]

# --------------------------------------------------------------------
# Production image
# --------------------------------------------------------------------
FROM base AS production

COPY --from=dependencies /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY scripts ./scripts
# server.js serves the UI from ../public relative to the module (i.e. /app/public)
COPY public ./public

# If your application requires these directories at runtime,
# they will be created and owned by node.
RUN mkdir -p /app/data /app/backups && \
    chown -R node:node /app

USER node

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "src/server.js"]