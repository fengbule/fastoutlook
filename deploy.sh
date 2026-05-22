#!/usr/bin/env sh
set -eu

APP_NAME="fastoutlook"
DEFAULT_PORT="3001"
PORT_VALUE="${PORT:-$DEFAULT_PORT}"
FETCH_CONCURRENCY_VALUE="${FETCH_CONCURRENCY:-5}"
MS_TENANT_VALUE="${MS_TENANT:-consumers}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] Docker is not installed or not in PATH."
  echo "Install Docker first: https://docs.docker.com/get-docker/"
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "[ERROR] Docker Compose is not available."
  echo "Install Docker Compose first: https://docs.docker.com/compose/install/"
  exit 1
fi

if [ ! -f .env ]; then
  cat > .env <<EOF
PORT=$PORT_VALUE
HOST=0.0.0.0
DOCKER=1
FETCH_CONCURRENCY=$FETCH_CONCURRENCY_VALUE
MS_TENANT=$MS_TENANT_VALUE
MS_CLIENT_ID=${MS_CLIENT_ID:-}
MS_CLIENT_SECRET=${MS_CLIENT_SECRET:-}
MS_REDIRECT_URI=${MS_REDIRECT_URI:-http://127.0.0.1:$PORT_VALUE/auth/callback}
EOF
  echo "[OK] Created .env"
else
  echo "[OK] Using existing .env"
fi

$COMPOSE up -d --build

echo ""
echo "[OK] $APP_NAME deployed."
echo "URL: http://127.0.0.1:$PORT_VALUE"
echo "Logs: $COMPOSE logs -f"
echo "Stop: $COMPOSE down"
