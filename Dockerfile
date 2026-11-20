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
ENV NODE_ENV=production
ENV SMART_ROUTER_CONFIG=/app/config/default.yaml
ENV SMART_ROUTER_VAULT_PATH=/app/data/vault.json
ENV SMART_ROUTER_STUB_MODE=true
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
RUN mkdir -p /app/data
EXPOSE 18765
CMD ["node", "dist/index.js"]
