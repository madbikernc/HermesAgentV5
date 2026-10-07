#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-clef-server.py — Serves a Cloudflare Clef decision model (Clef / Clef-flash) behind the
Jev/SystemOne wire shape, `POST /v1/systemone`, so tools/hermes-bakeoff-typesafe.py (or any
caller) can point TYPESAFE_ENDPOINT at it unchanged.

Clef is not a chat model: a state plus typed choice/score/noul questions go in, one probability
per allowed option comes out, from a single forward pass. llama.cpp can't serve it (the joint
schema head is custom code shipped in the checkpoint as joint_schema_model.py), so this runs the
release's own `load_release_model` + `systemone` under transformers -- the same separate-service
precedent as hermes-guard.py, not a router role.

Images: the release's `systemone` wants PIL images; over HTTP each `images` entry is a base64
string or a `data:image/...;base64,` URI and is decoded here. Videos are not accepted.

Env:
  CLEF_MODEL_DIR   default /mnt/hermes-data/models/clef-flash (pinned download and the venv it
                   needs: infra/model-benchmark/clef-decision-model-bakeoff.md §2)
  CLEF_MODEL_NAME  default clef-flash -- the only `model` value accepted besides jev/jev-latest
  CLEF_HOST        default 127.0.0.1 -- reach it cross-node by SSH tunnel, not a ufw hole
  CLEF_PORT        default 8089
  CLEF_TOKEN       optional; when set, requests must carry `Authorization: Bearer <token>`
  CLEF_MAX_LENGTH  default 16384 (the release default)
"""
import base64
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_DIR = os.environ.get("CLEF_MODEL_DIR", "/mnt/hermes-data/models/clef-flash")
MODEL_NAME = os.environ.get("CLEF_MODEL_NAME", "clef-flash")
HOST = os.environ.get("CLEF_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLEF_PORT", "8089"))
TOKEN = os.environ.get("CLEF_TOKEN", "")
MAX_LENGTH = int(os.environ.get("CLEF_MAX_LENGTH", "16384"))
MAX_BODY = 64 * 1024 * 1024
ACCEPTED_MODELS = {MODEL_NAME, "jev", "jev-latest"}


def log(msg):
    print(f"[hermes-clef] {msg}", flush=True)


def decode_image(item):
    from PIL import Image
    if not isinstance(item, str):
        raise ValueError("each image must be a base64 string or data URI")
    if item.startswith("data:"):
        item = item.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(item))).convert("RGB")


class Clef:
    def __init__(self):
        import torch
        sys.path.insert(0, MODEL_DIR)
        from joint_schema_model import load_release_model, systemone
        t0 = time.perf_counter()
        # Needs `accelerate` (device_map= loads straight onto the GPU). Loading to CPU and then
        # .to("cuda") instead briefly holds two copies in GB10 unified memory and OOMs spark-2.
        self.model, self.processor = load_release_model(MODEL_DIR, device="cuda")
        self.systemone = systemone
        self.lock = threading.Lock()  # one GPU, one forward pass at a time
        log(f"loaded {MODEL_DIR} in {time.perf_counter() - t0:.1f}s, "
            f"{torch.cuda.memory_allocated() / 2**30:.1f} GiB allocated")

    def answer(self, request):
        if request.get("videos"):
            raise ValueError("videos are not supported by this server")
        request = dict(request)
        if request.get("model") in ACCEPTED_MODELS:
            request["model"] = MODEL_NAME
        else:
            raise ValueError(f"model must be one of {sorted(ACCEPTED_MODELS)}")
        if request.get("images"):
            request["images"] = [decode_image(i) for i in request["images"]]
        with self.lock:
            return self.systemone(self.model, self.processor, request, max_length=MAX_LENGTH)


CLEF = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "model": MODEL_NAME})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/systemone":
            return self._send(404, {"error": "not found"})
        if TOKEN and self.headers.get("Authorization", "") != f"Bearer {TOKEN}":
            return self._send(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._send(413, {"error": "body missing or too large"})
        try:
            request = json.loads(self.rfile.read(length))
            t0 = time.perf_counter()
            out = CLEF.answer(request)
            log(f"{len(request.get('questions', {}))} question(s), "
                f"{out['usage']['input_tokens']} tokens, {(time.perf_counter() - t0) * 1000:.0f}ms")
            self._send(200, out)
        except (ValueError, KeyError, json.JSONDecodeError) as exc:
            self._send(400, {"error": str(exc)})
        except Exception as exc:
            log(f"error: {exc!r}")
            self._send(500, {"error": "internal error"})


def main():
    global CLEF
    CLEF = Clef()
    log(f"listening on {HOST}:{PORT} as {MODEL_NAME}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
