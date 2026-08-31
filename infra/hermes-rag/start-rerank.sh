#!/usr/bin/env bash
# S16b — reranker backend (Qwen3-Reranker-0.6B-Q8_0). Resident on the Spark, port 8093 —
# already reserved for this in target §4.1's own model table, unused until now.
#
# The GGUF matters: `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF`, not a third-party conversion.
# Confirmed live (2026-08-31) that a community conversion (dean2155's) produces backwards/garbage
# relevance scores — a known llama.cpp issue (ggml-org/llama.cpp#16407): most third-party Qwen3-
# Reranker GGUFs are missing the `cls.output.weight` tensor `convert_hf_to_gguf.py` extracts from
# the model's own lm_head, without which the rerank pooling head has nothing real to score with.
# ggml-org's own upload includes it — verified with a real query before trusting it (a stop-sign
# question scored the stop-sign document 0.999 and the decoys ~0.0003, not the reverse).
#
# --pooling rank --embedding are both required alongside --reranking, not implied by it — a bare
# `--reranking` alone left the model's own pooling type unset and produced the same garbage
# scores the wrong GGUF did, before either fix was identified as the real cause.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/Qwen3-Reranker-0.6B-Q8_0.gguf \
  --reranking --pooling rank --embedding \
  --host 127.0.0.1 --port 8093 \
  --n-gpu-layers 99 \
  --ctx-size 4096
