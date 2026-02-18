ARG NODE_IMAGE=node:24-alpine
ARG GO_IMAGE=golang:1.25-alpine

FROM ${GO_IMAGE} AS derpprobe-builder
ARG TAILSCALE_VERSION=v1.94.2
RUN apk add --no-cache ca-certificates git
RUN --mount=type=cache,target=/go/pkg/mod \
  --mount=type=cache,target=/root/.cache/go-build \
  go install tailscale.com/cmd/derpprobe@${TAILSCALE_VERSION}

FROM ${NODE_IMAGE} AS dev
RUN apk add --no-cache zsh ca-certificates \
  && update-ca-certificates
RUN corepack enable && corepack prepare yarn@stable --activate
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=derpprobe-builder /go/bin/derpprobe /usr/local/bin/derpprobe

EXPOSE 3000
CMD ["yarn", "dev", "-H", "0.0.0.0", "-p", "3000"]