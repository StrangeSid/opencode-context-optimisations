# Research index

Version-pinned notes behind [FINDINGS.md](../FINDINGS.md). Verified on 2026-10-22 against OpenCode v2.1.3.

| File | What it covers |
|---|---|
| [`opencode-v2-hooks.md`](./opencode-v2-hooks.md) | Exact V2 plugin/hook declarations, timing, mutation semantics, compaction ordering, token visibility, V1 migration, open questions |
| [`reference-repo.md`](./reference-repo.md) | Line-by-line audit of `evermeer/context-optimizer`: bridge protocol, config, triggers, limitations, reusable pieces |
| [`llmlingua.md`](./llmlingua.md) | LLMLingua/LLMLingua-2 install, API, model sizes, quality evidence, daemon vs spawn, alternatives |
| [`bench.md`](./bench.md) | M3 Pro CPU benchmark: latency, startup, footprint, quality spot checks, verdict |
| [`bench.json`](./bench.json) | Raw benchmark runs (36 runs, 12 configs, checksums) |
| [`bench_llmlingua.py`](./bench_llmlingua.py) | Reproducible Python benchmark script |
| [`bench_llmlingua_js.mjs`](./bench_llmlingua_js.mjs) | Ad-hoc JS/ONNX probe (TinyBERT / BERT-base) |
| [`bench_run.log`](./bench_run.log) | Full console output of the benchmark |

## Reproduce

```bash
uv venv .venv-bench --python 3.12
uv pip install --python .venv-bench/bin/python llmlingua
.venv-bench/bin/python research/bench_llmlingua.py --runs 3
```

The script sets `HF_HOME` to `.venv-bench/hf-cache`; the first run downloads ~680 MB of models.

JS/ONNX probe (TinyBERT, 57 MB) was run ad hoc; numbers are recorded in FINDINGS §3.2. To rerun:

```bash
mkdir -p /tmp/llm-js && cd /tmp/llm-js && npm init -y
npm install @huggingface/transformers@4.2.0 @atjsh/llmlingua-2@3.0.0 js-tiktoken
node research/bench_llmlingua_js.mjs
```
