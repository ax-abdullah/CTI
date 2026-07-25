# syntax=docker/dockerfile:1

# --- build stage ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- production deps only ---
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Non-root: the app needs no write access to its own files.
RUN useradd --system --uid 10001 cti
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
USER cti
EXPOSE 3000
# Migrations run at startup (migrationsRun: true); env is provided by the
# orchestrator, so no --env-file here.
CMD ["node", "dist/main.js"]
