#!/usr/bin/env bash
# Super - shared deep-reasoning escalation tier (IMPLEMENTATION_PLAN.md Stage 12).
# GLM-4.7-Flash, not Nemotron 3 Super: replaced 2026-08-23 after a live bake-off found
# comparable reasoning quality at 1/4 the size (18GB vs 76.9GB) and ~4.6x faster load
# (24s vs 111s) -- Nemotron 3 Super's 85GiB wake threshold routinely exceeded spark's real
# available headroom (~80GB) alongside nano, making it unable to wake under normal
# conditions. Always-resident now, not on-demand.
#
# Huihui-GLM-4.7-Flash-abliterated, not stock GLM-4.7-Flash: replaced 2026-08-24 per direct
# request -- huihui-ai's own abliterated build of the same model already deployed and
# trusted for muse, quality-sanity-checked live (reasoning + creative-engagement checks)
# before deployment, not just downloaded and trusted.
exec /opt/llama.cpp/build/bin/llama-server   --model /mnt/hermes-data/models/Huihui-GLM-4.7-Flash-abliterated.Q4_K_M.gguf   --host 0.0.0.0 --port 8095   --n-gpu-layers 99   --ctx-size 65536   --flash-attn off   --reasoning off
