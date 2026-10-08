#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT="${PORT:-5173}"

echo "Starting MultiCamStudio"
echo "Frontend port: ${PORT}"

cd "${SCRIPT_DIR}/frontend"

exec npm run dev -- \
    --host 0.0.0.0 \
    --port "${PORT}" \
    --strictPort