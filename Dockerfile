# syntax=docker/dockerfile:1
#
# The settlement service and its dashboard, in one image. Two stages: the first builds the React
# dashboard, the second carries only what runs - the server, its runtime dependencies and the
# built dashboard - as an unprivileged user.

FROM node:22-slim AS build
WORKDIR /app

# Package manifests first, so dependencies are only reinstalled when they change, not on every
# edit to the source.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/mesh/package.json packages/mesh/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build


FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/mesh/package.json packages/mesh/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# Runtime dependencies only. The throwaway PostgreSQL used by tests and the local demo is a
# development dependency and stays out: in a container the database is a real one.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY packages ./packages
COPY apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist

# The service holds private keys in memory once it has loaded them. It does not need root to do
# that, and a process that cannot write to the image is a smaller thing to lose.
USER node

EXPOSE 3100
CMD ["node", "apps/server/src/index.js"]
