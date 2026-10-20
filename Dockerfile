# SyncBoard backend (Express + Socket.io). The frontend is built separately.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./

EXPOSE 4000
CMD ["node", "server.js"]
