FROM node:22-bookworm-slim

# Без apt-get: на VPS нет доступа к deb.debian.org. zip/unzip заменены на link-server/zip.js
# (встроенный zlib), так что образ собирается только из уже скачанного node-образа.

WORKDIR /app
COPY server.js build-client-pack.js zip.js rcon.js applications.js ./

CMD ["node", "server.js"]
