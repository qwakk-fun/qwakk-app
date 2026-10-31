FROM node:22-alpine

WORKDIR /app

COPY indexer/package.json indexer/package-lock.json ./
RUN npm ci

COPY indexer ./indexer

EXPOSE 4400

# /livez only says the process answers. /health is 503 while the indexer lags or stalls, which would restart it mid catch-up.
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:4400/livez

CMD ["node", "--import", "tsx", "indexer/server.ts"]
