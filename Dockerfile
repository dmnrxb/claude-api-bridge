# Node 24 is the first line where node:sqlite runs without a command line flag,
# which is why the bridge needs no npm dependencies at all.
FROM node:24-slim

# Pinned on purpose. Without a version two builds on the same day can end up
# with two different CLIs. Bump it when you want a newer one.
ARG CLAUDE_CODE_VERSION=2.1.278

# Claude Code looks for git and ripgrep at startup, even with every file tool
# switched off. ca-certificates is for the HTTPS calls it makes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

WORKDIR /app
COPY package.json ./
COPY src ./src

# Claude Code writes a working directory on first run. Without a writable home
# the very first request fails on a write error.
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
