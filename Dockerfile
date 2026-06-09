FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S zer0 && adduser -S zer0 -G zer0
COPY --from=deps --chown=zer0:zer0 /app/node_modules ./node_modules
COPY --chown=zer0:zer0 package*.json ./
COPY --chown=zer0:zer0 src ./src
USER zer0
EXPOSE 3000
CMD ["node", "src/server.js"]
