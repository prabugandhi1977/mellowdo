#!/bin/sh
# Hosted disks are often mounted root-owned: make /data writable, then drop to the unprivileged "node" user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data
  exec su-exec node "$0" "$@"
fi
exec node server/server.js
