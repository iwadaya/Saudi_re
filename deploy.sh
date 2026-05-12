#!/usr/bin/env bash
set -euo pipefail

echo "Pulling latest code..."
cd /opt/universe
git fetch origin
git checkout main
git pull origin main

echo "Installing dependencies..."
npm install
npm install --prefix client
npm install --prefix server

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
