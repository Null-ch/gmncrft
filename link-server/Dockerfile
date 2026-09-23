FROM node:22-bookworm-slim

# zip - автосборка client-pack.zip при старте, unzip - чтение fabric.mod.json модов
# (минимальная версия Fabric Loader для клиента), см. build-client-pack.js.
RUN apt-get update && apt-get install -y --no-install-recommends zip unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js build-client-pack.js rcon.js applications.js ./

CMD ["node", "server.js"]
