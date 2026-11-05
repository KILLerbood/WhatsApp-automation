FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js linked.js index.html login.html ./
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
