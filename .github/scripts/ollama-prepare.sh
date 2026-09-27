#!/usr/bin/env bash
# Starts the pinned Ollama runtime, pulls the pinned model, checks its digest
# and loads it into memory. Shared by both jobs in local-model.yml.
#
# Expects PIN (tests/fixtures/ollama/model.json) and OLLAMA_BASE_URL. Meant to
# run in the background while the job installs dependencies or builds images,
# since the runtime image (3.7 GB) and the model (1.9 GB) are most of the wall
# clock and depend on neither.
set -euo pipefail

runtime=$(jq -r .runtime "$PIN")
model=$(jq -r .model "$PIN")
pinned=$(jq -r .digest "$PIN")

docker pull --quiet "$runtime"
# Published on every interface of the runner, which is what lets the Compose
# app reach it through host.docker.internal. The runner is disposable and
# nothing else listens for it.
docker run --detach --name ollama --publish 11434:11434 \
  --env OLLAMA_KEEP_ALIVE=-1 "$runtime"

started=
for _ in $(seq 60); do
  if curl -fsS "$OLLAMA_BASE_URL/api/version"; then started=1; break; fi
  sleep 1
done
echo
if [ -z "$started" ]; then
  echo "::error::Ollama did not start within a minute."
  exit 1
fi

# The API rather than `ollama pull`, which draws a progress bar per layer into
# the log.
curl -fsS --max-time 1800 "$OLLAMA_BASE_URL/api/pull" \
  -d "$(jq -n --arg model "$model" '{model: $model, stream: false}')"
echo

actual=$(curl -fsS "$OLLAMA_BASE_URL/api/tags" \
  | jq -r --arg model "$model" '.models[] | select(.name == $model) | .digest')
if [ "$actual" != "$pinned" ]; then
  echo "::error::$model is $actual, but $PIN pins $pinned. The registry has republished the tag; read what changed, then update the digest."
  exit 1
fi
echo "$model is the pinned $pinned"

# A generate request without a prompt only loads the model; the container keeps
# it there (OLLAMA_KEEP_ALIVE=-1), so the first real call does not pay for it.
curl -fsS --max-time 600 "$OLLAMA_BASE_URL/api/generate" \
  -d "$(jq -n --arg model "$model" '{model: $model, keep_alive: -1}')" >/dev/null
echo "$model is loaded"
