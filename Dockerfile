# Stage 1: Base with pnpm
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate
WORKDIR /app

# Stage 2: Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/models/package.json packages/models/
COPY packages/tools/package.json packages/tools/
COPY packages/cli/package.json packages/cli/
COPY packages/channels/package.json packages/channels/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
RUN pnpm install --frozen-lockfile

# Stage 3: Build all packages
FROM deps AS build
COPY . .
RUN pnpm -r build

# Stage 4: Production runtime
FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate
WORKDIR /app

# Copy built artifacts and dependencies
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages

# Create data directory
RUN mkdir -p /app/.joule

# Copy entrypoint
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3927

ENV NODE_ENV=production
ENV JOULE_HOST=0.0.0.0
ENV JOULE_PORT=3927

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "packages/cli/dist/bin/joule.js", "serve", "--host", "0.0.0.0"]
