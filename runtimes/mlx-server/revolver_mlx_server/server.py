"""Stdlib HTTP server exposing mlx-engine via OpenAI-compatible endpoints."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from mlx_engine.generate import create_generator, get_runtime_load_info, load_model, tokenize
from transformers import AutoProcessor, AutoTokenizer

MODEL_KIT = None
MODEL_PATH: Path | None = None
MODEL_ID = "local"
CONTEXT_LENGTH: int | None = None
GENERATION_LOCK = threading.Lock()


def resolve_model_path(model_arg: str) -> Path:
    if os.path.exists(model_arg):
        return Path(model_arg)

    local_paths = [
        os.path.expanduser("~/.cache/huggingface/hub"),
        os.path.expanduser("~/.lmstudio/models"),
    ]
    for base in local_paths:
        candidate = Path(base) / model_arg
        if candidate.exists():
            return candidate

    raise FileNotFoundError(f"Model not found: {model_arg}")


def is_vision_model(model_path: Path) -> bool:
    config = model_path / "config.json"
    if not config.exists():
        return False
    data = json.loads(config.read_text())
    return "vision_config" in data


def parse_image_b64(url: str) -> str | None:
    if url.startswith("data:"):
        match = re.match(r"^data:[^;]+;base64,(.+)$", url, re.DOTALL)
        if match:
            return match.group(1)
    if os.path.isfile(url):
        with open(url, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")
    return None


def normalize_messages(raw_messages: list[Any]) -> tuple[list[dict[str, Any]], list[str]]:
    conversation: list[dict[str, Any]] = []
    images_b64: list[str] = []

    for msg in raw_messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if isinstance(content, str):
            conversation.append({"role": role, "content": content})
            continue

        if not isinstance(content, list):
            conversation.append({"role": role, "content": str(content)})
            continue

        parts: list[dict[str, Any]] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            part_type = part.get("type")
            if part_type == "text":
                text = part.get("text", "")
                parts.append({"type": "text", "text": text})
            elif part_type == "image_url":
                image_url = part.get("image_url") or {}
                url = image_url.get("url", "")
                b64 = parse_image_b64(url)
                if b64:
                    images_b64.append(b64)
                    parts.append({"type": "image", "base64": b64})
            elif part_type == "image":
                b64 = part.get("base64")
                if b64:
                    images_b64.append(b64)
                    parts.append({"type": "image", "base64": b64})

        if len(parts) == 1 and parts[0].get("type") == "text":
            conversation.append({"role": role, "content": parts[0]["text"]})
        else:
            conversation.append({"role": role, "content": parts})

    return conversation, images_b64


def build_prompt(model_path: Path, messages: list[Any]) -> tuple[str, list[str]]:
    conversation, images_b64 = normalize_messages(messages)
    vision = is_vision_model(model_path) or bool(images_b64)

    if vision:
        processor = AutoProcessor.from_pretrained(str(model_path), trust_remote_code=False)
        prompt = processor.apply_chat_template(
            conversation,
            tokenize=False,
            add_generation_prompt=True,
        )
    else:
        tokenizer = AutoTokenizer.from_pretrained(str(model_path), trust_remote_code=False)
        prompt = tokenizer.apply_chat_template(
            conversation,
            tokenize=False,
            add_generation_prompt=True,
        )

    return prompt, images_b64


def chunk_sse(payload: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


def stop_reason_to_finish(stop: Any) -> str:
    reason = getattr(stop, "stop_reason", None) if stop is not None else None
    return "length" if reason == "token_limit" else "stop"


def run_generation(body: dict[str, Any]) -> tuple[str, dict[str, int] | None]:
    assert MODEL_KIT is not None
    assert MODEL_PATH is not None

    messages = body.get("messages") or []
    max_tokens = int(body.get("max_tokens") or 1024)
    temperature = float(body.get("temperature", body.get("temp", 0.8)))

    prompt, images_b64 = build_prompt(MODEL_PATH, messages)
    prompt_tokens = tokenize(MODEL_KIT, prompt)

    completion = ""
    with GENERATION_LOCK:
        generator = create_generator(
            MODEL_KIT,
            prompt_tokens,
            images_b64=images_b64 or None,
            temp=temperature,
            max_tokens=max_tokens,
        )
        for result in generator:
            completion += result.text or ""
            if getattr(result, "stop_condition", None):
                break

    usage = {
        "prompt_tokens": len(prompt_tokens),
        "completion_tokens": max(1, len(completion) // 4),
        "total_tokens": len(prompt_tokens) + max(1, len(completion) // 4),
    }
    return completion, usage


def stream_generation(body: dict[str, Any]):
    assert MODEL_KIT is not None
    assert MODEL_PATH is not None

    messages = body.get("messages") or []
    max_tokens = int(body.get("max_tokens") or 1024)
    temperature = float(body.get("temperature", body.get("temp", 0.8)))
    include_usage = bool((body.get("stream_options") or {}).get("include_usage"))

    prompt, images_b64 = build_prompt(MODEL_PATH, messages)
    prompt_tokens = tokenize(MODEL_KIT, prompt)
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    completion = ""

    yield chunk_sse(
        {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": MODEL_ID,
            "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
        }
    )

    finish_reason = "stop"
    with GENERATION_LOCK:
        generator = create_generator(
            MODEL_KIT,
            prompt_tokens,
            images_b64=images_b64 or None,
            temp=temperature,
            max_tokens=max_tokens,
        )
        for result in generator:
            text = result.text or ""
            if text:
                completion += text
                yield chunk_sse(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": MODEL_ID,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"content": text},
                                "finish_reason": None,
                            }
                        ],
                    }
                )
            stop = getattr(result, "stop_condition", None)
            if stop:
                finish_reason = stop_reason_to_finish(stop)
                break

    yield chunk_sse(
        {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": MODEL_ID,
            "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
        }
    )

    if include_usage:
        usage = {
            "prompt_tokens": len(prompt_tokens),
            "completion_tokens": max(1, len(completion) // 4),
            "total_tokens": len(prompt_tokens) + max(1, len(completion) // 4),
        }
        yield chunk_sse(
            {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": MODEL_ID,
                "choices": [],
                "usage": usage,
            }
        )

    yield b"data: [DONE]\n\n"


class Handler(BaseHTTPRequestHandler):
    server_version = "revolver-mlx-server/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[revolver_mlx_server] {self.address_string()} - {fmt % args}")

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/health", "/healthz"):
            self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/models":
            self._send_json(
                200,
                {
                    "object": "list",
                    "data": [{"id": MODEL_ID, "object": "model", "owned_by": "revolver"}],
                },
            )
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/v1/chat/completions":
            self._send_json(404, {"error": "not found"})
            return

        try:
            body = self._read_json()
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid json"})
            return

        if MODEL_KIT is None:
            self._send_json(503, {"error": "model not loaded"})
            return

        stream = bool(body.get("stream"))
        if stream:
            # Close after the event stream. keep-alive + no Content-Length leaves
            # Electron/undici waiting forever even after data: [DONE].
            self.close_connection = True
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                for chunk in stream_generation(body):
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except Exception as exc:
                err = json.dumps({"error": str(exc)}).encode("utf-8")
                self.wfile.write(f"data: {err.decode()}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
            return

        try:
            completion, usage = run_generation(body)
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})
            return

        self._send_json(
            200,
            {
                "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": MODEL_ID,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": completion},
                        "finish_reason": "stop",
                    }
                ],
                "usage": usage,
            },
        )


def main() -> None:
    global MODEL_KIT, MODEL_PATH, MODEL_ID, CONTEXT_LENGTH

    parser = argparse.ArgumentParser(description="Revolver mlx-engine OpenAI server")
    parser.add_argument("--model", required=True, help="Model directory path or HF id")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    MODEL_PATH = resolve_model_path(args.model)
    MODEL_ID = MODEL_PATH.name or "local"

    print(f"[revolver_mlx_server] loading model from {MODEL_PATH}", flush=True)
    MODEL_KIT = load_model(str(MODEL_PATH), max_seq_nums=1, trust_remote_code=False)
    info = get_runtime_load_info(MODEL_KIT)
    CONTEXT_LENGTH = info.get("context_length")
    print(
        f"[revolver_mlx_server] model loaded (context={CONTEXT_LENGTH or 'unknown'})",
        flush=True,
    )

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[revolver_mlx_server] listening on http://{args.host}:{args.port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
