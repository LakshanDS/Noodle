#!/usr/bin/env python3
"""Gemini keep-alive ping.

Runs ONCE per invocation and exits -- drive it from cron / Task Scheduler.
Sends a tiny "hello" request to each model in Models.json and retries for
up to DEADLINE_SECONDS on any non-2xx (429, 5xx, network errors, ...).

Zero dependencies: pure Python standard library.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, ".env")
MODELS_PATH = os.path.join(HERE, "Models.json")
LOG_PATH = os.path.join(HERE, "ping.log")

DEADLINE_SECONDS = 5 * 60   # give up after this many seconds of retries
INITIAL_BACKOFF = 5         # seconds between first retry
MAX_BACKOFF = 60            # cap backoff at one minute
HTTP_TIMEOUT = 30           # per-request timeout
MAX_WORKERS = 8             # parallel model calls


def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_env(path):
    """Parse a simple KEY=VALUE .env file into os.environ (does not overwrite)."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            val = val.strip().strip('"').strip("'")
            os.environ.setdefault(key.strip(), val)


def load_models(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):       # single model -> wrap in a list
        return [data]
    return data                      # already a list of models


def resolve_key(value):
    """Models.json stores the NAME of an env var (e.g. "GEMINI_API").
    If that name exists in the environment, use the variable's value.
    Otherwise treat `value` as a literal key."""
    return os.environ.get(value, value)


def call_model(cfg):
    """Ping one model config. Returns (model_id, ok: bool, message)."""
    base = cfg["BASE_URL"].rstrip("/")
    model = cfg["MODEL_ID"]
    key = resolve_key(cfg["API_KEY"])

    url = f"{base}/models/{model}:generateContent?key={key}"
    payload = json.dumps(
        {"contents": [{"parts": [{"text": "hello"}]}]}
    ).encode("utf-8")

    deadline = time.time() + DEADLINE_SECONDS
    backoff = INITIAL_BACKOFF
    attempt = 0
    last_error = "no attempt made"

    while time.time() < deadline:
        attempt += 1
        try:
            req = urllib.request.Request(
                url,
                data=payload,
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                if 200 <= resp.status < 300:
                    body = json.loads(resp.read().decode("utf-8"))
                    reply = _extract_text(body)
                    msg = f"[{model}] OK on attempt {attempt}: {reply!r}"
                    log(msg)
                    return model, True, msg
                last_error = f"HTTP {resp.status}"
        except urllib.error.HTTPError as e:
            last_error = f"HTTP {e.code}"
            try:
                detail = e.read().decode("utf-8", errors="replace")[:160]
                last_error += f" - {detail}"
            except Exception:
                pass
            log(f"[{model}] attempt {attempt} failed: {last_error}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_error = f"network error: {e}"
            log(f"[{model}] attempt {attempt} failed: {last_error}")

        time.sleep(backoff)
        backoff = min(backoff * 2, MAX_BACKOFF)

    msg = f"[{model}] DEADLINE exceeded after {attempt} attempts ({last_error})"
    log(msg)
    return model, False, msg


def _extract_text(body):
    """Pull the first text part out of a Gemini generateContent response."""
    try:
        parts = body["candidates"][0]["content"]["parts"]
        for p in parts:
            if "text" in p:
                return p["text"].strip().replace("\n", " ")[:80]
        return "(no text in response)"
    except (KeyError, IndexError):
        return f"(unexpected response: {json.dumps(body)[:120]})"


def main():
    load_env(ENV_PATH)
    models = load_models(MODELS_PATH)
    log(f"pinging {len(models)} model(s)...")

    results = []
    workers = max(1, min(MAX_WORKERS, len(models)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(call_model, cfg) for cfg in models]
        for fut in as_completed(futures):
            results.append(fut.result())

    ok_count = sum(1 for _, ok, _ in results if ok)
    log(f"done: {ok_count}/{len(results)} succeeded")

    # Exit 0 only if every model succeeded.
    sys.exit(0 if ok_count == len(results) else 1)


if __name__ == "__main__":
    main()
