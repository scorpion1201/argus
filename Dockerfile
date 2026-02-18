ARG NODE_IMAGE=node:20-bookworm-slim
ARG GO_IMAGE=golang:1.25-alpine

FROM ${GO_IMAGE} AS derpprobe-builder
# Keep a pinned default for reproducible builds.
ARG TAILSCALE_VERSION=v1.94.2
RUN apk add --no-cache ca-certificates git
RUN --mount=type=cache,target=/go/pkg/mod \
  --mount=type=cache,target=/root/.cache/go-build \
  go install tailscale.com/cmd/derpprobe@${TAILSCALE_VERSION}

FROM ${NODE_IMAGE} AS node-base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM node-base AS builder
COPY --from=derpprobe-builder /go/bin/derpprobe /usr/local/bin/derpprobe
COPY package.json yarn.lock next.config.mjs tsconfig.json next-env.d.ts ./
RUN yarn install
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY public ./public
RUN yarn build

FROM node-base AS runner
ENV NODE_ENV=production

# The API route executes `derpprobe` via child_process.
COPY --from=derpprobe-builder /go/bin/derpprobe /usr/local/bin/derpprobe

# Copy only runtime artifacts to minimize attack surface.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node
EXPOSE 3000
CMD ["node", "server"]