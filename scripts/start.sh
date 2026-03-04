#!/bin/sh
set -e
cd /app
if [ -n "$DATABASE_URL" ]; then
  node scripts/migrate.mjs || true
fi
exec node dist/index.js
