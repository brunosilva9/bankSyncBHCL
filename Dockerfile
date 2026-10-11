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
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
EXPOSE 3001
USER node
CMD ["npx", "tsx", "src/index.ts"]
