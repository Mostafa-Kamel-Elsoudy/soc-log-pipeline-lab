# soc-log-pipeline-lab

Hardened Ubuntu SOC log ingestion pipeline: rsyslog forwarding to OpenSearch behind an Nginx TLS reverse proxy, with a systemd-managed Node.js ingest API confined by AppArmor and UFW.

Target: Ubuntu 22.04 or 24.04 LTS, single host, 16 GB RAM. This is a lab build. It runs one OpenSearch node with its security plugin disabled and a self-signed certificate.

## Architecture

```
  /var/log/auth.log ------------.
  /var/log/suricata/eve.json ---+--> rsyslog (imfile) --+--> /var/log/soc-structured.json (local copy)
  /var/log/watchsoc-ingest.log -'    host+tenant JSON   |
            ^                                           '--> omelasticsearch (LinkedList disk-assisted queue)
            |                                                         |
  ingest API (node, 127.0.0.1:3000, systemd, AppArmor)                v
            ^                                              OpenSearch 127.0.0.1:9200
            |                                              Dashboards  127.0.0.1:5601 (/dashboards)
            |                                                         ^
  client --TLS 443--> Nginx (rate limit, headers) --------------------'
                       /api/*  -> 127.0.0.1:3000
                       /       -> 127.0.0.1:5601

  UFW: deny incoming; allow 443/tcp; rate-limited SSH.
```

## Layout

| Path | Purpose |
| --- | --- |
| `docker-compose.yml` | OpenSearch 2 (single node, 512 MB heap) and Dashboards, both bound to loopback |
| `rsyslog/50-watchsoc-opensearch.conf` | Inputs, JSON template, local fallback file, queued OpenSearch output |
| `ingest-api/` | `server.js`, `package.json`, `node --test` suite |
| `systemd/watchsoc-ingest.service` | Hardened unit for the ingest API |
| `nginx/watchsoc-proxy.conf` | TLS 1.2/1.3 termination, rate limits, WebSocket upgrade for Dashboards |
| `scripts/generate-dev-certs.sh` | Self-signed certificate with openssl |
| `security/apparmor/usr.bin.watchsoc-ingest` | Named AppArmor profile for the ingest service |
| `security/ufw-setup.sh` | Idempotent firewall policy, supports `--dry-run` |
| `runbooks/OPERATIONAL_RUNBOOK.md` | On-call procedures |

## Setup on Ubuntu

```bash
# 1. Packages
sudo apt update
sudo apt install -y rsyslog rsyslog-elasticsearch nginx ufw apparmor-utils curl openssl
# Node 18 or newer is required (node --test, global fetch). Ubuntu's default nodejs package is older;
# install Node 20 from NodeSource or nvm.
# Docker Engine with the compose plugin is also required.

# 2. OpenSearch needs this sysctl
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-opensearch.conf
sudo sysctl --system

# 3. Search stack
docker compose up -d
curl -s http://127.0.0.1:9200/_cluster/health?pretty

# 4. Ingest API
sudo useradd --system --no-create-home --shell /usr/sbin/nologin watchsoc
sudo install -d -o root -g root /opt/watchsoc-ingest
sudo cp ingest-api/server.js ingest-api/package.json /opt/watchsoc-ingest/
sudo install -o watchsoc -g watchsoc -m 0640 /dev/null /var/log/watchsoc-ingest.log
sudo cp systemd/watchsoc-ingest.service /etc/systemd/system/

# 5. AppArmor (load in complain mode first, then enforce)
sudo cp security/apparmor/usr.bin.watchsoc-ingest /etc/apparmor.d/
sudo apparmor_parser -r /etc/apparmor.d/usr.bin.watchsoc-ingest
sudo aa-complain /etc/apparmor.d/usr.bin.watchsoc-ingest
sudo systemctl daemon-reload
sudo systemctl enable --now watchsoc-ingest
# After a clean run with no DENIED lines (see runbook):
sudo aa-enforce /etc/apparmor.d/usr.bin.watchsoc-ingest

# 6. rsyslog
sudo install -d -o syslog -g adm /var/spool/rsyslog
sudo cp rsyslog/50-watchsoc-opensearch.conf /etc/rsyslog.d/
sudo rsyslogd -N1
sudo systemctl restart rsyslog

# 7. Nginx with a dev certificate
sudo scripts/generate-dev-certs.sh watchsoc.local
sudo cp nginx/watchsoc-proxy.conf /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl reload nginx

# 8. Firewall. Confirm SSH_PORT first if SSH is not on 22.
sudo security/ufw-setup.sh --dry-run
sudo security/ufw-setup.sh
```

On Ubuntu the `/etc/nginx/sites-enabled/default` site also listens on port 80 and is not used here. Remove it if it should not answer.

## Test the pipeline

```bash
# API health (200 when OpenSearch is green or yellow, 503 otherwise)
curl -ks https://127.0.0.1/api/healthz

# Post an event for a tenant
curl -ks -X POST https://127.0.0.1/api/v1/tenant/acme/events \
  -H 'Content-Type: application/json' \
  -d '{"event_type":"auth_failure","message":"failed login for admin","severity":"warning","source":"vpn-gw"}'

# Send a syslog line through auth.log
logger -p auth.info -t sshd 'Failed password for invalid user test from 203.0.113.9 port 4242 ssh2'
sudo tail -n 2 /var/log/auth.log

# Simulate a Suricata alert
sudo mkdir -p /var/log/suricata
echo '{"event_type":"alert","src_ip":"203.0.113.9","alert":{"signature":"lab test"}}' | sudo tee -a /var/log/suricata/eve.json

# Confirm documents are indexed (allow a few seconds)
curl -s 'http://127.0.0.1:9200/soc-events/_search?size=3&sort=@timestamp:desc&pretty'
sudo tail -n 3 /var/log/soc-structured.json
```

## Local checks (no root needed)

```bash
cd ingest-api && npm test            # 12 tests against fake OpenSearch backends
node --check server.js
bash -n scripts/generate-dev-certs.sh security/ufw-setup.sh
security/ufw-setup.sh --dry-run
systemd-analyze verify systemd/watchsoc-ingest.service
apparmor_parser -Q -K -S security/apparmor/usr.bin.watchsoc-ingest > /dev/null
```

## Limits

- OpenSearch security is disabled. Safety rests on loopback binding, UFW and Nginx. Do not publish ports 9200 or 5601.
- The ingest API has no authentication. Add mTLS or a token check at Nginx before exposing it beyond a lab.
- The tenant name in the rsyslog template is a constant, `lab-tenant`.
- AppArmor cannot restrict by IP address. Loopback binding is enforced by the unit and the firewall.
