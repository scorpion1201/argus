<p align="center">
<img src="argus-logo.png" alt="ARGUS logo" width="300" />
</p>
<h3 align="center">DERP (Designated Encrypted Relay for Packets) monitoring Web UI</h3>
<br/>

## Quick Start (Docker Dev Mode)

```bash
cp .env.example .env.local
docker compose up --build
```

Open: `http://localhost:3000`

Code changes are reflected immediately through volume mounts during development.

## Run Locally (Node)

```bash
cp .env.example .env.local
npm install
npm run dev
```

## Build and Run a Production Image

```bash
docker build -t argus:latest --target runner .
docker run --rm -p 3000:3000 --env-file .env.local argus:latest
```

To pin a specific `derpprobe` version:

```bash
docker build --build-arg TAILSCALE_VERSION=v1.94.2 -t argus:latest --target runner .
```

## Environment Variables

- `DERPPROBE_BIN`: Path to the `derpprobe` binary (default: `derpprobe`)
- `DERPPROBE_ARGS`: Runtime arguments (default: `-once`)
- `DERPPROBE_DERP_MAP`: Private DERP map URL or file URI (optional)
- `DERPPROBE_TIMEOUT_MS`: Timeout in milliseconds (default: `75000`)

Examples:

```bash
# Use a remote URL
DERPPROBE_DERP_MAP=https://example.com/derpmap.json

# Use a local file (docker-compose mounts ./derpmap -> /derpmap)
DERPPROBE_DERP_MAP=file:///derpmap/derpmap.json
```

## Container Layout

- `Dockerfile`
  - `derpprobe-builder`: Builds the `derpprobe` binary with Go
  - `runner`: Production runtime image

## Key Paths

- `app/api/probe/route.ts`: API route that runs `derpprobe`
- `lib/derpprobe.ts`: Process execution, parsing, and status calculation
- `components/dashboard.tsx`: Monitoring UI