#!/bin/sh
set -e

OLLAMA_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
DEFAULT_MODEL="${JOULE_DEFAULT_MODEL:-qwen2.5:1.5b}"

# Wait for Ollama to be ready
echo "Waiting for Ollama at $OLLAMA_URL..."
MAX_RETRIES=30
RETRY_COUNT=0
until curl -sf "$OLLAMA_URL/api/tags" > /dev/null 2>&1; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ "$RETRY_COUNT" -ge "$MAX_RETRIES" ]; then
    echo "Warning: Ollama not reachable after ${MAX_RETRIES} attempts, starting anyway..."
    break
  fi
  echo "  Attempt $RETRY_COUNT/$MAX_RETRIES..."
  sleep 2
done

# Pull default model if not already available
if curl -sf "$OLLAMA_URL/api/tags" > /dev/null 2>&1; then
  echo "Ollama is ready. Checking for model: $DEFAULT_MODEL"
  if ! curl -sf "$OLLAMA_URL/api/tags" | grep -q "$DEFAULT_MODEL"; then
    echo "Pulling model: $DEFAULT_MODEL (this may take a few minutes)..."
    curl -sf "$OLLAMA_URL/api/pull" -d "{\"name\": \"$DEFAULT_MODEL\"}" > /dev/null 2>&1 || \
      echo "Warning: Failed to pull model, you may need to pull it manually."
  else
    echo "Model $DEFAULT_MODEL already available."
  fi
fi

echo "Starting Joule..."
exec "$@"
