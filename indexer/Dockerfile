FROM node:22-alpine

WORKDIR /app

COPY indexer/package.json indexer/package-lock.json ./
RUN npm ci

COPY indexer ./indexer

EXPOSE 4400

CMD ["node", "--import", "tsx", "indexer/server.ts"]
