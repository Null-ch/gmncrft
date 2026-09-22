FROM node:22-bookworm-slim

# zip - нужен только для автосборки client-pack.zip при старте (build-client-pack.js).
RUN apt-get update && apt-get install -y --no-install-recommends zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js build-client-pack.js ./

CMD ["node", "server.js"]
