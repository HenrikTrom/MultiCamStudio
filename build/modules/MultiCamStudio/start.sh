#!/usr/bin/env bash
# Compatibility launcher for the ROS 2 branch; all native builds run in Docker.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
exec docker compose --project-directory "$REPO_ROOT" -f "$REPO_ROOT/docker-compose.yaml" up -d "$@"
