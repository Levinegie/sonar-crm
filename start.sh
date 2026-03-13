#!/bin/sh
echo "Syncing database schema..."
npx prisma db push --skip-generate
echo "Starting application..."
node src/index.js
