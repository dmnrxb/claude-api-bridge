#!/usr/bin/env bash
# Claude API Bridge installer.
#
#   sudo ./install.sh                  from a checkout
#   curl -fsSL <raw url> | sudo bash   from the repository
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/dmnrxb/claude-api-bridge.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/claude-api-bridge}"
BIN_PATH="${BIN_PATH:-/usr/local/bin/claude-bridge}"
ASSUME_YES="${ASSUME_YES:-0}"
DO_UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    --dir=*) INSTALL_DIR="${arg#*=}" ;;
    -h|--help)
      cat <<'USAGE'
Usage: install.sh [options]

  -y, --yes        accept the defaults, do not ask
      --dir=PATH   install somewhere other than /opt/claude-api-bridge
      --uninstall  stop the service and remove it

Environment: REPO_URL, INSTALL_DIR, BIN_PATH, BRIDGE_PORT, BRIDGE_BIND,
PROXY_MODE (1 existing proxy, 2 caddy, 3 plain http), BRIDGE_DOMAIN,
BRIDGE_EMAIL, CLAUDE_TOKEN, FIRST_KEY_NAME.
USAGE
      exit 0
      ;;
  esac
done

# -- output ----------------------------------------------------------------

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YEL=$'\033[33m'; R=$'\033[0m'
else
  B=""; DIM=""; RED=""; GREEN=""; YEL=""; R=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s\n' "$B" "$R" "$B" "$*$R"; }
info() { printf '    %s%s%s\n' "$DIM" "$*" "$R"; }
warn() { printf '    %s%s%s\n' "$YEL" "$*" "$R"; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }

ask() {
  # ask <prompt> <default> -> echoes the answer
  local prompt="$1" default="${2:-}" answer
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
    printf '%s' "$default"
    return
  fi
  read -r -p "    $prompt [$default]: " answer </dev/tty || true
  printf '%s' "${answer:-$default}"
}

confirm() {
  local prompt="$1" answer
  [ "$ASSUME_YES" = "1" ] && return 0
  [ ! -t 0 ] && return 0
  read -r -p "    $prompt [Y/n]: " answer </dev/tty || true
  case "${answer:-y}" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# -- checks ----------------------------------------------------------------

[ "$(id -u)" = "0" ] || die "run this as root, for example: sudo ./install.sh"

case "$(uname -s)" in
  Linux) ;;
  *) warn "This is written for a Linux server. Other systems may work but are not tested." ;;
esac

# -- uninstall -------------------------------------------------------------

if [ "$DO_UNINSTALL" = "1" ]; then
  step "Removing the Claude API Bridge"
  if [ -d "$INSTALL_DIR" ]; then
    (cd "$INSTALL_DIR" && docker compose down --remove-orphans) || true
    if confirm "Delete $INSTALL_DIR including the database and all statistics?"; then
      rm -rf "$INSTALL_DIR"
      say "    Removed $INSTALL_DIR"
    else
      say "    Kept $INSTALL_DIR. The container is stopped."
    fi
  fi
  rm -f "$BIN_PATH"
  say "    Removed $BIN_PATH"
  say ""
  exit 0
fi

step "Checking what is already here"

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker is not installed."
  if confirm "Install it now with the official script from get.docker.com?"; then
    curl -fsSL https://get.docker.com | sh
  else
    die "Docker is required. Install it and run this again."
  fi
fi

docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing, install docker-compose-plugin"

COMPOSE_VER="$(docker compose version --short 2>/dev/null || echo 0)"
info "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), compose $COMPOSE_VER"

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v openssl >/dev/null 2>&1 || die "openssl is required"

# -- sources ---------------------------------------------------------------

step "Putting the files in place"

SCRIPT_DIR="$(
  source_dir="$(dirname "${BASH_SOURCE[0]:-$0}")"
  if cd "$source_dir" 2>/dev/null; then pwd; fi
)"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/Dockerfile" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
    info "copying from $SCRIPT_DIR"
    mkdir -p "$INSTALL_DIR"
    tar -C "$SCRIPT_DIR" --exclude=.git --exclude=data --exclude=node_modules -cf - . \
      | tar -C "$INSTALL_DIR" -xf -
  else
    info "already in $INSTALL_DIR"
  fi
elif [ -d "$INSTALL_DIR/.git" ]; then
  info "updating the checkout in $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  command -v git >/dev/null 2>&1 || die "git is required to clone $REPO_URL"
  info "cloning $REPO_URL"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
mkdir -p data

# -- settings --------------------------------------------------------------

step "Settings"

BRIDGE_PORT="${BRIDGE_PORT:-$(ask 'Port on the host' 8787)}"

if [ -z "${PROXY_MODE:-}" ]; then
  cat <<'CHOICES'

    How should the bridge be reached?

      1  I already run a reverse proxy (nginx, Traefik, Apache)
         The bridge binds to 127.0.0.1 and you get a ready made nginx block.

      2  Set up TLS for me
         Caddy runs alongside and gets a certificate. Needs a domain pointing
         at this server and ports 80 and 443 free.

      3  Plain HTTP on the port above
         For a private network, a VPN or an SSH tunnel. No encryption.

CHOICES
  PROXY_MODE="$(ask 'Choose 1, 2 or 3' 1)"
fi

case "$PROXY_MODE" in
  1) BRIDGE_BIND="127.0.0.1"; PROFILE="proxy" ;;
  2)
    BRIDGE_BIND="127.0.0.1"; PROFILE="caddy"
    case "$COMPOSE_VER" in
      v2.2[4-9]*|v2.[3-9][0-9]*|v[3-9]*) ;;
      *) warn "Caddy mode needs docker compose v2.24 or newer, found $COMPOSE_VER." ;;
    esac
    BRIDGE_DOMAIN="${BRIDGE_DOMAIN:-$(ask 'Domain that points at this server' '')}"
    [ -n "$BRIDGE_DOMAIN" ] || die "a domain is needed for automatic TLS, or pick option 1 or 3"
    BRIDGE_EMAIL="${BRIDGE_EMAIL:-$(ask 'Email for the certificate account (optional)' '')}"
    ;;
  3) BRIDGE_BIND="${BRIDGE_BIND:-0.0.0.0}"; PROFILE="plain" ;;
  *) die "unknown choice \"$PROXY_MODE\"" ;;
esac

# -- env -------------------------------------------------------------------

step "Writing the configuration"

if [ -f .env ]; then
  info "keeping the existing .env, only the port and bind address are updated"
  SECRET="$(grep -E '^BRIDGE_SECRET_KEY=' .env | cut -d= -f2- || true)"
  cp .env ".env.backup.$(date +%Y%m%d%H%M%S)"
else
  SECRET=""
fi

[ -n "$SECRET" ] || SECRET="$(openssl rand -base64 48 | tr -d '\n')"

if [ -f .env ]; then
  sed -i -E "s|^BRIDGE_PORT=.*|BRIDGE_PORT=$BRIDGE_PORT|; s|^BRIDGE_BIND=.*|BRIDGE_BIND=$BRIDGE_BIND|" .env
  grep -q '^BRIDGE_SECRET_KEY=' .env || printf 'BRIDGE_SECRET_KEY=%s\n' "$SECRET" >> .env
else
  sed -E "s|^BRIDGE_PORT=.*|BRIDGE_PORT=$BRIDGE_PORT|; \
          s|^BRIDGE_BIND=.*|BRIDGE_BIND=$BRIDGE_BIND|; \
          s|^BRIDGE_SECRET_KEY=.*|BRIDGE_SECRET_KEY=$SECRET|" .env.example > .env
fi

chmod 600 .env
info "wrote $INSTALL_DIR/.env"

printf 'BRIDGE_PROFILE=%s\n' "$PROFILE" > .bridge-profile

if [ "$PROFILE" = "caddy" ]; then
  mkdir -p caddy
  {
    [ -n "${BRIDGE_EMAIL:-}" ] && printf '{\n\temail %s\n}\n\n' "$BRIDGE_EMAIL"
    printf '%s {\n\treverse_proxy bridge:%s\n}\n' "$BRIDGE_DOMAIN" "8787"
  } > caddy/Caddyfile
  info "wrote $INSTALL_DIR/caddy/Caddyfile"
fi

# -- build and start -------------------------------------------------------

step "Building the image"

# The version number is resolved here rather than left as "latest", so the
# build is repeatable and a rebuild picks up a new release.
CLI_VERSION="$(grep -E '^CLAUDE_CODE_VERSION=' .env | cut -d= -f2- || true)"
if [ -z "$CLI_VERSION" ] || [ "$CLI_VERSION" = "latest" ]; then
  CLI_VERSION="$(curl -fsSL https://registry.npmjs.org/@anthropic-ai/claude-code/latest 2>/dev/null \
    | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)"
  CLI_VERSION="${CLI_VERSION:-latest}"
fi
info "node:24-slim and Claude Code $CLI_VERSION, give it a minute"

COMPOSE=(docker compose -f docker-compose.yml)
[ "$PROFILE" = "caddy" ] && COMPOSE+=(-f docker-compose.caddy.yml)

"${COMPOSE[@]}" build --pull --build-arg "CLAUDE_CODE_VERSION=$CLI_VERSION"
"${COMPOSE[@]}" up -d

install -m 0755 bin/claude-bridge "$BIN_PATH"
info "installed $BIN_PATH"

# Wait for the service before touching the database through the CLI.
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$BRIDGE_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

# -- account ---------------------------------------------------------------

step "Claude account"

cat <<'TOKEN'
    The bridge signs in as you. On a machine where you are already logged in
    to Claude Code, run:

        claude setup-token

    and paste the result here. You can skip this and add it later with
    "claude-bridge accounts add <name>".

TOKEN

TOKEN_VALUE="${CLAUDE_TOKEN:-}"
if [ -z "$TOKEN_VALUE" ] && [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
  read -rs -p "    Token (leave empty to skip): " TOKEN_VALUE </dev/tty || true
  echo
fi

if [ -n "$TOKEN_VALUE" ]; then
  printf '%s' "$TOKEN_VALUE" | "${COMPOSE[@]}" exec -T bridge node src/cli.mjs accounts add primary
else
  warn "no account configured yet, the bridge will answer 503 until you add one"
fi

# -- first key -------------------------------------------------------------

step "First API key"

FIRST_KEY_NAME="${FIRST_KEY_NAME:-default}"
KEY_OUTPUT="$("${COMPOSE[@]}" exec -T bridge node src/cli.mjs keys add "$FIRST_KEY_NAME" 2>&1 || true)"
API_KEY="$(printf '%s' "$KEY_OUTPUT" | grep -oE 'cb-[A-Za-z0-9_-]+' | head -1 || true)"

if [ -n "$API_KEY" ]; then
  say ""
  printf '    %sYour API key, shown once:%s\n\n        %s%s%s\n\n' "$B" "$R" "$GREEN" "$API_KEY" "$R"
else
  info "a key named \"$FIRST_KEY_NAME\" already exists, create another with: claude-bridge keys add <name>"
fi

# -- summary ---------------------------------------------------------------

step "Done"

case "$PROFILE" in
  proxy)
    BASE="http://127.0.0.1:$BRIDGE_PORT"
    cat <<NGINX

    The bridge listens on 127.0.0.1:$BRIDGE_PORT. Point your proxy at it. For
    nginx, inside a server block that already has TLS:

        location /v1/ {
            proxy_pass http://127.0.0.1:$BRIDGE_PORT;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;

            # Streaming answers arrive piece by piece. Without these two nginx
            # holds them back and the stream arrives in one lump at the end.
            proxy_buffering off;
            proxy_cache off;

            # A long answer can take minutes.
            proxy_read_timeout 600s;
            proxy_send_timeout 600s;
        }

    The same block is in docs/nginx.conf.example.
NGINX
    ;;
  caddy)
    BASE="https://$BRIDGE_DOMAIN"
    say ""
    info "Caddy is getting a certificate for $BRIDGE_DOMAIN. Give it a moment."
    ;;
  plain)
    BASE="http://$(hostname -I 2>/dev/null | awk '{print $1}'):$BRIDGE_PORT"
    say ""
    warn "This is plain HTTP. Keep it on a private network or behind a VPN."
    ;;
esac

cat <<SUMMARY

    Base URL     $BASE/v1
    Try it       curl $BASE/v1/models -H "Authorization: Bearer <key>"

    claude-bridge status          what is configured
    claude-bridge stats           usage
    claude-bridge keys add <name> another key
    claude-bridge accounts add <name>
    claude-bridge logs -f         follow the logs

SUMMARY
