#!/usr/bin/env bash
# Lock the host down to rate-limited SSH and 443/tcp. Idempotent: re-running
# does not duplicate rules.
# Usage: sudo security/ufw-setup.sh [--dry-run]
# Env:   SSH_PORT (default 22)
set -euo pipefail

SSH_PORT="${SSH_PORT:-22}"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

run() {
    if [[ "$DRY_RUN" == "1" ]]; then
        echo "+ $*"
    else
        "$@"
    fi
}

if [[ "$DRY_RUN" != "1" && "$(id -u)" -ne 0 ]]; then
    echo "run as root" >&2
    exit 1
fi
if [[ "$DRY_RUN" != "1" ]]; then
    command -v ufw >/dev/null 2>&1 || { echo "ufw is not installed (apt install ufw)" >&2; exit 1; }
fi

# The SSH rule goes in before the firewall is enabled so a remote session survives.
run ufw default deny incoming
run ufw default allow outgoing
run ufw limit "${SSH_PORT}/tcp" comment 'ssh rate-limited'
run ufw allow 443/tcp comment 'watchsoc nginx tls'
run ufw logging low
run ufw --force enable
run ufw status verbose
