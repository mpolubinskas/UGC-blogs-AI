FROM node:20-alpine

WORKDIR /app
COPY server.js ./

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# создаём каталог данных и отдаём его непривилегированному пользователю node.
# При первом создании named-тома Docker копирует сюда владельца/права -> node сможет писать.
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 8080

# лёгкий healthcheck без внешних утилит
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
