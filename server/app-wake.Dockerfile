FROM node:24-alpine
WORKDIR /app
COPY app-wake.mjs ./
ENV NODE_ENV=production PORT=8082
EXPOSE 8082
CMD ["node", "app-wake.mjs"]
