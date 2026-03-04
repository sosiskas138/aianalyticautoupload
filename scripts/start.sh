#!/bin/sh
set -e
cd /app
node scripts/migrate.mjs || true
exec node dist/index.js
