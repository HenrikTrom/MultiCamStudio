#!/usr/bin/env bash
set -euo pipefail

TARGET_UID="${HOST_UID:-1000}"
TARGET_GID="${HOST_GID:-1000}"

# Update group ID
CURRENT_GID="$(id -g docker)"

if [ "$CURRENT_GID" != "$TARGET_GID" ]; then
    groupmod -o -g "$TARGET_GID" docker
fi

# Update user ID
CURRENT_UID="$(id -u docker)"

if [ "$CURRENT_UID" != "$TARGET_UID" ]; then
    usermod -o -u "$TARGET_UID" docker
fi

# Ensure the home directory is accessible
chown docker:docker /home/docker

# Execute the application as the docker user
exec gosu docker "$@"

if [ -n "${FLIR_GID:-}" ]; then
    if getent group "$FLIR_GID" >/dev/null; then
        usermod -aG "$(getent group "$FLIR_GID" | cut -d: -f1)" docker
    else
        groupadd -g "$FLIR_GID" flirimaging
        usermod -aG flirimaging docker
    fi
fi