# ALKAO — one image for the API and every worker.
#   docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) -t alkao .
#   docker run --env-file .env -p 8787:8787 alkao                          # API, /ops, /billets, /acheter
#   docker run --env-file .env alkao node --import tsx scripts/sweeper.ts  # same image, a worker
# One container that also migrates and runs the background jobs (Coolify,
# docs/ALKAO_DEPLOY_COOLIFY.md): ALKAO_MIGRATE_ON_START=true and ALKAO_RUN_WORKERS=true.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY catalogs ./catalogs
COPY supabase ./supabase
COPY contracts ./contracts
COPY ops-ui ./ops-ui
COPY buyer-ui ./buyer-ui
COPY shop-ui ./shop-ui
COPY widget ./widget
COPY home-ui ./home-ui
# Run 62: the release's commit for /health. Coolify passes SOURCE_COMMIT when "Include Source
# Commit in Build" is on; last, so a new commit does not rebuild the layers above.
ARG SOURCE_COMMIT=""
ENV ALKAO_BUILD_ID=$SOURCE_COMMIT
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "scripts/container.ts"]
