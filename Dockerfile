FROM node:20-alpine

# Install su-exec for root → node privilege drop (handles mounted volume permissions).
RUN apk add --no-cache su-exec

WORKDIR /app

# Install dependencies first to leverage Docker build cache.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Copy the rest of the source. Assegniamo node:node così l'utente `node`
# del container è proprietario (utile per `docker exec` e per coerenza).
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node entrypoint.sh ./
# Forza il bit di esecuzione: git-download non sempre preserva +x (soprattutto
# quando Portainer clona la repo o scarica lo zip da GitHub).
RUN chmod +x /app/entrypoint.sh

# NB: /data e /data/photos li crea e chown-a `entrypoint.sh` a ogni avvio,
# perché a runtime sono sovrascitti dal volume `vinidata`.

# Healthcheck: start-period generoso perché il primo boot deve
# scaldare la cache di rete per jimp & sql.js.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/api/stats || exit 1

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "--max-old-space-size=128", "server.js"]
