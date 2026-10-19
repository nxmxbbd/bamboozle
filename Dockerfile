# syntax=docker/dockerfile:1

# Compile the TypeScript once; the runtime image only gets dist/.
FROM node:22-trixie-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-trixie-slim
LABEL org.opencontainers.image.source="https://github.com/nxmxbbd/bamboozle" \
      org.opencontainers.image.description="LAN-only Apple Home bridge for Bambu Lab 3D printers" \
      org.opencontainers.image.licenses="MIT"

# ffmpeg encodes the camera, fontconfig and Hermit draw the overlay, and the
# Intel VA driver (amd64 only) serves "encoder": "vaapi" when /dev/dri is
# passed in.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-hermit \
      $([ "$(dpkg --print-architecture)" = amd64 ] && echo intel-media-va-driver) \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /src/dist ./dist

# Config, access code and pairing keys live in /data: mount a volume there.
RUN mkdir -m 700 /data && chown node:node /data
ENV NODE_ENV=production \
    BAMBOOZLE_CONFIG=/data/config.json \
    BAMBOOZLE_SERVE_HINT="docker compose up -d && docker compose logs -f bamboozle"
USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve"]
