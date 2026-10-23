# LLMLingua / LLMLingua-2 — research for a local OpenCode compression plugin

Researched 2026-10-22 from the upstream repo/source, PyPI, HF model cards, papers, GitHub issues, and
first-party measurements (M3 Pro, 18 GB, macOS 27.0.1, Python 3.12.9; `llmlingua` 0.2.2, `torch` 2.14.1,
`transformers` 5.20.2).

**Verdict:** LLMLingua-2 is the only variant worth shipping locally. It's a BERT-sized token
classifier: 0.7 GB model, ~0.22–0.31 s per 1k tokens on M3 Pro CPU, no CUDA, MIT/Apache-2.0.
Good for verbose prose and (marginally) tool output; **not** safe for code, JSON, diffs, or enumeration-heavy
tasks without guards. LLMLingua-1/LongLLMLingua need a 7B LM and aren't viable on an 18 GB laptop.

---
## 1. Install, dependencies, footprint, license

```bash
pip install llmlingua            # PyPI 0.2.2, uploaded 2024-04-09
```

| Item | Value |
|---|---|
| Package | `llmlingua` 0.2.2 ([PyPI](https://pypi.org/project/llmlingua/)); repo `main` adds unreleased `use_slingua` (SecurityLingua) that 0.2.2 lacks |
| Declared Python | `>=3.8.0` ([setup.py](https://github.com/microsoft/LLMLingua/blob/main/setup.py)); current torch 2.14 requires `>=3.10`, so use **3.10–3.12** (tested 3.12.9) |
| Dependencies | `transformers>=4.26`, `accelerate`, `torch`, `tiktoken`, `nltk`, `numpy` — no `sentencepiece`, no `faiss`, no `openai` needed for LLMLingua-2 |
| Install weight | 786 MB `site-packages` measured; macOS arm64 torch wheel is 127 MB compressed |
| Code license | MIT ([LICENSE](https://github.com/microsoft/LLMLingua/blob/main/LICENSE)) |

| Model | Params | Download (fp32 safetensors) | License |
|---|---|---|---|
| `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` | 177.3 M | **709 MB** (+ 4 MB tokenizer) | **apache-2.0** per [model card](https://huggingface.co/microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank) |
| `microsoft/llmlingua-2-xlm-roberta-large-meetingbank` | 558.9 M | **2.24 GB** (+ 17 MB tokenizer) | **mit** per [model card](https://huggingface.co/microsoft/llmlingua-2-xlm-roberta-large-meetingbank) (card title is a copy-paste error; it is XLM-R large) |

Sizes/params verified via the HF API (`safetensors.total`, file listing), not the prose cards.

**Constructor traps**

- Defaults are `model_name="NousResearch/Llama-2-7b-hf"`, `device_map="cuda"`; this fails on a Mac
  (`Torch not compiled with CUDA enabled`, [#55](https://github.com/microsoft/LLMLingua/issues/55);
  CPU fallback still unmerged, [#244](https://github.com/microsoft/LLMLingua/pull/244)). Always pass both.
- `model_name` **must contain** `bert-base-multilingual-cased`, `xlm-roberta-large`, `tinybert`,
  `mobilebert`, `slingua`, or `securitylingua`; `is_begin_of_new_word()` raises `NotImplementedError`
  otherwise ([utils.py](https://github.com/microsoft/LLMLingua/blob/main/llmlingua/utils.py)), so a local
  snapshot path breaks compression — use the HF repo id.
- Init adds 100 `[NEWi]` special tokens and resizes embeddings (the `force_tokens` mechanism);
  `max_force_token=100` is the hard cap.
- Cold start measured: import 2.3–2.5 s, model load 2.0–2.3 s from warm cache; first MPS call +1.1 s.
  Warm it at startup.

---
## 2. API

```python
PromptCompressor(
    model_name="NousResearch/Llama-2-7b-hf", device_map="cuda", model_config={},
    open_api_config={}, use_llmlingua2=False, llmlingua2_config={},
)
# llmlingua2_config: {"max_batch_size": 50, "max_force_token": 100}  (only these two)
```

`compress_prompt(...)` is the single entry point; it dispatches to `compress_prompt_llmlingua2` when
`use_llmlingua2=True` ([source](https://github.com/microsoft/LLMLingua/blob/main/llmlingua/prompt_compressor.py)).

| Argument | LLMLingua-1 / LongLLMLingua | LLMLingua-2 |
|---|---|---|
| `context` | `str` or `List[str]` (joined `"\n\n"`) | `str` or `List[str]`; each doc chunked separately, output joined `"\n\n"` |
| `rate` | target compressed/original fraction, default 0.5 | **fraction of tokens kept**, default 0.5; empirically 0.8→80.5%, 0.6→61.4%, 0.35→38.0% |
| `target_token` | overrides `rate` | overrides `rate` (`rate = target/origin`) |
| `instruction`, `question` | used | **accepted but ignored** — not forwarded; LLMLingua-2 is task-agnostic |
| `condition_in_question`, `condition_compare`, `reorder_context`, `dynamic_context_compression_ratio`, `use_sentence_level_filter`, `keep_*_sentence`, `rank_method`, `token_budget_ratio`, `iterative_size` | supported | **silently ignored** |
| `use_context_level_filter` | default `True` | default `True` via `compress_prompt`, `False` in the direct method; dropping whole docs is bad for an agent — set `False` |
| `target_context`, `context_level_rate`, `context_level_target_token` | – | coarse doc-level filter |
| `use_token_level_filter` | PPL token filter | token classification on/off |
| `force_tokens`, `force_reserve_digit`, `drop_consecutive` | supported | supported; ≤100 forced tokens, digits kept, adjacent duplicates dropped |
| `chunk_end_tokens` / `return_word_label` | – | chunk boundaries (`[".", "\n"]`) / per-word labels |

There is **no `condition_instr` parameter** (the brief's spelling); the real one is `condition_in_question`, which LLMLingua-2 ignores.

**Fixed internal limits:** `max_seq_len = 512` is hard-coded in `init_llmlingua2`; text is split into
≤510-token chunks at the last `chunk_end_tokens` occurrence, so chunks are compressed independently.
`max_batch_size = 50` chunks per forward pass. For long docs, add `"\n\n"`, `";"`, `"}"` to
`chunk_end_tokens` to avoid cuts mid-record.

**Return value** (dict): `compressed_prompt` (str), `compressed_prompt_list` (per-doc list; length shrinks
if context filtering drops docs), `origin_tokens`, `compressed_tokens`, `ratio` (`"3.1x"`),
`rate` (`"32.3%"`), `saving` (string, computed at a stale `$0.06/1k` GPT-4 price), plus
`fn_labeled_original_prompt` when `return_word_label=True`. Token counts use `tiktoken`
`cl100k_base` (`encoding_for_model("gpt-3.5-turbo")`), **not** the downstream model's tokenizer, so use
your own tokenizer for budget accounting.

`compress_json()` exists but a maintainer confirms **LLMLingua-2 doesn't support it**
([#183](https://github.com/microsoft/LLMLingua/issues/183)).

---
## 3. Performance

Published (LLMLingua-2 paper, [arXiv:2403.12968](https://arxiv.org/abs/2403.12968), Table 5, V100-32G,
MeetingBank prompts of 3,003 tokens):

| Compressor | 2× | 3× | 5× |
|---|---|---|---|
| LLMLingua-2 | **0.5 s** | **0.4 s** | **0.4 s** |
| LLMLingua | 2.9 s | 2.1 s | 1.5 s |
| Selective-Context | 15.9 s | 15.6 s | 15.5 s |

Same paper: 3–6× faster compression, 1.6–2.9× end-to-end speedup, peak GPU memory **2.1 GB** vs 16.6 GB
(LLMLingua) / 26.5 GB (Selective-Context) (Appendix I), i.e. ~7.5k tokens/s for the large model on V100.
LLMLingua-2 is one encoder forward per 512-token chunk, batched 50 at a time: linear in input tokens,
fixed per-chunk constant, no KV cache and no token-by-token loop.

**Measured here (BERT-small, 4 content types, median of 3 warm runs):**

| Device | 1k tokens | 8k tokens | Throughput |
|---|---|---|---|
| M3 Pro CPU | 0.22–0.41 s | 1.9–2.2 s | ~3.6k–4.3k tok/s |
| M3 Pro MPS | 0.10–0.14 s | 0.69–0.79 s | ~10k–11.7k tok/s |

Load: 2.0–2.3 s warm cache. RSS after load+compress on CPU: **864 MB**; MPS run peaked at 1.47 GB
(process cumulative). MPS is ~3× faster in steady state but the first call is ~1.2 s vs 0.1 s, so a
warmup call is mandatory. MPS isn't officially documented; it works via `device_map="mps"`
([#184](https://github.com/microsoft/LLMLingua/issues/184)) with torch 2.14.1. CPU is forced to
**float32** by `load_model` (`"auto" if device_map == "cuda" else torch.float32`), which is why CPU
memory is ~0.9 GB for the small model.

XLM-R large: estimated 2.5–3.5× the small model's latency (355 M vs 110 M params) — expect
~0.6–0.9 s/1k and ~5–7 s/8k on CPU, ~0.25–0.35 s/1k and ~2–2.5 s/8k on MPS. Not measured (2.2 GB
download); treat as an estimate.

**No hard max input**, but every chunk is independent, so cross-chunk references degrade. Keep calls
≤8–16k tokens and split at document/record boundaries. One cosmetic issue: `get_token_length` calls the
tokenizer on the full text, so transformers logs `Token indices sequence length is longer than 512` on
every >512-token call — suppress `transformers` logging in the daemon.

---
## 4. Quality

LLMLingua-2 only **deletes tokens**; output is a subsequence of the input. It can't hallucinate content,
but it produces ungrammatical text and destroys formatting. Trained on GPT-4-distilled MeetingBank
(meeting transcripts), so its notion of "important" is content words in speech.

Paper results (Table 2, LongBench, 3k-token budget, GPT-3.5; higher is better):

| Task | Original | LLMLingua-2 | LLMLingua-2-small |
|---|---|---|---|
| SingleDoc | 39.7 | 35.5 | 35.5 |
| MultiDoc | 38.7 | 38.7 | 38.1 |
| Summarization | 26.5 | 26.3 | 26.2 |
| FewShot | 67.0 | 69.6 | 67.5 |
| **Synthetic** | **37.8** | **21.4** | **23.9** |
| Code | 54.2 | 62.8 | 60.0 |
| Average | 44.0 | 42.4 | 41.9 |

- **Synthetic tasks are the worst case** (−16 pts at 3×): passage counting/retrieval questions that need
  exact enumeration collapse. Few-shot is unaffected (67.0→69.6), and code completion even improves
  (54.2→62.8), but the latter measures edit similarity on *retrieved context*, not exact-syntax edits.
  Locally at `rate=0.5`, a 12-line Python function became
  `process items / results = / active / . append id / ...` — indentation and syntax gone. Never compress
  code that will be edited or diffed.
- JSON and tables at 0.5 lost keys, braces, and alignment (`cust 2`, `cents 2001`) and are invalid;
  structured formats are unsupported ([#50](https://github.com/microsoft/LLMLingua/issues/50)). Logs only
  reached 1.4× and lost field names; prefer dedup/tail for logs.
- Other failures: alphanumeric IDs corrupted ([#93](https://github.com/microsoft/LLMLingua/issues/93)),
  whitespace removed, chunk-boundary context loss, repeated forced newlines without `drop_consecutive`,
  and whole docs dropped by the context filter (6 of 8 survived in my test). Non-English is plausible
  (mBERT/XLM-R; Chinese LongBench in Appendix J) but the compressor was trained on English only.

**Suggested rates** (conservative, for an agent transcript): prose/docs 0.6–0.7. Verbose tool output
0.6–0.7 with a length gate; code/diff/JSON **skip** (or 0.8+ only for reference material never edited);
logs skip or 0.7 with `force_reserve_digit`; instructions/questions/system prompt never compressed.

**Agentic coding evidence:** I found no published benchmark of LLMLingua on SWE-style agent loops.
Evidence is indirect: the synthetic-task collapse above, the BBH drop (61.9 vs 70.1), the local
code/JSON samples, and the fact that exact identifiers, paths, and whitespace matter for edits. Treat
compression of code-adjacent context as experimental and gate it behind an A/B task-success check.

---
## 5. Practical integration

- **Daemon, not per-call spawn.** Per-call subprocess measured at **2.7–2.9 s wall** (import 1.9–2.4 s,
  load 0.26–0.37 s, compress 0.23–0.29 s); warm in-process compress is 0.22–0.31 s/1k. A long-lived
  Python worker (JSON-lines over stdio or localhost HTTP) is mandatory; HTTP adds 1–3 ms.
- **Warmup:** one dummy `compress_prompt` after load; on MPS the first call is 10× slower.
- **Batching:** a list of docs does **not** speed up compute — 1.06 s for 8×1k docs in one call vs 1.09 s
  sequentially (the model already batches 50 chunks). Batch only to save IPC and keep doc boundaries;
  set `use_context_level_filter=False` so no doc is dropped.
- **Caching:** outputs are deterministic (`seed_everything(42)`; identical hash across runs). Cache on
  `sha256(text|model|rate|force_tokens|chunk_end_tokens)`, LRU 200–500; cached calls are ~0 ms.
- **Concurrency:** serialize through one worker/queue; the MPS allocator and embedding resize aren't
  built for concurrent calls, and parallel calls compete for the same 1–3 GB of process memory.
- **Guardrails:** skip if `<1.5k` tokens; skip code/JSON/diff; pass through if
  `compressed_tokens/origin_tokens > 0.9` or a required-literal check fails; 5 s timeout with fallback.
- **Version pinning:** 0.2.2 is from April 2024 and imports cleanly with transformers 5.20.2 in my test,
  but that is luck, not a guarantee. Pin `llmlingua`, `torch`, `transformers`, `tokenizers`.

**Alternatives**

| Method | When better | Cost |
|---|---|---|
| LLMLingua-1 | higher ratios (up to 20×), question-aware, reasoning-heavy prompts | Llama-2-7B, 16.6 GB VRAM, 2–3 s per 3k tokens; impractical locally |
| LongLLMLingua | multi-doc RAG with a question; reorders docs, dynamic per-doc ratios; best published LongBench scores (48.8 vs 44.0 original) | same 7B cost; needs `question` |
| SelectiveContext | simple, no training; GPT-2 self-information | slowest (15.5 s/3k), weakest quality |
| [Provence](https://arxiv.org/abs/2501.16214) | query-aware sentence pruning for retrieved documents; cheap DeBERTa reranker, drops whole sentences (safer syntax) | needs a query; sentence-level only; different model/licence |
| Native LLM summarization | logs, tables, very large tool output where semantics matter more than exact strings | one extra model call, abstractive, can hallucinate |
| Deterministic compaction | always first: strip ANSI, dedupe repeated lines, collapse stack traces, head/tail truncate | ~0 ms, lossless-ish, no model |

---
## 6. Recommendation for this project

1. **Model:** `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` (709 MB, 110 M params,
   Apache-2.0). It is within ~1 point of XLM-R large on LongBench (41.9 vs 42.4) and Mistral-7B
   MeetingBank QA (75.97 vs 76.22) at ~3× the speed and ⅓ the memory; offer XLM-R large as opt-in only.
2. **Rates:** prose/docs `0.6`; tool output `0.65`; never below `0.5` for anything the agent must reason
   over. Code, diffs, JSON, YAML, and few-shot/example blocks: **no compression**. Instructions and the active
   user turn: no compression. Compress only messages older than the last 1–2 turns.
3. **Latency budget (M3 Pro, BERT-small):** CPU 0.22–0.31 s/1k, 1.9–2.2 s/8k; MPS 0.09–0.14 s/1k,
   0.69–0.79 s/8k, plus 2.0–2.3 s one-time load and a warmup call. With a 1.5k-token gate, most turns
   cost 0–0.4 s.
4. **Deployment shape:** one Python daemon started with OpenCode (or lazily), model loaded once, one
   queue, JSON-lines protocol, 5 s timeout, content-hash cache, `/health` reporting model/device/warm.
5. **Fallback:** on any exception, timeout, import failure, or when `compressed_tokens >= 0.9 *
   origin_tokens`, return the original unchanged and record a metric. Ship disabled by default; measure
   task success and tool-call accuracy before enabling for code-adjacent context.

**Config sketch**

```python
pc = PromptCompressor(
    model_name="microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank",
    use_llmlingua2=True, device_map="mps",   # fall back to "cpu"
)
pc.compress_prompt(
    docs, rate=0.6, use_context_level_filter=False,
    force_tokens=["\n", ".", "?", "!", ",", ":", "/", "-", "_"],
    force_reserve_digit=True, drop_consecutive=True,
    chunk_end_tokens=[".", "\n", "\n\n"],
)
```

---
## 7. Could not verify / caveats

- XLM-R large latency and RSS were **not measured** (2.2 GB download); the numbers above are scaling
  estimates from parameter count.
- No published evaluation of LLMLingua-2 on agentic coding (SWE-bench-style) was found; the code-quality
  claim rests on the paper's LongBench Code column and my local samples.
- `device_map="mps"` is community-supported, not documented upstream; it works on torch 2.14.1 /
  transformers 5.20.2 but may break on other versions.
- The XLM-R card's title says "Bert-base..." (copy-paste error); weights are XLM-R large, licence MIT.
- The brief's arXiv id 2310.05736 is **LLMLingua v1**, not LLMLingua-2; LLMLingua-2 is **2403.12968**
  ([paper](https://arxiv.org/abs/2403.12968)). LongLLMLingua is 2310.06839 as stated.
- The `compress_prompt` docstring says LLMLingua-2 `rate` "should be >= 1.0"; that is wrong — it's a
  keep-fraction in (0, 1], confirmed by measurement.
