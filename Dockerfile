# Node 24 runs node:sqlite without a flag, so the bridge needs no npm packages.
FROM node:24-slim

# Defaults to the newest CLI. The installer and "claude-bridge rebuild" look up
# the current version number and pass it in, so a rebuild really gets a new one.
ARG CLAUDE_CODE_VERSION=latest

# Claude Code needs git and ripgrep at startup, even with the file tools off.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

WORKDIR /app
COPY package.json ./
COPY src ./src

# Claude Code writes into its home on first run.
RUN mkdir -p /home/node/.claude /data \
  && chown -R node:node /home/node /data /app

USER node
ENV HOME=/home/node \
    NODE_ENV=production \
    BRIDGE_DATA_DIR=/data \
    BRIDGE_PORT=8787 \
    BRIDGE_HOST=0.0.0.0

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BRIDGE_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
