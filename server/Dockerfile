FROM node:20-alpine
WORKDIR /app

# dependências primeiro (cache de layer)
COPY package*.json ./
RUN npm ci --only=production

# código
COPY server.js ./
COPY routes/ ./routes/
COPY services/ ./services/
# credentials.json NÃO é copiado — vem via env var GOOGLE_CREDENTIALS_JSON no Fly.io

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
