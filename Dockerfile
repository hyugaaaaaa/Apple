FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY relay ./relay

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "relay/broker.js"]
