#!/bin/sh
echo "Syncing database schema..."
npx prisma db push --skip-generate || echo "Warning: db push failed, continuing..."
echo "Starting application..."
node src/index.js
