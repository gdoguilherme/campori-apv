FROM node:20-alpine
WORKDIR /app

# dependências primeiro (cache de layer)
COPY package*.json ./
RUN npm ci --only=production

# código
COPY server.js ./
COPY routes/ ./routes/
COPY services/ ./services/
COPY middleware/ ./middleware/
# credentials.json e firebase-credentials.json NÃO são copiados — vêm via env vars
# GOOGLE_CREDENTIALS_JSON / FIREBASE_CREDENTIALS_JSON no Fly.io

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
