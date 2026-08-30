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

echo "Seeding test data (SEED_ON_DEPLOY gate)..."
# No-op unless SEED_ON_DEPLOY is set — in this shell's environment or in the
# .env file. SEED_ON_DEPLOY=1 seeds the treaty test portfolio only when the
# database has none yet; SEED_ON_DEPLOY=reset wipes the previous seed and
# reseeds on every deploy. Runs after the reload so a seed failure can't
# block the app going live — it still fails this script loudly.
npm run seed:deploy --prefix server

echo "Done! App is live."
npm run cluster:status
