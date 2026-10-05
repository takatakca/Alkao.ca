# ALKAO — one image for the API and every worker.
#   docker build -t alkao .
#   docker run --env-file .env -p 8787:8787 alkao                          # API, /ops, /billets, /acheter
#   docker run --env-file .env alkao node --import tsx scripts/sweeper.ts  # same image, a worker
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY supabase ./supabase
COPY contracts ./contracts
COPY ops-ui ./ops-ui
COPY buyer-ui ./buyer-ui
COPY shop-ui ./shop-ui
COPY widget ./widget
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
