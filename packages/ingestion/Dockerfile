FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist/ ./dist/

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD test -f /tmp/healthcheck && test $(($(date +%s) - $(cat /tmp/healthcheck))) -lt 60 || exit 1

CMD ["node", "dist/index.js"]
