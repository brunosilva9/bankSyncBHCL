FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-slim
WORKDIR /app/server
ENV NODE_ENV=production
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
COPY --from=web /app/web/dist /app/web/dist
# data/: bases cifradas. backups/: lo que deja "npm run backup" (path.dirname(DB_PATH)/../backups).
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups
VOLUME /app/data /app/backups
EXPOSE 3001
USER node
CMD ["npx", "tsx", "src/index.ts"]
