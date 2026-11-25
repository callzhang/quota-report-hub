FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs index.html login.html token-usage.html users.html ./
COPY api ./api
COPY lib ./lib
USER node
CMD ["node", "server.mjs"]
