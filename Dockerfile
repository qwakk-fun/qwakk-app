FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
# Vite's optional Linux bindings are resolved by npm during the container build.
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/package.json /app/package-lock.json ./
# vinext provides the production server binary from devDependencies.
RUN npm ci --include=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/indexer ./indexer
COPY --from=build /app/scripts/start-production.mjs ./scripts/start-production.mjs

EXPOSE 3000 4400

HEALTHCHECK --interval=20s --timeout=8s --start-period=20s --retries=3 CMD if [ "$QORA_PROCESS_ROLE" = "indexer" ]; then wget -q -O /dev/null "http://127.0.0.1:4400/health"; else wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/health"; fi

CMD ["node", "scripts/start-production.mjs"]
