#!/bin/sh
echo "Syncing database schema..."
npx prisma db push --skip-generate 2>&1 || { echo "ERROR: db push failed, aborting."; exit 1; }
echo "Starting application..."
exec node src/index.js
