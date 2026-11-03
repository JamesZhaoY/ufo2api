FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production UFO_HOME=/data UFO_PROXY_HOST=0.0.0.0 UFO_PROXY_PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node *.js ./
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "require('http').get('http://127.0.0.1:8787/login',r=>{r.resume();process.exit(r.statusCode===200||r.statusCode===302?0:1)}).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
