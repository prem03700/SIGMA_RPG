FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/liferpg.db
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
