# Operational runbook

Host: Ubuntu 22.04/24.04. Services: `rsyslog`, `watchsoc-ingest`, `nginx`, Docker containers `soc-opensearch` and `soc-dashboards`.

## First look

```bash
systemctl --no-pager status rsyslog watchsoc-ingest nginx
docker ps --format '{{.Names}} {{.Status}}'
curl -s http://127.0.0.1:9200/_cluster/health?pretty
curl -ks https://127.0.0.1/api/healthz
sudo ufw status verbose
```

## rsyslog queue backlog

Symptoms: events missing in OpenSearch while `/var/log/soc-structured.json` keeps growing; files named `watchsoc_es.*` growing in `/var/spool/rsyslog`.

```bash
ls -lh /var/spool/rsyslog/
sudo du -sh /var/spool/rsyslog
sudo tail -n 50 /var/log/rsyslog-es-errors.json     # records OpenSearch rejected
journalctl -u rsyslog --since '30 min ago' --no-pager | grep -iE 'omelasticsearch|suspend|queue|error'
curl -s http://127.0.0.1:9200/_cluster/health?pretty
sudo rsyslogd -N1
```

Causes and actions:
1. OpenSearch down or red. Fix OpenSearch first (below). The queue retries every 10 seconds with unlimited retries and drains on its own once the cluster accepts writes.
2. Disk queue at its 1 GB cap (`queue.maxdiskspace`). New messages are then blocked or dropped. Free space or raise the cap in `50-watchsoc-opensearch.conf`, then `sudo systemctl restart rsyslog`. The queue is saved to disk on shutdown (`queue.saveonshutdown`).
3. Bulk rejections. `rsyslog-es-errors.json` shows the reason, usually a mapping conflict or a read-only index after disk flood stage. Check `curl -s 'http://127.0.0.1:9200/_cluster/settings?include_defaults=true&filter_path=**.watermark*'` and `df -h`.
4. Events are still safe in `/var/log/soc-structured.json`. Replay is manual with the `_bulk` API if the queue was lost.

## OpenSearch yellow or red, JVM heap pressure

Single node: yellow is expected for any index with replicas. Fix by setting replicas to 0 on the single node.

```bash
curl -s 'http://127.0.0.1:9200/_cluster/health?pretty'
curl -s 'http://127.0.0.1:9200/_cat/indices?v&s=index'
curl -s 'http://127.0.0.1:9200/_cat/shards?v&h=index,shard,prirep,state,unassigned.reason'
curl -s 'http://127.0.0.1:9200/_cluster/allocation/explain?pretty'
curl -s -X PUT 'http://127.0.0.1:9200/soc-events/_settings' -H 'Content-Type: application/json' -d '{"index":{"number_of_replicas":0}}'
```

Red means a primary shard is unassigned. Read the allocation explanation. Common reasons on this host: disk watermark exceeded (`df -h`, free space, then clear the read-only block with `curl -s -X PUT 'http://127.0.0.1:9200/_all/_settings' -H 'Content-Type: application/json' -d '{"index.blocks.read_only_allow_delete":null}'`), or the data volume was deleted.

Heap pressure:

```bash
curl -s 'http://127.0.0.1:9200/_nodes/stats/jvm?filter_path=**.heap_used_percent,**.gc&pretty'
docker logs --since 30m soc-opensearch 2>&1 | grep -iE 'OutOfMemory|gc overhead|circuit_breaking|heap'
free -h
```

Sustained heap above 85 percent or `circuit_breaking_exception` means the 512 MB heap is too small for the data or query load. Raise `-Xms`/`-Xmx` in `docker-compose.yml` to the same value, no more than half of RAM, then `docker compose up -d`. Also check that `vm.max_map_count` is at least 262144 (`sysctl vm.max_map_count`); the container will not start otherwise.

## Nginx 502 Bad Gateway

502 means Nginx could not get a response from the upstream.

```bash
sudo tail -n 30 /var/log/nginx/error.log          # look for "connect() failed" and the upstream address
ss -ltnp | grep -E ':(3000|5601|9200)\b'
curl -sv http://127.0.0.1:3000/healthz
curl -sI http://127.0.0.1:5601/dashboards/
systemctl status watchsoc-ingest --no-pager
journalctl -u watchsoc-ingest --since '15 min ago' --no-pager
sudo nginx -t
```

- `/api/` returns 502 and nothing listens on 3000: the ingest service is down or in a restart loop. Read its journal. If AppArmor is enforcing, check for DENIED lines (next section).
- `/` returns 502 and nothing listens on 5601: Dashboards is not running or still waiting for OpenSearch. `docker logs soc-dashboards`.
- Dashboards loads but the UI breaks: Dashboards must run with `SERVER_BASEPATH=/dashboards` (set in `docker-compose.yml`), so its own `/api/` calls do not collide with the ingest API prefix.
- 503/504 or 429: rate limit (`limit_req`) or slow upstream. 429 is the rate limiter. Check `/var/log/nginx/error.log` for `limiting requests`.

## AppArmor DENIED

```bash
sudo aa-status | grep -A3 watchsoc
journalctl -k --since '1 hour ago' --no-pager | grep -E 'apparmor="(DENIED|ALLOWED)"' | grep watchsoc-ingest
# If auditd is installed instead of journald kernel logging:
sudo grep 'apparmor="DENIED"' /var/log/audit/audit.log | grep watchsoc-ingest | tail
```

Read each line for `operation=`, `name=` (the path) and `requested_mask=`. Then:
1. Put the profile in complain mode: `sudo aa-complain /etc/apparmor.d/usr.bin.watchsoc-ingest`. Restart the service and exercise `/healthz` and a POST. ALLOWED lines in the log list what the profile is missing.
2. If the missing access is legitimate (for example another library path), add the narrowest rule to `security/apparmor/usr.bin.watchsoc-ingest`, reload with `sudo apparmor_parser -r /etc/apparmor.d/usr.bin.watchsoc-ingest`, and re-test.
3. If the denied path is under `/home`, `/etc/shadow`, `/etc/ssh` or `/var/log/auth.log`, the process is reaching for something it should not. Do not add a rule. Treat it as a possible compromise: preserve the journal, stop the service, and review the ingest log for the payloads that preceded it.
4. Return to enforce: `sudo aa-enforce /etc/apparmor.d/usr.bin.watchsoc-ingest`.

If the service fails with `failed to apply AppArmor profile`, the profile is not loaded: `sudo apparmor_parser -r /etc/apparmor.d/usr.bin.watchsoc-ingest`, then `sudo systemctl restart watchsoc-ingest`.

## Firewall

```bash
sudo ufw status numbered
sudo ufw status verbose
```

Only `443/tcp` and rate-limited SSH should be allowed. `sudo security/ufw-setup.sh` is safe to re-run. Docker publishes ports through iptables and can bypass UFW for ports bound to external addresses. Every port in `docker-compose.yml` is bound to `127.0.0.1` for that reason.
