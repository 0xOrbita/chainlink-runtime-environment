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

echo "Starting both Custom Data Feed and Liquidation workflows in parallel mode..."

# Function for cleanup gracefully handling CTRL+C
cleanup() {
    echo -e "\nStopping workflows..."
    kill 0
    exit 1
}

# Catch the EXIT signal and CTRL+C to stop both background processes
trap "cleanup" SIGINT SIGTERM

# Enter data-feed-workflow
cd data-feed-workflow && \
echo ">>> Starting data-feed-workflow simulator..." && \
bun run simulate:direct &

# Enter liqudate-workflow
cd liqudate-workflow && \
echo ">>> Starting liqudate-workflow simulator..." && \
bun run simulate:direct &

# Wait for both processes to complete or for user interrupt
wait
echo "All executions complete."
