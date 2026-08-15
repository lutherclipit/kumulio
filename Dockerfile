# RabattArchiv-Backend – läuft überall, wo Docker läuft (Railway, Render, VPS …)
FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY public ./public

# Persistente Daten (Nutzer, Posts, Admin-Key) liegen auf einem Volume.
# Das Volume wird beim Hoster angehängt (Railway: UI, Mount /data) –
# ein VOLUME-Keyword hier lehnt Railway ab.
ENV RA_DATA_DIR=/data

EXPOSE 3900
CMD ["node", "server.js"]
