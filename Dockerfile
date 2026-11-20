# Mirevox Smart Router — multi-stage image (no secrets baked in)
# Runtime secrets: SMART_ROUTER_API_KEY + SMART_ROUTER_KEY_* via env / compose;
# vault file lives on the router-data volume only.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    SMART_ROUTER_CONFIG=/app/config/default.yaml \
    SMART_ROUTER_VAULT_PATH=/app/data/vault.json \
    SMART_ROUTER_STUB_MODE=true \
    SMART_ROUTER_HOST=0.0.0.0 \
    SMART_ROUTER_PORT=18765
# Do NOT set SMART_ROUTER_API_KEY or SMART_ROUTER_KEY_* here — inject at runtime.

COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config

RUN mkdir -p /app/data \
  && addgroup -S mirevox \
  && adduser -S -G mirevox mirevox \
  && chown -R mirevox:mirevox /app

USER mirevox
EXPOSE 18765

# node:22 has native fetch; avoids depending on wget/curl in alpine
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:18765/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
