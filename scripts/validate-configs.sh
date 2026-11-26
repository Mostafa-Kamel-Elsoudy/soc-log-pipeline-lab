#!/usr/bin/env bash
# Validate the repo's configs without root and without touching /etc.
# Runs each real validator that is installed (nginx, rsyslogd, systemd-analyze,
# apparmor_parser, docker compose, node) and cross-checks paths and ports
# between files. Missing validators are reported as SKIP.
# Usage: scripts/validate-configs.sh
# Env:   RSYSLOG_MODDIR  directory holding rsyslog modules, if not the default
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAIL=0

ok()   { printf 'ok    %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; FAIL=1; }
skip() { printf 'SKIP  %s\n' "$1"; }
check() { # check "label" command...
    local label="$1"; shift
    if "$@" >"$TMP/out" 2>&1; then ok "$label"; else bad "$label"; sed 's/^/      /' "$TMP/out" | head -15; fi
}
find_bin() { command -v "$1" 2>/dev/null || { [[ -x "/usr/sbin/$1" ]] && echo "/usr/sbin/$1"; } || true; }

echo "== syntax"
for f in scripts/*.sh security/*.sh; do check "bash -n $f" bash -n "$f"; done
if command -v node >/dev/null; then
    check "node --check ingest-api/server.js" node --check ingest-api/server.js
else skip "node not installed"; fi
if python3 -c 'import yaml' 2>/dev/null; then
    check "docker-compose.yml parses as YAML" python3 -c 'import yaml,sys; yaml.safe_load(open("docker-compose.yml"))'
else skip "python3-yaml not installed"; fi

echo "== validators"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    check "docker compose config" docker compose -f docker-compose.yml config -q
else skip "docker compose not installed"; fi

if command -v systemd-analyze >/dev/null; then
    check "systemd-analyze verify watchsoc-ingest.service" systemd-analyze verify systemd/watchsoc-ingest.service
else skip "systemd-analyze not installed"; fi

AAP="$(find_bin apparmor_parser)"
if [[ -n "$AAP" ]]; then
    check "apparmor_parser compiles profile" "$AAP" -Q -K -S security/apparmor/usr.bin.watchsoc-ingest
else skip "apparmor_parser not installed"; fi

NGINX="$(find_bin nginx)"
if [[ -n "$NGINX" ]]; then
    mkdir -p "$TMP/ng/certs" "$TMP/ng/logs"
    scripts/generate-dev-certs.sh watchsoc.local "$TMP/ng/certs" >/dev/null 2>&1
    sed -e "s|/etc/nginx/certs|$TMP/ng/certs|g" -e 's/listen 443/listen 18443/' \
        nginx/watchsoc-proxy.conf > "$TMP/ng/proxy.conf"
    cat > "$TMP/ng/nginx.conf" <<NGX
pid $TMP/ng/nginx.pid;
error_log $TMP/ng/logs/error.log;
events {}
http {
  access_log off;
  client_body_temp_path $TMP/ng/b; proxy_temp_path $TMP/ng/p; fastcgi_temp_path $TMP/ng/f;
  uwsgi_temp_path $TMP/ng/u; scgi_temp_path $TMP/ng/s;
  include $TMP/ng/proxy.conf;
}
NGX
    check "nginx -t (certs, port and temp paths substituted)" "$NGINX" -t -c "$TMP/ng/nginx.conf" -p "$TMP/ng"
else skip "nginx not installed"; fi

RSYSLOGD="$(find_bin rsyslogd)"
if [[ -n "$RSYSLOGD" ]]; then
    mkdir -p "$TMP/rs/spool"
    sed -e "s|/var/spool/rsyslog|$TMP/rs/spool|" rsyslog/50-watchsoc-opensearch.conf > "$TMP/rs/50.conf"
    printf '$IncludeConfig %s\n' "$TMP/rs/50.conf" > "$TMP/rs/main.conf"
    check "rsyslogd -N1 (omelasticsearch needs rsyslog-elasticsearch)" "$RSYSLOGD" -N1 -f "$TMP/rs/main.conf"
else skip "rsyslogd not installed"; fi

echo "== cross-file consistency"
UNIT=systemd/watchsoc-ingest.service
APPARMOR=security/apparmor/usr.bin.watchsoc-ingest
LOGPATH="$(grep -oE 'WATCHSOC_EVENT_LOG=[^[:space:]]+' "$UNIT" | head -1 | cut -d= -f2)"
RWPATHS="$(grep -E '^ReadWritePaths=' "$UNIT" | cut -d= -f2)"
PORT="$(grep -oE 'Environment=PORT=[0-9]+' "$UNIT" | cut -d= -f3)"

[[ -n "$LOGPATH" ]] && ok "unit sets WATCHSOC_EVENT_LOG=$LOGPATH" || bad "unit does not set WATCHSOC_EVENT_LOG"

covered=0
for p in $RWPATHS; do [[ "$LOGPATH" == "$p"/* ]] && covered=1; done
[[ $covered == 1 ]] && ok "event log is inside ReadWritePaths ($RWPATHS)" || bad "event log $LOGPATH is outside ReadWritePaths ($RWPATHS), ProtectSystem=strict would block writes"

grep -qE "^[[:space:]]*$LOGPATH[[:space:]]+rw" "$APPARMOR" \
    && ok "AppArmor allows rw on the event log" || bad "AppArmor profile has no rw rule for $LOGPATH"
grep -qF "File=\"$LOGPATH\"" rsyslog/50-watchsoc-opensearch.conf \
    && ok "rsyslog tails the event log" || bad "rsyslog has no imfile input for $LOGPATH"
grep -q '^AppArmorProfile=watchsoc-ingest$' "$UNIT" && grep -q '^profile watchsoc-ingest' "$APPARMOR" \
    && ok "unit AppArmorProfile matches profile name" || bad "AppArmorProfile name mismatch between unit and profile"
grep -q '^User=watchsoc$' "$UNIT" && grep -q 'useradd --system.* watchsoc' README.md \
    && ok "README creates the unit's user" || bad "unit user is not created in README"
grep -qE 'install .* -g adm .*watchsoc-ingest.log' README.md \
    && ok "event log group is adm so rsyslog (syslog:adm) can read it" || bad "README does not give rsyslog read access to the event log"

grep -q "proxy_pass http://127.0.0.1:${PORT}/;" nginx/watchsoc-proxy.conf \
    && ok "nginx /api/ upstream matches unit PORT=$PORT" || bad "nginx /api/ upstream does not match unit PORT=$PORT"
grep -q 'proxy_pass http://127.0.0.1:5601;' nginx/watchsoc-proxy.conf && grep -q '127.0.0.1:5601:5601' docker-compose.yml \
    && ok "nginx / upstream matches Dashboards port 5601" || bad "nginx / upstream and compose port 5601 differ"

if grep -nE '^[[:space:]]*-[[:space:]]*"?[0-9]+:[0-9]+' docker-compose.yml | grep -vq '127.0.0.1:'; then
    bad "a compose port is not bound to 127.0.0.1"
else ok "every compose port is bound to 127.0.0.1"; fi

first_server="$(grep -n '^server {' nginx/watchsoc-proxy.conf | head -1 | cut -d: -f1)"
last_zone="$(grep -n 'limit_req_zone' nginx/watchsoc-proxy.conf | tail -1 | cut -d: -f1)"
[[ -n "$first_server" && -n "$last_zone" && "$last_zone" -lt "$first_server" ]] \
    && ok "limit_req_zone and map are at http level, before the server block" || bad "limit_req_zone must sit outside server {}"
for z in $(grep -oE 'limit_req zone=[a-z_]+' nginx/watchsoc-proxy.conf | cut -d= -f2); do
    grep -q "zone=$z:" nginx/watchsoc-proxy.conf || bad "limit_req uses undefined zone $z"
done

echo
if [[ $FAIL == 0 ]]; then echo "All checks passed."; else echo "Some checks failed."; fi
exit $FAIL
