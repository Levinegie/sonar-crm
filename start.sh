#!/bin/sh
echo "Syncing database schema..."
npx prisma db push --skip-generate --accept-data-loss 2>&1 || echo "Warning: db push failed, continuing..."
echo "Starting application..."
exec node src/index.js
