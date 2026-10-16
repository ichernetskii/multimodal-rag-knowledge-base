#!/bin/sh
set -eu
# Inspect first: restarts use the existing volume, including offline deployments.
# Missing models are pulled through the official Ollama registry; failures stop startup.
for model in qwen3.5:4b embeddinggemma; do
  if ollama show "$model" >/dev/null 2>&1; then
    echo "Local model already installed: $model"
  else
    echo "Downloading local model: $model"
    ollama pull "$model"
  fi
  ollama show "$model" >/dev/null
done
echo "Local models are installed. Model availability is checked separately in the admin UI."
