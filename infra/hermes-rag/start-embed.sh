#!/usr/bin/env bash
# 2026-09-04 — swapped 0.6B -> Qwen3-Embedding-8B-Q8_0, direct operator request after a model
# review found it ranking #1 on a January 2026 MTEB English snapshot, ahead of every proprietary
# API, for a cost this node's headroom doesn't even notice. Native output is 4096-dim (MRL-capable
# down to 32, but llama-server's own /v1/embeddings has no confirmed client-side truncation
# parameter -- not chasing that; EMBED_DIMS moves to the model's native 4096 everywhere instead,
# see hermes_rag_common.py 1.7.0 and hermes-memory.py 1.4.0). Same GGUF org (`Qwen/Qwen3-Embedding-
# 8B-GGUF`) as the 0.6B before it, so the "verified against a live HF listing" gate that was
# already true then still holds.
#
# **This node's copy MUST move together with HomeD13's** (start-embed-homed13.sh) -- they embed
# into the same vectors.db / vec_chunks space, and a dimension or checkpoint mismatch between the
# query-time embedder (here) and the bulk-ingestion embedder (HomeD13) makes every retrieval a
# comparison across two different vector spaces, not a subtly-worse one. Every corpus needs a real
# reindex after this swap (infra/hermes-rag/README.md's own reindex section) -- old 1024-dim
# vectors are not just lower-quality against a 4096-dim query, they're a dimension mismatch sqlite-
# vec's vec0 table structure can't even store in the same table.
#
# **Not yet measured live** -- ggml-org/llama.cpp#26044 reports Qwen3-Embedding-8B returning
# all-NaN embeddings on certain CUDA/Volta-generation inputs, permanently wedging the server until
# restarted (CPU inference unaffected). This node is GB10 Grace-**Blackwell**, not Volta, so the bug
# as reported likely doesn't apply -- but that's an architectural inference, not a live test. Smoke-
# test with a real embedding call before trusting this in production (README's reindex section has
# the command).
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/Qwen3-Embedding-8B-Q8_0.gguf \
  --embedding --pooling last \
  --host 127.0.0.1 --port 8092 \
  --n-gpu-layers 99 \
  --ctx-size 2048 --ubatch-size 512
