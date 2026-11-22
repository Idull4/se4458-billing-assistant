# Build context: repository root (needs db/schema.sql)
FROM node:22-slim
WORKDIR /app
COPY billing-api/package.json billing-api/package-lock.json ./
RUN npm ci --omit=dev
COPY billing-api/src ./src
COPY billing-api/openapi.yaml ./
COPY db ./db
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "src/server.ts"]
