#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BACKEND_DIR="${SCRIPT_DIR}/backend"
FRONTEND_DIR="${SCRIPT_DIR}/frontend"

echo "========================================"
echo "Building MultiCamStudio"
echo "========================================"

# --------------------------------------------------
# Build C++ backend
# --------------------------------------------------

echo "[1/2] Building C++ backend..."

cmake \
    -S "${BACKEND_DIR}" \
    -B "${BACKEND_DIR}/build" \
    -DCMAKE_BUILD_TYPE=Release

cmake --build "${BACKEND_DIR}/build" \
    --parallel "$(nproc)"

# --------------------------------------------------
# Install frontend dependencies
# --------------------------------------------------

echo "[2/2] Installing frontend dependencies..."

cd "${FRONTEND_DIR}"

if [[ -f package-lock.json ]]; then
    npm ci --no-audit --no-fund
else
    npm install --no-audit --no-fund
fi

echo "========================================"
echo "MultiCamStudio build completed"
echo "========================================"