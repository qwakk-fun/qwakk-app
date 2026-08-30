FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
# Vite's optional Linux bindings are resolved by npm during the container build.
RUN npm install

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/package.json /app/package-lock.json ./
# vinext provides the production server binary from devDependencies.
RUN npm install --include=dev

COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]
