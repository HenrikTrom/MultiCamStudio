#!/usr/bin/env bash
set -e

groupadd -g 1000 docker

useradd \
    --create-home \
    --home-dir /home/docker \
    --shell /bin/bash \
    --gid docker \
    --groups sudo \
    --uid 1000 \
    docker

mkdir -p /home/docker/workspace
chown -R docker:docker /home/docker