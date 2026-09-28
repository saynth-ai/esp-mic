# ---- build: compile TypeScript -------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY tools ./tools
RUN npm run build && npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine
# tzdata: recording filenames use local time, set with TZ=Europe/Berlin etc.
# lame:   MP3 encoder for RECORDING_FORMAT=mp3 (~300 KB)
RUN apk add --no-cache tzdata lame
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    RECORDINGS_DIR=/app/recordings
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
RUN mkdir -p /app/recordings && chown node:node /app/recordings
USER node
EXPOSE 8080
VOLUME ["/app/recordings"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1
# The server finalizes open WAV files on SIGTERM.
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/server.js"]
