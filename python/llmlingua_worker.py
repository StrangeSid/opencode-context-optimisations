#!/usr/bin/env python3
"""Warm HTTP sidecar for LLMLingua-2 request-lane compression.

The Node plugin posts one text span at a time. This worker keeps the model
resident, serializes inference, and exposes a tiny health endpoint. It is
intentionally optional: the plugin is inert until an endpoint is configured.

Run:
    .venv-bench/bin/python python/llmlingua_worker.py --port 8765

The first request is fast only when the model was preloaded (the default).
Use --no-preload to start immediately and load on first compression.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

DEFAULT_MODEL = "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_RATE = 0.6
DEFAULT_MAX_BODY_BYTES = 2_000_000
DEFAULT_MAX_INPUT_CHARS = 200_000

# Protect punctuation and separators that matter for readable prose. Code,
# JSON, diffs, and logs never reach this worker because the Node policy filters
# them first.
DEFAULT_FORCE_TOKENS = ["\n", ".", "?", "!", ",", ":", ";", "/", "-", "_"]
DEFAULT_CHUNK_END_TOKENS = [".", "\n", "\n\n", ";", "}"]


class CompressorService:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self._compressor: Any | None = None
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()
        self.requests = 0
        self.errors = 0
        self.last_latency_ms = 0.0

    @property
    def ready(self) -> bool:
        return self._compressor is not None

    def preload(self) -> None:
        with self._load_lock:
            if self._compressor is not None:
                return
            from llmlingua import PromptCompressor

            self._compressor = PromptCompressor(
                model_name=self.args.model,
                use_llmlingua2=True,
                device_map=self.args.device,
            )

    def compress(self, text: str, rate: float) -> dict[str, Any]:
        self.preload()
        started = time.perf_counter()
        assert self._compressor is not None
        options: dict[str, Any] = {
            "rate": rate,
            "use_context_level_filter": False,
            "force_reserve_digit": True,
            "drop_consecutive": True,
            "chunk_end_tokens": DEFAULT_CHUNK_END_TOKENS,
        }
        if not self.args.no_force_tokens:
            options["force_tokens"] = DEFAULT_FORCE_TOKENS

        with self._lock:
            result = self._compressor.compress_prompt([text], **options)

        output = result.get("compressed_prompt")
        if not isinstance(output, str) or not output.strip():
            raise RuntimeError("compressor returned empty text")

        self.last_latency_ms = (time.perf_counter() - started) * 1000.0
        return {
            "text": output,
            "origin_tokens": result.get("origin_tokens"),
            "compressed_tokens": result.get("compressed_tokens"),
            "latency_ms": round(self.last_latency_ms, 1),
        }

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "ready": self.ready,
            "model": self.args.model,
            "device": self.args.device,
            "rate": self.args.rate,
            "requests": self.requests,
            "errors": self.errors,
            "last_latency_ms": round(self.last_latency_ms, 1),
        }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Warm LLMLingua-2 compression sidecar")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    parser.add_argument("--rate", type=float, default=DEFAULT_RATE)
    parser.add_argument("--max-body-bytes", type=int, default=DEFAULT_MAX_BODY_BYTES)
    parser.add_argument("--max-input-chars", type=int, default=DEFAULT_MAX_INPUT_CHARS)
    parser.add_argument(
        "--preload",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Load the model before accepting requests (default: true)",
    )
    parser.add_argument(
        "--no-force-tokens",
        action="store_true",
        help="Do not force punctuation and separator tokens",
    )
    args = parser.parse_args(argv)
    if not 0.0 < args.rate <= 1.0:
        parser.error("--rate must be in (0, 1]")
    if args.port <= 0 or args.port > 65535:
        parser.error("--port must be in 1..65535")
    return args


def make_handler(service: CompressorService, args: argparse.Namespace) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "LLMLinguaWorker/0.1"

        def log_message(self, fmt: str, *values: object) -> None:
            sys.stderr.write("[worker] " + (fmt % values) + "\n")

        def send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler name
            if self.path != "/health":
                self.send_json(404, {"ok": False, "error": "not found"})
                return
            self.send_json(200, service.health())

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler name
            if self.path != "/compress":
                self.send_json(404, {"ok": False, "error": "not found"})
                return

            length_header = self.headers.get("content-length")
            try:
                length = int(length_header or "0")
            except ValueError:
                self.send_json(400, {"ok": False, "error": "invalid content-length"})
                return
            if length <= 0:
                self.send_json(400, {"ok": False, "error": "empty body"})
                return
            if length > args.max_body_bytes:
                self.send_json(413, {"ok": False, "error": "body too large"})
                return

            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_json(400, {"ok": False, "error": "invalid JSON"})
                return

            if not isinstance(payload, dict):
                self.send_json(400, {"ok": False, "error": "body must be an object"})
                return

            text = payload.get("text")
            if not isinstance(text, str) or not text.strip():
                self.send_json(400, {"ok": False, "error": "text must be a non-empty string"})
                return
            if len(text) > args.max_input_chars:
                self.send_json(413, {"ok": False, "error": "text too large"})
                return

            rate = payload.get("rate", args.rate)
            if not isinstance(rate, (int, float)) or isinstance(rate, bool):
                self.send_json(400, {"ok": False, "error": "rate must be a number"})
                return
            rate = float(rate)
            if not 0.0 < rate <= 1.0:
                self.send_json(400, {"ok": False, "error": "rate must be in (0, 1]"})
                return

            service.requests += 1
            try:
                result = service.compress(text, rate)
            except Exception as error:  # fail with a structured response
                service.errors += 1
                self.send_json(500, {"ok": False, "error": str(error)})
                return

            self.send_json(200, {"ok": True, **result})

    return Handler


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    logging.getLogger("transformers").setLevel(logging.ERROR)
    logging.getLogger("llmlingua").setLevel(logging.ERROR)

    service = CompressorService(args)
    if args.preload:
        started = time.perf_counter()
        print(
            f"[worker] loading {args.model} on {args.device} ...",
            file=sys.stderr,
            flush=True,
        )
        service.preload()
        print(
            f"[worker] model ready in {time.perf_counter() - started:.2f}s",
            file=sys.stderr,
            flush=True,
        )

    server = ThreadingHTTPServer((args.host, args.port), make_handler(service, args))
    server.daemon_threads = True
    print(
        f"[worker] listening on http://{args.host}:{args.port} "
        f"(preload={args.preload}, rate={args.rate})",
        file=sys.stderr,
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[worker] shutting down", file=sys.stderr, flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
