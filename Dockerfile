# syntax=docker/dockerfile:1

# Multi-stage build → a minimal, non-root production runtime image.
# Base is pinned to an exact patch (not a floating major) so builds are
# reproducible and image scanning has a deterministic target; bump it
# deliberately when the scanner flags a fixed base CVE. For a fully hardened
# pipeline, pin by digest (node:20.18.0-alpine@sha256:…).

# ── Stage 1: build the client bundle ──
FROM node:20.18.0-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
# The client imports pricing primitives and the xlsx theme from the repo-root
# shared/ directory — e.g. src/logic/stopLossPricing.js pulls
# ../../../shared/pricingMath.js and src/screens/home/exportPortfolio.js
# dynamically imports ../../../../shared/universeXlsxTheme.js. WORKDIR is
# /app/client, so those resolve to /app/shared. Without this COPY the bundle
# never builds: vite fails with "Could not resolve
# ../../../../shared/universeXlsxTheme.js". Copied before the client sources so
# the layer is not invalidated by every client edit.
COPY shared/ /app/shared/
COPY client/ ./
RUN npm run build

# ── Stage 2: install production-only server deps ──
FROM node:20.18.0-alpine AS server-builder
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./

# ── Stage 3: minimal runtime ──
FROM node:20.18.0-alpine AS runner

# tini = tiny init for correct PID 1 behaviour (forwards SIGTERM to node so
# graceful shutdown runs, and reaps any zombies). The runtime installs no other
# OS packages, keeping the attack surface small.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

# Copy only the runtime artifacts, owned by the image's built-in unprivileged
# `node` user (uid/gid 1000) — never root-owned files under a root process.
COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=server-builder /app/server ./server
COPY --chown=node:node --from=client-builder /app/client/dist ./client/dist
# shared/ holds pricing primitives imported by both client and server
# (e.g. server/src/lib/pricingVerifier.js imports ../../../shared/pricingMath.js).
# Without this COPY the runner crashes on first pricing-verifier call with
# MODULE_NOT_FOUND. Keep this COPY in sync if more files land in shared/.
COPY --chown=node:node shared ./shared
COPY --chown=node:node .env.example ./.env.example

# Drop privileges: the process runs as `node`, not root.
USER node

EXPOSE 4000

# Container-level liveness probe. Hits the DB-free /api/health endpoint using
# Node's built-in fetch (no curl/wget in the image). Orchestrators that honour
# HEALTHCHECK (Docker/Compose/Swarm) restart an unhealthy container; Render uses
# healthCheckPath in render.yaml instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini as PID 1 → node as its child, so SIGTERM reaches the graceful-shutdown
# handler (startup/gracefulShutdown.js) and in-flight requests drain cleanly.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.js"]

LABEL org.opencontainers.image.title="Universe 3" \
      org.opencontainers.image.description="Reinsurance treaty pricing & modelling tool" \
      org.opencontainers.image.source="https://github.com/darchville-analytics/modelling_tool" \
      org.opencontainers.image.licenses="UNLICENSED"
