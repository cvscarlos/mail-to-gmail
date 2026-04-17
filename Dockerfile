FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production \
    STATE_DB_PATH=/data/mail-to-gmail.db \
    CONFIG_PATH=/app/config.yaml

RUN useradd -r -u 10001 -m mailtogmail \
  && mkdir -p /data \
  && chown -R mailtogmail:mailtogmail /data /app

USER mailtogmail

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--max-old-space-size=192", "dist/index.js", "sync"]
