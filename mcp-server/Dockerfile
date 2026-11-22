# Build context: repository root (needs docs/Mobile_Provider_Billing_Guide.md)
FROM node:22-slim
WORKDIR /app
COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci --omit=dev
COPY mcp-server/src ./src
COPY docs/Mobile_Provider_Billing_Guide.md ./docs/
ENV NODE_ENV=production PORT=3001 MCP_TRANSPORT=http
EXPOSE 3001
CMD ["node", "src/server.ts", "--transport=http"]
