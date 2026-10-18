FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/artempavlov/mcp-pool" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
RUN npm install --global exa-mcp-server@3.4.2 @upstash/context7-mcp@4.3.0
WORKDIR /app
COPY --from=build /build/package.json /opt/mcp-pool/package.json
COPY --from=build /build/node_modules /opt/mcp-pool/node_modules
COPY --from=build /build/dist /opt/mcp-pool/dist
ENTRYPOINT ["node", "/opt/mcp-pool/dist/index.js"]
CMD ["--local", "--config", "/app/mcp-pool.yaml"]
