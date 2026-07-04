#!/bin/sh
# Ensure mounted volume is writable by the non-root node user.
# Running as root is required to chown the bind-mounted /data directory.

set -e

mkdir -p /data/photos
chown -R node:node /data

# Hand off to the CMD as the node user.
exec su-exec node "$@"
