# MellowDo: API and web app in one container. The SQLite database lives on /data.
FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production PORT=3300 DB_FILE=/data/mellowdo.db NODE_NO_WARNINGS=1
COPY package.json ./
COPY server ./server
COPY web ./web
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
EXPOSE 3300
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
