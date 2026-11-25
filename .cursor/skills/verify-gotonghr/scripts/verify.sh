#!/usr/bin/env bash
# Launch, check, drive, and remove one GotongHR verification run.
# Evidence stays under /tmp/gotonghr-verify/$RUN_ID/evidence.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILL="$REPO/.cursor/skills/verify-gotonghr"
COMPOSE_FILE="$REPO/docker/docker-compose.vps.yml"
OVERRIDE_FILE="$SKILL/compose.http.yml"

usage() {
  echo "Usage: verify.sh launch|doctor|drive|cleanup|config [RUN_ID]" >&2
  exit 2
}

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  else
    corepack pnpm "$@"
  fi
}

docker_cli() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
    return
  fi
  if sudo -n docker info >/dev/null 2>&1; then
    sudo -n docker "$@"
    return
  fi
  return 127
}

daemon_up() {
  docker info >/dev/null 2>&1 || sudo -n docker info >/dev/null 2>&1
}

rand_hex() {
  openssl rand -hex "$1"
}

port_listeners() {
  local port="$1"
  ss -ltnH | awk '{print $4}' | grep -E ":${port}$" || true
}

refuse_foreign_ports() {
  local port project
  for port in 80 3000 5432; do
    project="$(docker_cli ps --filter "publish=${port}" --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | head -n 1 || true)"
    if [[ -n "$project" && "$project" != "$PROJECT" ]]; then
      echo "Refusing to start. Port ${port} belongs to compose project ${project}." >&2
      exit 2
    fi
    if [[ -n "$(port_listeners "$port")" && "$project" != "$PROJECT" ]]; then
      echo "Refusing to start. Port ${port} is already in use." >&2
      exit 2
    fi
  done
}

write_secrets() {
  umask 077
  local kek auth storage pg migrator app platform queue owner
  kek="$(rand_hex 32)"
  auth="$(rand_hex 32)"
  storage="$(rand_hex 24)"
  pg="$(rand_hex 16)"
  migrator="$(rand_hex 16)"
  app="$(rand_hex 16)"
  platform="$(rand_hex 16)"
  queue="$(rand_hex 16)"
  owner="$(rand_hex 16)"
  cat > "$ROOT/verify.env" <<EOF
POSTGRES_PASSWORD=${pg}
MIGRATOR_PASSWORD=${migrator}
APP_PASSWORD=${app}
PLATFORM_PASSWORD=${platform}
QUEUE_PASSWORD=${queue}
GOTONG_BOOTSTRAP_EMAIL=owner@gotonghr.local
GOTONG_BOOTSTRAP_PASSWORD=${owner}
GOTONG_BOOTSTRAP_TENANT_NAME=GotongHR
GOTONG_BOOTSTRAP_OWNER_NAME=Owner
BETTER_AUTH_SECRET=${auth}
BETTER_AUTH_URL=${BASE_URL}
GOTONG_PII_KEK=${kek}
STORAGE_DRIVER=local
STORAGE_LOCAL_SECRET=${storage}
QUEUE_DRIVER=pgboss
GOTONG_ROLE=monolith
GOTONG_DEPLOYMENT_MODE=single_tenant
AUDIT_HASH_CHAIN=on
EOF
}

dc() {
  docker_cli compose \
    --project-name "$PROJECT" \
    --env-file "$ROOT/verify.env" \
    -f "$COMPOSE_FILE" \
    -f "$OVERRIDE_FILE" \
    "$@"
}

load_run() {
  local run_id="${1:-${GOTONG_VERIFY_RUN_ID:-}}"
  if [[ -z "$run_id" ]]; then
    echo "Set GOTONG_VERIFY_RUN_ID or pass the run id." >&2
    exit 2
  fi
  if [[ ! "$run_id" =~ ^[a-z0-9-]+$ ]]; then
    echo "Run id must be lowercase letters, digits, and hyphens." >&2
    exit 2
  fi
  RUN_ID="$run_id"
  PROJECT="gotonghr-verify-${RUN_ID}"
  ROOT="/tmp/gotonghr-verify/${RUN_ID}"
  EVIDENCE="${ROOT}/evidence"
  if [[ ! -f "$ROOT/stack.env" ]]; then
    echo "No stack.env for ${RUN_ID}." >&2
    exit 2
  fi
  # shellcheck disable=SC1090
  set -a
  source "$ROOT/stack.env"
  set +a
  if [[ "${PROJECT_NAME:-}" != "$PROJECT" ]]; then
    echo "Refusing to use stack.env for ${PROJECT_NAME:-missing}." >&2
    exit 2
  fi
}

assert_project_stamp() {
  local stamp
  stamp="$(<"$ROOT/project")"
  if [[ "$stamp" != "$PROJECT" ]]; then
    echo "Refusing to touch project ${stamp}." >&2
    exit 2
  fi
  case "$PROJECT" in
    gotonghr-verify-*) ;;
    *)
      echo "Refusing to touch project ${PROJECT}." >&2
      exit 2
      ;;
  esac
}

cmd_config() {
  local tmp name node_env
  tmp="$(mktemp)"
  umask 077
  cat > "$tmp" <<EOF
POSTGRES_PASSWORD=config-only-pg
MIGRATOR_PASSWORD=config-only-migrator
APP_PASSWORD=config-only-app
PLATFORM_PASSWORD=config-only-platform
QUEUE_PASSWORD=config-only-queue
GOTONG_BOOTSTRAP_EMAIL=owner@gotonghr.local
GOTONG_BOOTSTRAP_PASSWORD=config-only-owner
GOTONG_BOOTSTRAP_TENANT_NAME=GotongHR
GOTONG_BOOTSTRAP_OWNER_NAME=Owner
BETTER_AUTH_SECRET=config-only-auth-secret-0123456789abcdef
BETTER_AUTH_URL=http://127.0.0.1
GOTONG_PII_KEK=$(printf 'ab%.0s' {1..32})
STORAGE_LOCAL_SECRET=config-only-storage-secret-0123456789
EOF
  docker_cli compose \
    --project-name gotonghr-verify-config \
    --env-file "$tmp" \
    -f "$COMPOSE_FILE" \
    -f "$OVERRIDE_FILE" \
    config --format json > "$ROOT_CONFIG_JSON"
  rm -f "$tmp"
  python3 - "$ROOT_CONFIG_JSON" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
env = doc["services"]["api"]["environment"]
if isinstance(env, list):
    env = dict(item.split("=", 1) for item in env)
print("config_exit=0")
print("name=" + str(doc.get("name", "")))
print("api_node_env=" + str(env.get("NODE_ENV", "")))
print("services=" + ",".join(sorted(doc["services"])))
PY
  rm -f "$ROOT_CONFIG_JSON"
}

cmd_launch() {
  RUN_ID="${GOTONG_VERIFY_RUN_ID:-$(date -u +%Y%m%dt%H%M%Sz)-$$}"
  RUN_ID="$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
  if [[ ! "$RUN_ID" =~ ^[a-z0-9-]+$ ]]; then
    echo "Run id must be lowercase letters, digits, and hyphens." >&2
    exit 2
  fi
  PROJECT="gotonghr-verify-${RUN_ID}"
  ROOT="/tmp/gotonghr-verify/${RUN_ID}"
  EVIDENCE="${ROOT}/evidence"
  mkdir -p "$EVIDENCE"
  printf '%s\n' "$PROJECT" > "$ROOT/project"
  if daemon_up; then
    launch_compose
  else
    echo "Docker daemon is not available. Starting the process stand-in." >&2
    launch_process
  fi
  echo "RUN_ID=${RUN_ID}"
  echo "EVIDENCE=${EVIDENCE}"
  echo "BASE_URL=${BASE_URL}"
  echo "MODE=${MODE}"
}

launch_compose() {
  BASE_URL="http://127.0.0.1"
  MODE="compose"
  refuse_foreign_ports
  write_secrets
  ROOT_CONFIG_JSON="$ROOT/compose.config.json"
  docker_cli compose \
    --project-name "$PROJECT" \
    --env-file "$ROOT/verify.env" \
    -f "$COMPOSE_FILE" \
    -f "$OVERRIDE_FILE" \
    config --format json > "$ROOT_CONFIG_JSON"
  python3 - "$ROOT_CONFIG_JSON" "$PROJECT" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
env = doc["services"]["api"]["environment"]
if isinstance(env, list):
    env = dict(item.split("=", 1) for item in env)
if doc.get("name") != sys.argv[2]:
    raise SystemExit("compose project name mismatch")
if env.get("NODE_ENV") != "development":
    raise SystemExit("api NODE_ENV is not development")
print("compose_config=ok")
PY
  rm -f "$ROOT_CONFIG_JSON"
  dc up -d --build --wait --wait-timeout 600
  dc exec -T api node dist/entrypoints/bootstrap.js
  local pg_map caddy_map
  pg_map="$(dc port postgres 5432)"
  caddy_map="$(dc port caddy 8080)"
  pg_map="${pg_map%%$'\n'*}"
  caddy_map="${caddy_map%%$'\n'*}"
  write_stack compose "$pg_map" "$caddy_map"
}

launch_process() {
  MODE="process"
  local pgport=55432 apiport=13000 webport=18080
  while [[ -n "$(port_listeners "$pgport")" ]]; do pgport=$((pgport + 1)); done
  while [[ -n "$(port_listeners "$apiport")" ]]; do apiport=$((apiport + 1)); done
  while [[ -n "$(port_listeners "$webport")" ]]; do webport=$((webport + 1)); done
  BASE_URL="http://127.0.0.1:${webport}"
  write_secrets
  # shellcheck disable=SC1090
  set -a
  source "$ROOT/verify.env"
  set +a
  export DATABASE_URL_SUPERUSER="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${pgport}/gotonghr"
  export DATABASE_URL_MIGRATOR="postgres://gotong_migrator:${MIGRATOR_PASSWORD}@127.0.0.1:${pgport}/gotonghr"
  export DATABASE_URL_APP="postgres://app_tenant:${APP_PASSWORD}@127.0.0.1:${pgport}/gotonghr"
  export DATABASE_URL_PLATFORM="postgres://platform_admin:${PLATFORM_PASSWORD}@127.0.0.1:${pgport}/gotonghr"
  export DATABASE_URL_QUEUE="postgres://gotong_queue:${QUEUE_PASSWORD}@127.0.0.1:${pgport}/gotonghr"
  export NODE_ENV=development
  export HOST=127.0.0.1
  export PORT="$apiport"
  export STORAGE_LOCAL_ROOT="$ROOT/storage"
  export GOTONG_VERIFY_RUN_ID="$RUN_ID"
  start_postgres "$pgport"
  (cd "$REPO" && run_pnpm --filter @gotonghr/api... build && run_pnpm --filter @gotonghr/web build)
  (cd "$REPO/apps/api" && node --experimental-strip-types src/entrypoints/migrate.ts)
  (
    cd "$REPO/apps/api"
    nohup node dist/entrypoints/monolith.js > "$ROOT/api.log" 2>&1 &
    echo $! > "$ROOT/api.pid"
  )
  (
    cd "$REPO"
    GOTONG_VERIFY_WEB_ROOT="$REPO/apps/web/dist" \
      GOTONG_VERIFY_API_ORIGIN="http://127.0.0.1:${apiport}" \
      PORT="$webport" \
      GOTONG_VERIFY_RUN_ID="$RUN_ID" \
      nohup node "$SKILL/scripts/serve-spa.mjs" > "$ROOT/web.log" 2>&1 &
    echo $! > "$ROOT/web.pid"
  )
  wait_http "${BASE_URL}/api/readyz"
  (cd "$REPO/apps/api" && node --experimental-strip-types src/entrypoints/bootstrap.ts)
  write_stack process "127.0.0.1:${pgport}" "127.0.0.1:${webport}"
}

start_postgres() {
  local pgport="$1"
  local bin="/usr/lib/postgresql/18/bin"
  local data="$ROOT/pgdata"
  mkdir -p "$ROOT/pgrun" "$ROOT/storage"
  printf '%s\n' "$POSTGRES_PASSWORD" > "$ROOT/pgpass"
  "$bin/initdb" -D "$data" --username=postgres --pwfile="$ROOT/pgpass" \
    --auth=scram-sha-256 --locale=C.UTF-8 >/dev/null
  printf "\ninclude = '%s'\n" "$REPO/docker/postgres.vps.conf" >> "$data/postgresql.conf"
  if ! "$bin/pg_ctl" -D "$data" -l "$ROOT/pg.log" -w \
    -o "-c listen_addresses=127.0.0.1 -c port=${pgport} -c unix_socket_directories=${ROOT}/pgrun" \
    start >/dev/null; then
    "$bin/pg_ctl" -D "$data" -w stop >/dev/null 2>&1 || true
    sed -i '/postgres.vps.conf/d' "$data/postgresql.conf"
    printf '\nshared_buffers = 128MB\nmax_connections = 40\n' >> "$data/postgresql.conf"
    "$bin/pg_ctl" -D "$data" -l "$ROOT/pg.log" -w \
      -o "-c listen_addresses=127.0.0.1 -c port=${pgport} -c unix_socket_directories=${ROOT}/pgrun" \
      start >/dev/null
    echo "postgres_config=minimal" >> "$ROOT/pg-config.txt"
  else
    echo "postgres_config=vps" >> "$ROOT/pg-config.txt"
  fi
  PGPASSWORD="$POSTGRES_PASSWORD" "$bin/psql" -h 127.0.0.1 -p "$pgport" -U postgres -d postgres \
    -v ON_ERROR_STOP=1 -c "CREATE DATABASE gotonghr"
}

wait_http() {
  local url="$1" i
  for i in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for ${url}." >&2
  exit 1
}

write_stack() {
  local mode="$1" pg_map="$2" caddy_map="$3"
  local pg_port caddy_port super
  pg_port="${pg_map##*:}"
  caddy_port="${caddy_map##*:}"
  if [[ "$mode" == "compose" && "$caddy_port" == "80" ]]; then
    BASE_URL="http://127.0.0.1"
  elif [[ "$mode" == "compose" ]]; then
    BASE_URL="http://127.0.0.1:${caddy_port}"
  fi
  # shellcheck disable=SC1090
  set -a
  source "$ROOT/verify.env"
  set +a
  super="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${pg_port}/gotonghr"
  umask 077
  cat > "$ROOT/stack.env" <<EOF
RUN_ID=${RUN_ID}
PROJECT_NAME=${PROJECT}
MODE=${mode}
BASE_URL=${BASE_URL}
EVIDENCE=${EVIDENCE}
DATABASE_URL_SUPERUSER=${super}
GOTONG_BOOTSTRAP_EMAIL=${GOTONG_BOOTSTRAP_EMAIL}
GOTONG_BOOTSTRAP_PASSWORD=${GOTONG_BOOTSTRAP_PASSWORD}
PG_MAP=${pg_map}
CADDY_MAP=${caddy_map}
EOF
  chmod 600 "$ROOT/stack.env" "$ROOT/verify.env"
}

cmd_doctor() {
  load_run "${1:-}"
  assert_project_stamp
  mkdir -p "$EVIDENCE"
  if [[ "$MODE" == "compose" ]]; then
    doctor_compose
  else
    doctor_process
  fi
  local code
  code="$(curl -sS -o "$EVIDENCE/doctor-readyz.json" -w "%{http_code}" "${BASE_URL}/api/readyz")"
  if [[ "$code" != "200" ]]; then
    echo "readyz returned ${code}." >&2
    exit 1
  fi
  python3 - "$EVIDENCE/doctor-readyz.json" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
if body.get("data", {}).get("status") != "ready":
    raise SystemExit("readyz body is not ready")
PY
  local email
  email="$(awk -F= '/^GOTONG_BOOTSTRAP_EMAIL=/{print $2}' "$ROOT/verify.env")"
  if [[ "$OWNER_EMAIL" != "$email" ]]; then
    echo "Bootstrap owner is '${OWNER_EMAIL}', expected '${email}'." >&2
    exit 1
  fi
  printf '%s\n' "$OWNER_EMAIL" > "$EVIDENCE/doctor-owner.txt"
  echo "doctor=ok"
  echo "readyz=200"
  echo "owner=${OWNER_EMAIL}"
  echo "base_url=${BASE_URL}"
  echo "mode=${MODE}"
}

doctor_compose() {
  local cid label
  cid="$(dc ps -q postgres)"
  if [[ -z "$cid" ]]; then
    echo "This run has no postgres container." >&2
    exit 1
  fi
  label="$(docker_cli inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cid")"
  if [[ "$label" != "$PROJECT" ]]; then
    echo "Refusing to drive compose project ${label}." >&2
    exit 2
  fi
  local caddy_id caddy_label
  caddy_id="$(dc ps -q caddy)"
  caddy_label="$(docker_cli inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$caddy_id")"
  if [[ "$caddy_label" != "$PROJECT" ]]; then
    echo "Refusing to drive compose project ${caddy_label}." >&2
    exit 2
  fi
  dc exec -T postgres pg_isready -U postgres -d gotonghr >/dev/null
  OWNER_EMAIL="$(dc exec -T postgres psql -U postgres -d gotonghr -tA -c "SELECT owner_email FROM id_single_tenant_owner();" | tr -d '[:space:]')"
}

doctor_process() {
  local bin="/usr/lib/postgresql/18/bin"
  if ! "$bin/pg_ctl" -D "$ROOT/pgdata" status >/dev/null; then
    echo "Postgres for this run is not running." >&2
    exit 1
  fi
  own_pid "$ROOT/api.pid" "monolith.js"
  own_pid "$ROOT/web.pid" "serve-spa.mjs"
  local pg_port
  pg_port="${PG_MAP##*:}"
  # shellcheck disable=SC1090
  set -a
  source "$ROOT/verify.env"
  set +a
  PGPASSWORD="$POSTGRES_PASSWORD" "$bin/pg_isready" -h 127.0.0.1 -p "$pg_port" -U postgres -d gotonghr >/dev/null
  OWNER_EMAIL="$(PGPASSWORD="$POSTGRES_PASSWORD" "$bin/psql" -h 127.0.0.1 -p "$pg_port" -U postgres -d gotonghr -tA -c "SELECT owner_email FROM id_single_tenant_owner();" | tr -d '[:space:]')"
}

own_pid() {
  local file="$1" needle="$2" pid
  pid="$(<"$file")"
  if [[ ! -d "/proc/${pid}" ]]; then
    echo "Process ${pid} is not running." >&2
    exit 1
  fi
  if ! tr '\0' ' ' < "/proc/${pid}/cmdline" | grep -q "$needle"; then
    echo "Process ${pid} is not ${needle}." >&2
    exit 2
  fi
  if ! tr '\0' '\n' < "/proc/${pid}/environ" | grep -qx "GOTONG_VERIFY_RUN_ID=${RUN_ID}"; then
    echo "Process ${pid} is not run ${RUN_ID}." >&2
    exit 2
  fi
}

cmd_drive() {
  load_run "${1:-}"
  assert_project_stamp
  cmd_doctor "$RUN_ID"
  if [[ ! -d "$REPO/node_modules" ]]; then
    (cd "$REPO" && run_pnpm install --frozen-lockfile)
  fi
  (cd "$REPO/apps/web" && run_pnpm exec playwright install chromium)
  # shellcheck disable=SC1090
  set -a
  source "$ROOT/stack.env"
  set +a
  node "$SKILL/scripts/drive-employee.mjs"
}

cmd_cleanup() {
  local requested="${1:-${GOTONG_VERIFY_RUN_ID:-}}"
  if [[ -z "$requested" ]]; then
    echo "Set GOTONG_VERIFY_RUN_ID or pass the run id." >&2
    exit 2
  fi
  RUN_ID="$requested"
  PROJECT="gotonghr-verify-${RUN_ID}"
  ROOT="/tmp/gotonghr-verify/${RUN_ID}"
  EVIDENCE="${ROOT}/evidence"
  if [[ -f "$ROOT/stack.env" ]]; then
    load_run "$RUN_ID"
  else
    MODE="compose"
  fi
  assert_project_stamp
  if [[ "$MODE" == "compose" ]]; then
    dc down -v --remove-orphans
  else
    cleanup_process
  fi
  if [[ -f "$EVIDENCE/03-employee-reload.png" ]]; then
    wc -c "$EVIDENCE/03-employee-reload.png"
  fi
  echo "cleanup=ok"
  echo "evidence=${EVIDENCE}"
}

cleanup_process() {
  stop_owned "$ROOT/web.pid" "serve-spa.mjs"
  stop_owned "$ROOT/api.pid" "monolith.js"
  local bin="/usr/lib/postgresql/18/bin"
  if [[ -d "$ROOT/pgdata" ]]; then
    "$bin/pg_ctl" -D "$ROOT/pgdata" -w stop >/dev/null 2>&1 || true
    rm -rf "$ROOT/pgdata" "$ROOT/pgrun"
  fi
}

stop_owned() {
  local file="$1" needle="$2" pid
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  pid="$(<"$file")"
  if [[ -d "/proc/${pid}" ]] \
    && tr '\0' ' ' < "/proc/${pid}/cmdline" | grep -q "$needle" \
    && tr '\0' '\n' < "/proc/${pid}/environ" | grep -qx "GOTONG_VERIFY_RUN_ID=${RUN_ID}"; then
    kill "$pid" || true
    wait "$pid" 2>/dev/null || true
  fi
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    launch) cmd_launch ;;
    doctor) cmd_doctor "${2:-}" ;;
    drive) cmd_drive "${2:-}" ;;
    cleanup) cmd_cleanup "${2:-}" ;;
    config)
      ROOT_CONFIG_JSON="$(mktemp)"
      cmd_config
      ;;
    *) usage ;;
  esac
}

main "$@"
