#!/usr/bin/env bash
set -euo pipefail

echo "Pulling latest code..."
cd /opt/universe
git fetch origin
git checkout main
git pull origin main

echo "Installing dependencies..."
# npm ci (not npm install): reproducible install straight from the lockfiles,
# so a deploy never resolves newer transitive versions than CI audited.
npm ci
npm ci --prefix client
npm ci --prefix server

echo "Building frontend..."
npm run build --prefix client

echo "Running migrations..."
cd /opt/universe/server
npm run migrate

echo "Reloading app..."
cd /opt/universe
pm2 reload universe

echo "Done! App is live."
pm2 status
