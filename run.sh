#!/bin/sh
set -eu
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo 'Install Node.js 20 or newer first.'; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || { echo 'Node.js 20 or newer is required.'; exit 1; }
command -v docker >/dev/null 2>&1 || { echo 'Install and start Docker Desktop first.'; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Start Docker Desktop, then run this command again.'; exit 1; }
if [ ! -d node_modules/@temporalio/worker ]; then npm ci; fi
exec npm run dev
