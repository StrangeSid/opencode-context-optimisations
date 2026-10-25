# Optional LLMLingua sidecar

`llmlingua_worker.py` is a small, warm HTTP worker for the Node plugin. It is
optional: `src/plugin.ts` stays inert until you configure an endpoint.

The worker is deliberately boring. It loads one LLMLingua-2 model, serializes
inference with a lock, and exposes two endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Model/device/readiness and request counters |
| `POST` | `/compress` | `{"text", "rate", "model", "kind"}` -> `{"text", ...}` |

## Install and run

```bash
# From the repository root. Keep this separate from the Node install.
uv venv .venv-worker --python 3.12
uv pip install --python .venv-worker/bin/python -r python/requirements.txt

# CPU (default), listening only on loopback
.venv-worker/bin/python python/llmlingua_worker.py --port 8765

# Apple Silicon is faster after the first call
.venv-worker/bin/python python/llmlingua_worker.py --device mps --port 8765
```

The default model (`microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank`)
is Apache-2.0 and ~709 MB; it is downloaded on first use. `--preload` is on by
default, so startup waits for the model; use `--no-preload` to start
immediately and pay the load cost on the first request.

```bash
curl -s http://127.0.0.1:8765/health
curl -s http://127.0.0.1:8765/compress \
  -H 'content-type: application/json' \
  -d '{"text":"This is a long explanatory paragraph that can lose some words.","rate":0.6}'
```

## Configure the plugin

Relative plugin paths resolve from the config file; use an absolute path if
this config lives outside the repository.

```jsonc
{
  "plugins": [
    {
      "package": "./src/plugin.ts",
      "options": {
        "endpoint": "http://127.0.0.1:8765/compress",
        "protectedTurns": 2,
        "minTokens": 400,
        "budgetTokens": 2000,
        "rate": 0.6,
        "timeoutMs": 1200,
        "watermarkRatio": 0.7,
        "compactionEnabled": true,
        "toolOutputEnabled": false,
        "expandToolEnabled": true,
        "validateLiterals": true
      }
    }
  ]
}
```

The plugin leaves `system`, `tools`, tool-call inputs, reasoning parts,
compaction parts, JSON tool results, and error tool results untouched. It only
replaces text parts and textual tool-result payloads older than the protected
window. The request lane is watermark-gated; compaction pre-compresses the
summarizer transcript. The incremental `execute.after` lane is default-off
because persistence is unverified. Compressed spans get `[ctx_expand:...]`
markers unless `expandToolEnabled` is false.

If you run the worker with a non-default `--model`, set the plugin's `modelId`
to the same model identifier. `modelId` is part of the cache key; leaving it at
the default while swapping the worker model can reuse stale compressed text.

## Quality harness

`research/eval_quality.mjs` drives an A/B fact-retention test through the
OpenCode Go API. Add `OC_GO_KEY` to a gitignored `.env` (copy
`.env.example`), start this worker, then run:

```bash
npm run eval:quality -- --runs 2
```

The default judge is `deepseek-v4.1-flash`. The harness reports per-fact
retention, estimated token reduction, and API cost.

## Limits

- The worker binds to `127.0.0.1` by default. Do **not** expose it publicly;
  there is no authentication.
- Requests are serialized. The model is not safe to call concurrently.
- The plugin's 1,200 ms default deadline is intentionally below the research's
  measured 2.6 s cold-process cost. A preloaded worker is required for useful
  hit rates.
- This is still a lossy compressor. Read [FINDINGS.md](../FINDINGS.md) and the
  quality caveats in [research/bench.md](../research/bench.md) before enabling
  it for code-adjacent prose.
