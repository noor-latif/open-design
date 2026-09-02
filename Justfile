# OpenDesign — local Aurora fork helper
# Usage: just update   # fetch upstream, rebase feat/web-native-picker, rebuild, restart
set shell := ["bash", "-cu"]

default:
    @just --list

# full update: sync main, rebase picker, rebuild image, restart, push
update:
    #!/usr/bin/env bash
    set -euo pipefail
    cd /var/home/noor/dev/open-design
    echo "→ fetch upstream..."
    git fetch upstream
    echo "→ update main (pristine)..."
    git checkout main
    git reset --hard upstream/main
    git push origin main || echo "push main skipped"
    echo "→ rebase feat/web-native-picker..."
    git checkout feat/web-native-picker
    if ! git rebase main; then
        echo "⚠ rebase conflict — fix, then: git rebase --continue && just update"
        exit 1
    fi
    echo "→ build open-design-local (from source + picker)..."
    podman build -t open-design-local -f deploy/Dockerfile .
    echo "→ restart container (compose + override)..."
    cd deploy
    podman compose up -d
    echo "→ push rebase..."
    git push --force-with-lease origin feat/web-native-picker || echo "push skipped"
    echo "✓ update done — http://127.0.0.1:7456 (Basic open-design / OD_API_TOKEN)"

# just pull latest upstream without rebase
sync:
    git fetch upstream && git checkout main && git reset --hard upstream/main

# show status
status:
    @echo "— git —"
    @git -C /var/home/noor/dev/open-design status --short
    @git -C /var/home/noor/dev/open-design log --oneline --graph -8
    @echo "— container —"
    @podman ps | head -n 10
    @echo "— agents —"
    @curl -s -H "Authorization: Bearer $(grep OD_API_TOKEN /var/home/noor/dev/open-design/deploy/.env | cut -d= -f2)" http://127.0.0.1:7456/api/agents | python3 -c "import sys,json; d=json.load(sys.stdin); print([a['id'] for a in d['agents'] if a['available']])" 2>/dev/null || echo "daemon not ready"

# rebuild only (no git)
rebuild:
    podman build -t open-design-local -f deploy/Dockerfile .
    cd /var/home/noor/dev/open-design/deploy && podman compose up -d

logs:
    podman logs -f open-design

down:
    cd /var/home/noor/dev/open-design/deploy && podman compose down

up:
    cd /var/home/noor/dev/open-design/deploy && podman compose up -d
