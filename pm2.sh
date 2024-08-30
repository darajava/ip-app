#!/bin/sh

git pull origin master

echo "Installing dependencies..."
npm install

echo "Building..."
# Run the build command with increased memory limit
NODE_OPTIONS='--max-old-space-size=4096' npm run build

# Check if the build command was successful
if [ $? -ne 0 ]; then
  echo "Build failed. Exiting."
  exit 1
fi

# Restart pm2 and show logs if build was successful
pm2 restart all && pm2 logs
