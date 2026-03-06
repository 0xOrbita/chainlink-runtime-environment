#!/bin/bash

# Load the environment variables from .env
if [ -f .env ]; then
  # Automatically export all variables defined in .env
  set -a
  source .env
  set +a
else
  echo "[!] Warning: No .env file found in root directory"
fi

echo "Starting both Custom Data Feed and Liquidation workflows in sequential mode..."

# Function for cleanup gracefully handling CTRL+C
cleanup() {
    echo -e "\nStopping workflows..."
    exit 1
}

# Catch the EXIT signal and CTRL+C
trap "cleanup" SIGINT SIGTERM

# Execute data-feed-workflow
echo ">>> Starting data-feed-workflow simulator..."
(cd data-feed-workflow && bun run simulate:direct)

# Execute liqudate-workflow
echo ">>> Starting liqudate-workflow simulator..."
(cd liqudate-workflow && bun run simulate:direct)
echo "All executions complete."
