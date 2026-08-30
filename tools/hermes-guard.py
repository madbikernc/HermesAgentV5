#!/usr/bin/env python3
# Version: 1.0.0
#
# hermes-guard — Layer 2 of the two-layer screening design (HermesAgentV5/IMPLEMENTATION_PLAN.md
# S5; target architecture §8, §12.1). Resident classifier service wrapping Meta's
# Llama-Prompt-Guard-2-22M (stock weights, permanently — target §12.1's reasoning: removing
# refusal disposition from the one component whose job is refusal-under-pressure is
# self-defeating, so this model is never a candidate for abliteration).
#
# Not served by llama-server: Prompt Guard 2 is a DeBERTa-v2 sequence-classification head, not a
# causal LM — llama.cpp has no support for this architecture. Runs under `transformers` instead,
# the one place in this fleet's control plane where that's the right dependency, not a
# stdlib-only violation for its own sake. CPU-only, deliberately: 22M params / ~283MB, classifies
# in low tens of milliseconds even without a GPU, and running on CPU means Layer 2 costs zero KV
# cache headroom against the resident LLM backends sharing the node's unified memory.
#
# Binary classifier, per Meta's own model card: label 1 = MALICIOUS (an explicit attempt to
# override prior instructions), label 0 = BENIGN. No injection/jailbreak sub-labels in this
# version (Prompt Guard 1 had them; Meta found that objective too broad to be useful). 512-token
# context window — longer text is truncated, not split, for this service; a caller wanting
# full-document coverage should chunk before calling, same as Layer 1's per-message scoping.
#
# Config, all from the environment (injected by hermes-guard-wrapper.sh, which fetches
# GUARD_TOKEN from Vaultwarden and execs this — secrets never touch disk):
#   GUARD_TOKEN     required — bearer token callers must present
#   GUARD_MODEL_DIR default /mnt/hermes-data/models/prompt-guard-2-22m
#   GUARD_BIND      default 0.0.0.0
#   GUARD_PORT      default 8096
#   GUARD_THRESHOLD default 0.5 — MALICIOUS-class probability at or above this is a hit

import hmac
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIND = os.environ.get("GUARD_BIND", "0.0.0.0")
PORT = int(os.environ.get("GUARD_PORT", "8096"))
TOKEN = os.environ.get("GUARD_TOKEN", "")
MODEL_DIR = os.environ.get("GUARD_MODEL_DIR", "/mnt/hermes-data/models/prompt-guard-2-22m")
THRESHOLD = float(os.environ.get("GUARD_THRESHOLD", "0.5"))

MAX_BODY = 64 * 1024


def log(msg):
    print(f"[hermes-guard] {msg}", flush=True)


def load_model():
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_DIR)
    model.eval()
    return torch, tokenizer, model


_torch = _tokenizer = _model = None


def classify(text):
    """Returns (label, score) — label is "BENIGN" or "MALICIOUS", score is that class's own
    softmax probability. Truncates to the model's 512-token window rather than raising on
    longer input — a guard that fails closed on long input is worse than one that screens a
    truncated prefix."""
    inputs = _tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
    with _torch.no_grad():
        logits = _model(**inputs).logits
    probs = _torch.softmax(logits, dim=-1)[0]
    idx = int(probs.argmax().item())
    label = _model.config.id2label[idx]
    # Meta's own checkpoint ships generic id2label ({0: "LABEL_0", 1: "LABEL_1"}) rather than
    # named labels — normalize here so callers never depend on that config detail.
    label = "MALICIOUS" if idx == 1 else "BENIGN"
    return label, float(probs[idx].item())


class Handler(BaseHTTPRequestHandler):
    server_version = "hermes-guard/1.0.0"

    def log_message(self, fmt, *args):
        log(f"{self.address_string()} {fmt % args}")

    def _send(self, code, obj):
        blob = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def _authed(self):
        presented = self.headers.get("Authorization", "")
        if hmac.compare_digest(presented, f"Bearer {TOKEN}"):
            return True
        self._send(401, {"error": "unauthorized"})
        return False

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("invalid Content-Length header")
        if length < 0 or length > MAX_BODY:
            raise ValueError(f"invalid or too-large body ({length} bytes)")
        return self.rfile.read(length)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, {"ok": True, "version": self.server_version})
            return
        self._send(404, {"error": "no such route"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self._authed():
            return
        if parsed.path != "/classify":
            self._send(404, {"error": "no such route"})
            return
        try:
            payload = json.loads(self._body() or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": f"bad body: {exc}"})
            return
        text = payload.get("text", "")
        if not isinstance(text, str) or not text.strip():
            self._send(400, {"error": "text is required"})
            return
        label, score = classify(text)
        hit = label == "MALICIOUS" and score >= THRESHOLD
        self._send(200, {"label": label, "score": score, "hit": hit, "threshold": THRESHOLD})


def main():
    global _torch, _tokenizer, _model
    if not TOKEN:
        sys.exit("GUARD_TOKEN is required — this service must not run unauthenticated")
    log(f"loading {MODEL_DIR} ...")
    _torch, _tokenizer, _model = load_model()
    log(f"model loaded, listening on {BIND}:{PORT}, threshold={THRESHOLD}")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
