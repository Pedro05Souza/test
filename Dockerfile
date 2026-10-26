FROM oven/bun:1.4-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=3000
EXPOSE 3000

USER bun
# Bun's PID-1 handling forwards SIGTERM to the app, which drains workers before exiting.
CMD ["bun", "run", "src/main.ts"]
