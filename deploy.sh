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
# pm2 is a root devDependency, not a global install — resolve it from
# node_modules/.bin via the npm scripts.
npm run cluster:reload

echo "Done! App is live."
npm run cluster:status
