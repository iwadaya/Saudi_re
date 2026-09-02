#!/usr/bin/env bash
# Kept for muscle memory — the deployment kit lives in deploy/. See deploy/README.md.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy/deploy.sh" "$@"
