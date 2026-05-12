FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:20-alpine AS server-builder
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=server-builder /app/server ./server
COPY --from=client-builder /app/client/dist ./client/dist
# shared/ holds pricing primitives imported by both client and server
# (e.g. server/src/lib/pricingVerifier.js imports
# ../../../shared/pricingMath.js). Without this COPY the runner crashes
# on first pricing-verifier call with MODULE_NOT_FOUND. The render.yaml
# build runs in-place so this never bit Render; only Docker / local
# compose did. Keep this COPY in sync if more files land in shared/.
COPY shared ./shared
COPY .env.example ./.env.example
EXPOSE 4000
CMD ["node", "server/src/index.js"]
