#!/bin/sh
echo "Syncing database schema..."
npx prisma db push --skip-generate 2>&1 || echo "WARNING: db push failed, continuing anyway..."
echo "Starting application..."
exec node src/index.js
