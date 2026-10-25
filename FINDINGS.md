# FINDINGS — making OpenCode use LLMLingua more often

**Status:** research spike, 2026-10-22; Phase 1.5/1.6 implementation update, 2026-10-25
**Target:** OpenCode v2.1.3 (`@opencode/plugin@2.1.3`), Apple M3 Pro / 18 GB / macOS
**Reference studied:** [`evermeer/context-optimizer`](https://github.com/evermeer/context-optimizer) v0.5.0, commit `d3fbe31`
**Local evidence:** [`research/`](./research) — hook types, reference audit, LLMLingua notes, benchmarks

---

## 0. TL;DR

1. **The reference is a useful skeleton, but it doesn't do what this project needs.** It calls LLMLingua only when OpenCode compacts, and each call spawns a fresh Python process that reloads three models. Measured cold start of that path is **2.6–4.2 s** before any compression. That architecture can't support "use LLMLingua more often."
2. **OpenCode V2 exposes the right hooks.** `ctx.session.hook("context")` runs before every agent-loop model request and can mutate the outgoing `system`, `messages`, `tools`, and `options`. `ctx.session.hook("compaction")` can pre-compress the transcript or replace the summarizer entirely via `event.result`. `ctx.tool.hook("execute.after")` can inspect or replace a tool result.
3. **`context` edits are transient.** History is rebuilt on every call, so the same old text returns next step. Compression must be **cached by content hash**, not written into message metadata, or it will be recomputed on every tool continuation.
4. **LLMLingua is a token-dropping compressor, not a summarizer.** On this machine LLMLingua-2 BERT-base takes **~0.20 s per 1k tokens** on CPU, **~1.6 s per 8k**, and **~0.7 s per 8k on MPS**. It is fast enough for selective use, not for blind whole-context compression on every call.
5. **Quality is the real blocker, not latency.** Measured output destroys code (`tsc` fails with `TS1005`, zero braces/newlines), collapses logs to one line, and loses negations in prose. LLMLingua must be restricted to **old natural-language text**, with code/JSON/logs/errors/recent turns protected.
6. **Auto-compaction can't be prevented from the `context` hook.** In 2.1.3 the auto-compaction decision is made *before* `request.primary` triggers the hook. Compression lowers cost and overflow risk, but native compaction still fires at its threshold. Disabling `compaction.auto` is a separate, riskier decision.
7. **Recommended shape:** a V2 plugin with three lanes — **continuous request compression** (old prose only, watermark-triggered), **compaction pre-compression** (reduce the summarizer's input), and **optional tool-output compression** (structural pruning, not token-level). Plus a content-hash cache, warm worker, and a `context_expand` tool so lossy compression is recoverable.
8. **Expected saving is unknown and probably modest in code-heavy sessions.** Tool results dominate a coding transcript, and most of them are code, diffs, JSON or logs — all poor LLMLingua targets. The realistic wins are old prose/narration, web/doc output, pasted logs after structural pruning, and the compaction lane. Don't ship default-on until an A/B evaluation shows quality retention. The honest pitch is "compress the prose, preserve the code," not "compress everything."

---

## 1. What the reference actually does

Full audit: [`research/reference-repo.md`](./research/reference-repo.md).

### 1.1 Call graph

```
OpenCode compaction
  experimental.session.compacting  → flag session
  experimental.chat.messages.transform
    → messagesToDocs()               (one "doc" per whole message)
    → buildPayload()                 (query = DEFAULT_QUERY)
    → spawn python3 context_optimizer_cli.py
         → load CrossEncoder (bge-reranker-large)
         → load SentenceTransformer (all-MiniLM-L6-v2)
         → load PromptCompressor (LLMLingua-2 BERT/XLM-R)
         → purge error docs, rerank, dedupe, budget 8k chars, max 12 chunks
         → compress_prompt(rate=0.6)
         → exit
    → splice optimized text into messages
```

Per-turn (`experimental.chat.messages.transform` on ordinary turns) it runs **only TypeScript**:

- Dedupe identical tool calls (same name + parameters), keep newest output;
- Replace string inputs of errored tool calls older than 4 user turns with a marker.

No LLMLingua. No Python. The README's own warning says the compaction result is smaller but often misses vital context.

### 1.2 Why it cannot simply be run "more often"

| Problem | Evidence | Consequence |
|---|---|---|
| Process-per-call | `packages/core/src/bridge.ts:59-138`; measured 2.59 s offline / 3.3–4.2 s online startup | Per-turn use is impossible without a daemon |
| Three heavy models loaded per call | `python/context_optimizer.py:34-67` | ~1–2 GB RAM, seconds of init, failure coupling |
| Compaction-only trigger | `packages/opencode/src/plugin.ts:300-351` | No compression during normal turns |
| Over-aggressive budget | 8,000-char budget + `max_chunks=12` (`config.ts:9-13`), one doc = one message | Ranking keeps only a handful of messages |
| Ranking destroys chronology | docs sorted by reranker score, never restored (`context_optimizer.py:134-166`) | Model sees reordered history |
| Generic query | `DEFAULT_QUERY` (`payload.ts:3,50`) | Reranker does not know the current task |
| Code is compressed | `PROTECTED_TOOLS` only guards TS dedupe/purge; LLMLingua sees everything | Code/paths/JSON get mangled |
| Chars, not tokens | `initial_size`/`final_size` are chars; per-turn savings never recorded | "Saved %" is not a token metric |
| Mutates live message parts | markers written into `part.state` | Persisted history is altered; not reversible |
| No cache | new spawn each time | same text recompressed repeatedly |

**Verdict:** reuse the config/payload/stats patterns and the Python pipeline *ideas*, not the runtime architecture.

---

## 2. What OpenCode V2 makes possible

Exact declarations and runtime findings: [`research/opencode-v2-hooks.md`](./research/opencode-v2-hooks.md).

### 2.1 Relevant hooks

| Hook | When | What is mutable | Persistence | Fit |
|---|---|---|---|---|
| `ctx.session.hook("context", cb)` | Before **every agent-loop model request**, including tool continuations | `system`, `messages`, `tools`, `options` | **Transient** — affects only this call | Continuous compression |
| `ctx.session.hook("compaction", cb)` | Before OpenCode builds a checkpoint summary | transcript + `result` | `event.result` replaces the compaction | Compress/replace summarizer input |
| `ctx.tool.hook("execute.after", cb)` | After a tool completes | `result` (completed) / `error` | **Unverified** whether replacement is persisted | One-time tool-output compression |
| `ctx.session.hook("prompt", cb)` | Once at prompt admission | `prompt.text`, files, skills | **Persisted** | Not recommended for lossy compression |
| `ctx.event.subscribe()` | Public event stream | read-only | n/a | Token accounting (`session.step.ended`) |
| `ctx.storage` | Plugin KV | JSON | Durable | Cache/stats/config |

### 2.2 The two facts that shape the design

**Fact A — `context` runs per model call, not per user turn.**
A single tool-heavy turn can produce 5–20 model calls. Compressing the whole history on each call would be catastrophic. The stable prefix must be compressed once and served from cache; only the tail changes.

**Fact B — auto-compaction is decided before the hook.**
From the 2.1.3 runtime:

```ts
const context = load()
const compaction = await compact({ reason: "auto", context })
if (compaction.status === "completed") continue

const request = await request.primary({ ...context }) // fires "context" hook
```

So `context` compression **can't stop this step's auto-compaction**. It can lower the *next* step's measured usage (provider token counts reflect the compressed request), which may influence later thresholds indirectly. Don't promise "no more compaction."

**If the product goal is compression instead of compaction**, the only honest options are:

1. Accept compaction and use LLMLingua to reduce cost between compactions (recommended);
2. Set `compaction.auto: false` and rely on compression, accepting a one-shot overflow recovery (risky);
3. Make compression durable (`prompt` or `tool.execute.after`, both lossy and not clearly persisted);
4. Use the `compaction` hook to make compaction cheaper/better, not to avoid it.

### 2.3 The reference plugin is V1-only

The reference's `packages/opencode/src/plugin.ts` returns V1 hooks (`command.execute.before`, `experimental.session.compacting`, `experimental.chat.messages.transform`). **V2 doesn't translate these.** It loads the default export's `id` and `setup()`; a V1 `server()` implementation is ignored. The reference must be ported, not installed, on v2.1.3. Its Python pipeline and config logic can be reused behind the V2 hooks.

### 2.4 Messages are not `{info, parts}`

The V2 `Message` is a class:

```ts
class Message {
  readonly id?: string
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content: ContentPart[]
  readonly metadata?: Record<string, unknown>
  readonly providerMetadata?: Record<string, Record<string, unknown>>
  readonly native?: Record<string, unknown>
}
```

Tool results are a tagged union: `{ type: "text" | "json" | "error" | "content"; value: unknown }`. Any implementation must descend into `result` and handle those variants, and must never break `tool-call`/`tool-result` id pairing. This is a common porting trap for code written against V1.

---

## 3. LLMLingua reality check

Sources: [`research/llmlingua.md`](./research/llmlingua.md), [`research/bench.md`](./research/bench.md), raw [`research/bench.json`](./research/bench.json).

### 3.1 What it is

LLMLingua-2 is a **BERT-sized token classifier** trained to predict which tokens to keep. It splits text into ≤512-token chunks, scores each token, and keeps the top `rate` fraction. It is task-agnostic: `instruction`, `question`, `condition_in_question`, and `reorder_context` are accepted but ignored for LLMLingua-2. `rate=0.6` means "keep 60% of tokens," not "compress to 60% of the original size" (close, but measured 0.605–0.61).

The output is reconstructed by joining word pieces with spaces. That's why punctuation, indentation, and newlines are lost. It isn't a formatting-preserving editor.

### 3.2 Measured performance (this machine)

Python `llmlingua` 0.2.2, model `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` (709 MB, Apache-2.0):

| Device | 1k tokens | 2k log | 8k tokens | Model load (warm disk) |
|---|---:|---:|---:|---:|
| M3 Pro CPU | 0.20–0.22 s | 0.49 s | 1.62 s | 0.25 s |
| M3 Pro MPS | 0.10–0.14 s | — | 0.69–0.79 s | 0.25 s + ~1.2 s first call |

- Fresh process (spawn + import + load + compress): **2.59 s offline**, **3.3–4.2 s online**.
- Install weight: **1.41 GiB** venv (site-packages 768 MiB), model 680 MiB. `uv pip install llmlingua` took 5m43s.
- A warm daemon saves **~2.4 s per call** versus process-per-call. This is non-negotiable.

Pure-JS alternative, `@atjsh/llmlingua-2@3.0.0` + `@huggingface/transformers` + ONNX:

| Model | Size | Load (cached) | 1.3k chars | 10k chars | Quality |
|---|---:|---:|---:|---:|---|
| TinyBERT (`atjsh/llmlingua-2-js-tinybert-meetingbank`) | 57 MB | 341 ms | 12–14 ms | 105 ms | Visibly worse; mangles paths/identifiers |
| BERT base (`Arcoldd/llmlingua4j-bert-base-onnx`) | 710 MB | not completed (download stalled) | — | — | Expected close to Python BERT; unverified |
| MobileBERT | 99 MB | n/a | — | — | Transformers.js does not support `mobilebert` |

The JS port is attractive for packaging (no Python, no 1.4 GB venv, MIT, browser/Node). It's also explicitly **experimental, with no unit tests**, and the TinyBERT output at `rate=0.6` turned `"./utils.js"` into `". / utils. js "`. Treat it as a phase-3 packaging option, not the first implementation.

### 3.3 Quality evidence

From the local benchmark (`rate=0.6`):

- **TypeScript:** output had 0 newlines, 0 `{`, 0 `}`, mismatched parentheses; `tsc` failed immediately with `TS1005`. Not usable.
- **Build log:** 5,716 chars became 4,176 chars on **one line**; timestamps and structure destroyed. Key error strings happened to survive, but line-oriented consumers can't use it.
- **Prose:** readable but telegraphic. Negation markers dropped from 3→2 (1k) and 23→15 (8k). Keyword presence isn't task accuracy.

Published evidence (LLMLingua-2 paper): good on MeetingBank-style summarization/QA, but Synthetic tasks drop ~16 points and BBH ~8 points. **There's no published study of LLMLingua-2 inside an agentic coding loop.** Our local code test is a strong negative signal.

**Conclusion:** LLMLingua is suitable for *redundant natural-language narration* and for *compaction input that an LLM will summarize anyway*. It isn't suitable for code, diffs, JSON, logs, stack traces, exact identifiers, instructions, or the recent window.

---

## 4. Proposed design

### 4.1 Principles

1. **Selective, not universal.** Compress only content whose exact form doesn't matter.
2. **Transient by default.** Mutate the outgoing request, never persisted history. Add an explicit expand path for retrieval.
3. **Cache the stable prefix.** Compress each message/chunk once, keyed by content hash; serve repeats synchronously.
4. **Preserve chronology and tool pairing.** Compress in place; never reorder messages or drop a tool result without its call.
5. **Fail open.** Any timeout, malformed output, or classifier doubt → send the original text.
6. **Protect the tail.** The last N user turns and the current request stay verbatim.
7. **Make savings measurable.** Record tokens in/out per stage, latency, cache hit rate, and fallbacks.
8. **Don't break prompt caching.** The compressed prefix must be deterministic and stable across calls.

### 4.2 Three lanes

```
                    ┌──────────────────────────────────────────────┐
 user turn ────────▶│ ctx.session.hook("context")                  │
                    │  1. token budget / watermark                 │
                    │  2. protect recent + code + JSON + errors    │
                    │  3. cheap TS pruning (dedupe, ANSI, logs)    │
                    │  4. LLMLingua on old prose (cache misses)    │
                    │  5. replace text, leave ids/structure intact │
                    └──────────────────────────────────────────────┘
                                      │
 tool result ──────▶ ctx.tool.hook("execute.after")  (optional, phase 2)
                      structural prune only; no token-level LLMLingua
                                      │
 context limit ────▶ ctx.session.hook("compaction")
                      pre-compress transcript, preserve chronology,
                      keep code/paths/errors, then let the summarizer run
```

| Lane | Trigger | Content | Persistence | Implementation |
|---|---|---|---|---|
| **Request** | estimated usage >= watermark (default 0.70) | old prose / tool narration | transient | **Implemented** (heuristic watermark) |
| **Compaction** | native/manual compaction | transcript, code-safe | summarizer input | **Implemented** (precompress, no `event.result`) |
| **Tool output** | completed tool result above threshold | prose tool output | unverified | **Implemented**, default-off |
| **Expand** | model calls `context_expand` | stored originals | in-memory | **Implemented** |

The request lane is the direct answer to "use LLMLingua more often": it runs on model calls only when estimated context pressure crosses the threshold. The compaction lane precompresses the summarizer transcript. The tool-output lane is implemented but default-off because replacement persistence is unverified.

### 4.3 Content policy

| Content | Action | Reason |
|---|---|---|
| System prompt / instructions | **never** | exact behavior; prefix cache |
| Tool descriptions / JSON schemas | **never** | validation and tool calls |
| Current user message, last N turns | **never** | intent and exact wording |
| Assistant reasoning / encrypted parts | **never** | provider replay state |
| `tool-call` inputs | **never** | paths, ids, exact arguments |
| Code, diffs, patches | **never token-level**; optional AST/structural trim | syntax and identifiers |
| JSON / structured tool results | **never**; optional lossless minify + array truncation | schema |
| Errors / stack traces | **never**; extract and keep verbatim | diagnostics |
| Build/test logs | **structural prune**: strip ANSI, dedupe, keep head/tail + error/warn lines | line structure matters |
| Pasted logs in a user message | optional **structural prune at prompt admission**; never token-level | edits persist forever; only safe if deterministic and visible |
| `read` file output | **never**; keep exact; optionally replace huge old reads with a handle + head/tail | edit/copy fidelity |
| Old assistant prose | **yes**, rate 0.6–0.8 | redundant narration |
| Old user prose (not the request) | **yes, cautiously**, rate 0.8 | may contain requirements |
| Web pages / docs / search results | **yes**, rate 0.5–0.7 | verbose natural language |
| Tool-result prose (not logs/code) | **yes**, rate 0.6–0.8 | bulk of long context |

**Hard rule:** if the classifier isn't confident, don't compress. A false negative costs tokens; a false positive costs correctness.

### 4.4 Trigger algorithm

```
on context(event):
  limit      = model.limit.input ?? model.limit.context
  used       = lastStepTokens(session) + estimate(newTail)   # provider usage when available
  ratio      = used / (limit - outputReserve)
  candidates = collectOldParts(event.messages, protectedTurns=2)

  if ratio < soft (0.55):
      applyFreePruning(candidates)        # dedupe, ANSI, repeated lines
      return

  budget = used - target(ratio=0.45)      # how many tokens to remove
  applyFreePruning(candidates)
  if savings >= budget: return

  # stage 2: LLMLingua on safe prose only
  docs = classify(candidates).filter(isSafeProse).take(oldestFirst)
  docs = docs where estimatedTokens >= minChunk (e.g. 400)
  results = cache.getMany(hash(docs))
  missing = results.misses
  if missing and ratio >= high (0.70):
      results += worker.compressBatch(missing, rate=0.6, timeout=1200ms)
  replace text with results; on any failure keep original
```

Notes:

- **Two watermarks:** 0.55 for free pruning, 0.70 for paid LLMLingua. This keeps normal turns latency-free.
- **Budget-driven:** compress until the target is met, oldest first; don't compress the whole history every time.
- **Chunk cap:** 1–2k tokens per request; 8k takes 1.6 s on CPU and isn't acceptable on the critical path. Batch multiple small chunks into one worker call.
- **Rate:** 0.8 for user prose, 0.6 for assistant/tool narration. Lower rates save more but lose negations and numbers.
- **Token accounting:** subscribe to `session.step.ended` and use `tokens.input` (+ cache read/write as appropriate) as the measured baseline; add a character/token estimate for content appended since that step. Fall back to `chars/4` if no event has arrived. Flag the estimate in stats; don't pretend it is exact.

> **Implementation note (2026-10-25):** the current plugin implements content selection, the token budget, cache, worker call, a heuristic watermark gate based on `ctx.model.list()`, literal validation, and reversible markers. The research design's free-pruning stage and provider-usage token accounting are still not implemented; the watermark uses a local estimate.

### 4.5 Cache

Because `context` edits are transient, a cache is the difference between "works" and "recompresses 20 times per turn."

```
key = sha256(
  pluginVersion + "\0" +
  compressorModel + "\0" +
  rate + "\0" +
  canonicalText
)
```

- In-memory LRU (e.g. 500 entries / 32 MB) for the hot path; optional `ctx.storage` persistence for cold starts.
- Deduplicate in-flight requests: `Map<key, Promise<string>>`.
- Cache per **message part**, not per rolling window. Appending a tool result mustn't invalidate old keys.
- Evict on compaction events; old prefixes are dead after history replacement.
- Include the model/rate in the key so a config change can't silently reuse stale output.
- Store the original size, compressed size, and model version for stats.

### 4.6 Worker architecture

**Phase 1 (recommended): warm Python daemon.**

```
Node plugin ──JSON-lines over stdin/stdout or Unix socket──▶ python worker
                                                             ├─ PromptCompressor (BERT)
                                                             ├─ optional reranker (compaction only)
                                                             └─ cache-friendly, model resident
```

- Spawn lazily on first compression, not at OpenCode startup (avoid slowing boot).
- `HF_HUB_OFFLINE=1` after first download to avoid 1.5–2.9 s metadata stalls.
- Warm up with a tiny call; MPS's first call costs ~1.2 s.
- Idle shutdown after 10–15 min to release ~0.9–1.5 GB RSS; restart on demand.
- Hard timeout (1.2 s soft / 3 s hard), kill and restart on hang, circuit-break after repeated failures.
- Batch all cache misses for one model call into a single request.
- Don't load the reranker/embedder for the request lane; only the compressor. Load them only for compaction ranking if used.

**Phase 2: pure JS/ONNX option.** `@atjsh/llmlingua-2` removes Python and the 1.4 GB venv. Use BERT-base ONNX (710 MB) or an int8 variant; verify quality and latency first. TinyBERT is fast but too lossy for anything but low-value prose. This is the better end-state for distribution, but not the first milestone.

### 4.7 Compaction integration

Two modes, default `precompress`:

| Mode | Behavior | Quality | Cost |
|---|---|---|---|
| `precompress` (default) | LLMLingua-compress old prose/tool narration in the transcript, protect code/paths/errors/recent turns, preserve order; let OpenCode's summarizer run on the result | safest; summarizer still reasons over full structure | saves tokens on the summarizer call |
| `replace` | Build a summary yourself and set `event.result = { summary }`, skipping the model call | fastest/cheapest; highest risk | no summarizer LLM call |

In both modes:

- Do **not** reorder by reranker score. Keep chronological order.
- Use the **last user request** as the query if any ranking is used, not `DEFAULT_QUERY`.
- Don't cap to 12 messages; use a token budget.
- Keep paths, identifiers, error strings, decisions, and open tasks verbatim (a structured "state block" is better than hoping LLMLingua keeps them).
- Native provider compaction (`compaction.type: "native"`) likely bypasses the hook; test before relying on it.
- Don't disable `compaction.auto` by default. `context` compression can't reliably prevent compaction, and an overflow triggers a one-shot recovery anyway.

### 4.8 Expand tool

Lossy compression needs an escape hatch. Register a tool:

```
context_expand({ handle: "ctx_7f3a", query?: "error line" })
  → returns the original text (or matching lines) from the plugin's store
```

- Store originals keyed by handle in `ctx.storage` (or an on-disk cache) when compressing.
- Put the handle in the replacement marker: `[compressed 8.2k→3.1k tokens; ctx_expand("ctx_7f3a") for original]`.
- This directly addresses the reference's biggest complaint (vital context missing) and makes aggressive rates defensible.
- Budget storage (e.g. 50 MB/session, LRU) and redact secrets if the transcript contains them.

### 4.9 Suggested defaults

```jsonc
{
  "enabled": true,
  "request": {
    "softRatio": 0.55,          // free pruning starts
    "llmlinguaRatio": 0.70,     // paid compression starts
    "targetRatio": 0.45,
    "protectedTurns": 2,
    "minChunkTokens": 400,
    "maxChunkTokens": 1600,
    "rate": 0.6,
    "timeoutMs": 1200
  },
  "compaction": { "mode": "precompress" },
  "toolOutput": { "enabled": false },
  "expandTool": { "enabled": true },
  "retainOriginal": true
}
```

These are starting points, not validated constants. Tune with the evaluation harness.

### 4.10 Observability

Record per model call:

- Estimated input tokens, actual provider `tokens.input` from `session.step.ended`;
- Bytes/tokens before/after per stage (free prune, LLMLingua, fallback);
- Compression latency p50/p95, cache hit rate, worker restarts;
- Number of protected parts skipped by reason;
- Compaction count and summary size.

Expose `/llmlingua stats`, `/llmlingua context`, `/llmlingua on|off`, and a debug dump of before/after snippets. Don't put compressed text in logs by default (secrets).

---

### 4.11 Enabling it

A local V2 plugin is loaded from `.opencode/plugins/` or the `plugins` array:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-context-optimisations",
      "options": {
        "request": { "softRatio": 0.55, "llmlinguaRatio": 0.70 },
        "expandTool": { "enabled": true }
      }
    }
  ]
}
```

No slash command is required: the `context` and `compaction` hooks run automatically. Commands are for inspection (`/llmlingua stats`, `/llmlingua context`, on/off), not for triggering the core path. For development, `plugins` accepts an absolute path or `file://` URL; the package must export a V2 default (`Plugin.define(...)`).

---

## 5. Why not compress everything?

| Risk | Evidence |
|---|---|
| Code becomes invalid | Local tsc test: `TS1005`, zero braces/newlines |
| Logs lose structure | 5.7k chars → one line; timestamps gone |
| Negations/numbers drift | 23→15 negation markers at 8k prose; token classifier has no fact guarantee |
| Prompt cache misses | Recompressing a shifted window changes the prefix; provider cache hits collapse |
| Latency | 8k tokens ≈ 1.6 s CPU; a tool-heavy turn can make 10+ calls |
| Silent data loss | No way to recover dropped content without an expand path |
| Compaction interaction | `context` edits cannot stop the auto decision; durable edits are lossy forever |

The reference's README warning is consistent with this: smaller output, vital context missing. The fix isn't a better rate; it is **not compressing the wrong content**.

### 5.1 Where the savings actually are

| Context source | Share of a coding transcript | LLMLingua fit | Realistic action |
|---|---:|---|---|
| Tool results (code reads, diffs, grep) | largest | **poor** | leave exact; structural dedupe only |
| Tool results (build/test logs) | large | **poor** at token level | line-level prune, keep errors/head/tail |
| Tool results (web/docs/search) | medium | **good** | LLMLingua 0.5–0.7 |
| Assistant narration / plans | medium | **good** | LLMLingua 0.6–0.8, older than N turns |
| User prose / requirements | medium | **risky** | 0.8 only when old; never the current request |
| System, tools, recent window | fixed | **never** | protect |

In a code-heavy session, the compressible share may be only **10–25%** of tokens; the compaction lane is where most of the saving is realized. In a research-heavy session (web fetches, long docs), the share is much higher. Measure both before claiming a headline percentage.

---

## 6. Compression taxonomy audit & reality check

A survey of the compression techniques across academic literature, open-source repositories, and gateway engines shows three distinct operational layers. **Only Layer 1 (pre-request text compression) reduces billed input tokens on hosted API models.**

```
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Pre-Request Text Compression (Client / Gateway)               │
│ • Deterministic: RTK, Lite, Session-Dedup, Headroom (SmartCrusher)    │
│ • Reversible: CCR (Compress-Cache-Retrieve)                            │
│ • Statistical/SLM: LLMLingua-1/2, Selective Context, Claw-Compactor   │
│ • Rule-based: Caveman (input rewrite)                                  │
│ → REDUCES BILLED INPUT TOKENS ON HOSTED APIS (OpenAI, Anthropic, etc.) │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ (HTTP / JSON)
┌────────────────────────────────────▼───────────────────────────────────┐
│ Layer 2: Model Architecture / Soft Representations (White-Box Only)    │
│ • ICAE, AutoCompressor, Gist Tokens                                    │
│ → Requires model weights, custom attention masks, LoRA adapters.       │
│ → CANNOT BE USED WITH HOSTED BLACK-BOX APIS.                           │
└────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 3: Inference Engine KV-Cache Eviction (Server-Side Decode)       │
│ • StreamingLLM, H2O, SnapKV, PyramidKV                                 │
│ → Runs in vLLM / llama.cpp / SGLang during attention computation.     │
│ → DOES NOT REDUCE BILLED INPUT TOKENS ON HOSTED APIS.                  │
└────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Comprehensive method matrix

| Method / Name | Primary Source / Year | Layer | Mechanism | Works with Black-Box APIs? | Claimed vs Real Savings | Open-Source Status / License | OpenCode Assessment |
|---|---|---|---|:---:|---|---|---|
| **LLMLingua-2** | [arXiv:2403.12968](https://arxiv.org/abs/2403.12968) (ACL 2024) | Layer 1 | Task-agnostic token classification with multilingual BERT / XLM-R | **Yes** (text-to-text) | Claim: 2–5×; Real: 40–50% on prose, **destructive on code/logs** | [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua) (MIT) | **Viable for old prose only.** Use warm worker + strict classifier. |
| **LongLLMLingua** | [arXiv:2310.06839](https://arxiv.org/abs/2310.06839) (ACL 2024) | Layer 1 | Question-aware budget allocation + document reordering using LLaMA-2-7B | **Yes** (text-to-text) | Claim: up to 4× with +21% recall; Real: slow local inference (7B model) | [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua) (MIT) | Too heavy for interactive coding turns. |
| **Selective Context** | [arXiv:2310.06201](https://arxiv.org/abs/2310.06201) (EMNLP 2023) | Layer 1 | Lexical unit self-information scoring with small causal LM (GPT-2) | **Yes** (text-to-text) | Claim: 50% context reduction; Real: ~35% on natural language | [liyucheng09/Selective_Context](https://github.com/liyucheng09/Selective_Context) (Dormant, no root LICENSE) | Predecessor to LLMLingua-2; unidirectional LM is slower and less accurate. |
| **ICPC** | [arXiv:2501.01625](https://arxiv.org/abs/2501.01625) (2025) | Layer 1 | MLM probability scoring via BERT/RoBERTa; drops low-information words | **Yes** (text-to-text) | Claim: 10–16 ms on 8×A100; **Unvetted preprint, 0 citations** | **No code released.** Heavy acronym collision with programming contest. | Ignore until peer-reviewed code is available. |
| **RTK** (Rust Token Killer) | [rtk-ai/rtk](https://github.com/rtk-ai/rtk) (2026) | Layer 1 | Command-aware deterministic filtering of bash/CLI outputs (git, tests, build) | **Yes** (text-to-text) | Claim: 60–90% on CLI outputs; Real: **60–80% verified on dev tools** | Active Rust repo (~84k★, Apache-2.0 / BUSL-1.1); ships OpenCode hook | **Highest value for coding agents.** Zero semantic drift on code. |
| **Caveman** | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (2026) | Layer 1 & Output | Rule-based prose condensation; prompt steering for terse responses | **Yes** (prompt + output) | Claim: 65% token cut; Real: 33% input prose, 40–60% output tokens | Active Go/CLI repo (~114k★, Apache-2.0); OpenCode skill available | Safe for output steering; risky for raw code/prompts without boundaries. |
| **Headroom** (incl. SmartCrusher, CCR) | [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) (2026) | Layer 1 | Tabular JSON crusher (SmartCrusher), AST code compressor, Reversible cache (CCR) | **Yes** (proxy / MCP) | Claim: 60–95% on JSON, 20% on coding traces; Real: 70%+ on JSON arrays | Active Python/TypeScript (~77k★, Apache-2.0); PyPI / npm | **Excellent for JSON/MCP tool outputs.** CCR provides reversible safety. |
| **Claw-Compactor** | [open-compress/claw-compactor](https://github.com/open-compress/claw-compactor) (2026) | Layer 1 | 14-stage local pipeline: AST code thinning, JSON sampling, log/diff folding | **Yes** (text-to-text) | Claim: 15–82%; Independent audit (Hysen Labs): **11.8–19.1% on SWE-bench** | Python repo (~2k★, MIT, dormant since 2026-04); PyPI 7.1.0 | Real but modest gains; complex pipeline risks prompt-cache invalidation. |
| **OmniRoute Lite** | OmniRoute built-in (`lite.ts`) | Layer 1 | Whitespace collapsing, image-URL placeholders, older tool-result truncation | **Yes** (gateway) | Claim: ~15% whitespace; Real: **37% locally, driven by 2000-char tool cutoff** | Shipped in local OmniRoute 3.8.51 (`open-sse/services/compression/lite.ts`) | **Hazard:** truncates historical file reads. Must configure safely. |
| **Session-Dedup** | OmniRoute built-in / arXiv:2606.06337 | Layer 1 | Content-addressed cross-turn line-block deduplication (`[dedup:ref sha=...]`) | **Yes** (gateway) | Real: **9.3% tokens saved locally (48M tokens)**; 100% lossless | Shipped in local OmniRoute 3.8.51; inspired by TokenMizer blueprint | **Safe default.** Keeps first occurrence intact, eliminates duplicate logs/files. |
| **ICAE** | [arXiv:2307.06945](https://arxiv.org/abs/2307.06945) (ICLR 2024) | Layer 2 | LoRA autoencoder producing continuous memory vectors (4× compression) | **No** (needs weights) | Claim: 4× compression, >2× speedup; Real: requires white-box LLaMA/Mistral | [getao/icae](https://github.com/getao/icae) (CC0-1.0, dormant) | Inapplicable to OpenAI/Anthropic/Gemini APIs. |
| **AutoCompressor** | [arXiv:2305.14788](https://arxiv.org/abs/2305.14788) (EMNLP 2023) | Layer 2 | Fine-tunes model to emit 50 summary vectors per segment as soft prompts | **No** (needs weights) | Claim: handles 30k context with fixed summary vectors | [princeton-nlp/AutoCompressors](https://github.com/princeton-nlp/AutoCompressors) (No license file, dormant) | Inapplicable to black-box APIs. |
| **Gist Tokens** | [arXiv:2304.08467](https://arxiv.org/abs/2304.08467) (NeurIPS 2023) | Layer 2 | Modified attention mask compressing prompt into learned gist token activations | **No** (needs weights) | Claim: up to 26× compression; 4.2% wall-clock speedup | [jayelm/gisting](https://github.com/jayelm/gisting) (Apache-2.0, dormant) | Inapplicable to black-box APIs. |
| **StreamingLLM** | [arXiv:2309.17453](https://arxiv.org/abs/2309.17453) (ICLR 2024) | Layer 3 | Attention sinks (first 4 tokens) + rolling KV window; constant decode RAM | **No** (inference engine) | Cuts KV memory to fixed size; **zero reduction in billed API input tokens** | HF Transformers `SinkCache`, llama.cpp `--keep`; not mainline vLLM | Server-side only. Does not help API users. |
| **H2O** (Heavy Hitter Oracle) | [arXiv:2306.14048](https://arxiv.org/abs/2306.14048) (NeurIPS 2023) | Layer 3 | Dynamic KV eviction keeping top ~20% cumulative attention tokens | **No** (inference engine) | Up to 29× decode throughput in offloading benchmarks; **0 billed savings** | [FMInference/H2O](https://github.com/FMInference/H2O); not mainline vLLM | Server-side only. |
| **SnapKV** | [arXiv:2404.14469](https://arxiv.org/abs/2404.14469) (2024) | Layer 3 | One-shot post-prefill observation window; keeps top-k KV heads + window | **No** (inference engine) | 3.6× generation speed, 8.2× KV memory at 16k; **0 billed savings** | [FasterDecoding/SnapKV](https://github.com/FasterDecoding/SnapKV); not mainline vLLM | Server-side only. |
| **PyramidKV** | [arXiv:2406.02069](https://arxiv.org/abs/2406.02069) (2024) | Layer 3 | Pyramidal layer-wise KV budget allocation (more in lower layers, less higher) | **No** (inference engine) | 12% KV matches full context on LongBench; **0 billed savings** | [Zefan-Cai/KVCache-Factory](https://github.com/Zefan-Cai/KVCache-Factory); not mainline vLLM | Server-side only. |

---

## 7. Local gateway audit: OmniRoute 3.8.51

OpenCode on this machine is configured to route model requests directly through a local OmniRoute proxy (`http://localhost:20128/v1`), authenticated via loopback API keys.

OmniRoute already contains a full compression subsystem with 12 pluggable engines:

```
OmniRoute Compression Pipeline (open-sse/services/compression/)
├── session-dedup (pri 3, lossless cross-turn block deduplication)
├── ccr           (pri 4, Compress-Cache-Retrieve via MCP)
├── lite          (pri 5, whitespace folding + tool-result truncation)
├── rtk           (pri 10, command-aware shell output filtering)
├── headroom      (pri 15, SmartCrusher tabular JSON compaction)
├── caveman       (pri 20, rule-based prose condensation)
├── aggressive    (pri 30, summarization and aging of older turns)
├── llmlingua     (pri 35, ONNX MobileBERT / TinyBERT token pruning)
├── ultra         (pri 40, heuristic token pruning + code thinning)
├── relevance     (pri 50, query-salience sentence scoring)
├── codex-responses (pri 60, tool output wrapper for responses API)
└── omniglyph     (pri 90, experimental dense encoding)
```

### 7.1 The lossy request policy gate

OmniRoute enforces a strict safety boundary in `lossyRequestPolicy.ts`:
- Requests without explicit compression headers are restricted to the **Safe Default Pipeline**: `session-dedup` + `lite` + `ccr` + `headroom`.
- Lossy engines (**LLMLingua, RTK, Caveman, Relevance, Aggressive, Ultra**) are automatically stripped from the stacked pipeline unless the caller sends an explicit header:
  - `x-omniroute-compression: allow-lossy`
  - `x-omniroute-compression: engine:<id>`
  - `x-omniroute-compression: <combo_id>`
- **Direct consequence:** OpenCode requests weren't running LLMLingua or RTK at the gateway, despite both engines being marked `enabled: true` in OmniRoute's SQLite database.

### 7.2 Hidden hazard: Lite tool-result truncation

In `lite.ts` (`compressToolResults`):
```typescript
const MAX_TOOL_LENGTH = resolveLiteMaxToolLength(options.maxToolLength); // defaults to 2000 chars
// Any tool result before the current turn exceeding 2000 chars is sliced:
msg.content = msg.content.slice(0, cutIndex) + "\n...[truncated]";
```
- **Local telemetry evidence:** Across 7,964 requests in the user's database, `lite` recorded **420,402,707 tokens saved** (37% average reduction).
- **The catch:** This reduction isn't lossless whitespace removal. It silently truncates past file reads (`read` tool) and directory scans to 2,000 characters. If an agent refers back to code read 3 turns ago, it finds `...[truncated]` and is forced to re-read the file.
- **Remediation:** Configure `lite.compressToolResults = false` or raise `maxToolLength` to 50,000+ characters in OmniRoute settings.

### 7.3 Live API receipts: `agy/gemini-3.8-flash-high`

Live end-to-end completions executed against `http://localhost:20128/v1/chat/completions` using the active model `agy/gemini-3.8-flash-high`:

#### Receipt 1: Cold start LLMLingua
```http
POST /v1/chat/completions HTTP/1.1
Host: localhost:20128
x-omniroute-compression: engine:llmlingua

{
  "model": "agy/gemini-3.8-flash-high",
  "messages": [{ "role": "user", "content": "<3,661 tokens of natural language prose>" }]
}
```
**Response:**
- `HTTP/1.1 200 OK`
- `x-omniroute-compression: stacked; source=request-header; tokens=3661->1881; rules: llmlingua-compressed-1-messagesx1`
- `duration_ms: 50310` (cold start: spawned ONNX worker thread and loaded TinyBERT weights).
- **Tokens:** 3,661 → 1,881 (**48.6% compression**, 1,780 tokens saved).

#### Receipt 2: Warm LLMLingua
```http
POST /v1/chat/completions HTTP/1.1
x-omniroute-compression: engine:llmlingua
```
- `HTTP/1.1 200 OK`
- `x-omniroute-latency-ms: 3660` (3.66s total round-trip latency including Gemini API call).
- `tokens=3661->1880` (reproducible ~48.6% reduction).

#### Receipt 3: RTK deterministic filter
```http
POST /v1/chat/completions HTTP/1.1
x-omniroute-compression: engine:rtk
```
- `HTTP/1.1 200 OK`
- `x-omniroute-compression: rtk; source=request-header`
- `duration: 4.21s` total API round-trip.

---

## 8. Layered context optimization architecture

To achieve maximum token savings without risking syntax errors, hallucinated line numbers, or cache thrashing, context optimization must be layered across the OpenCode agent and the OmniRoute gateway:

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Prefix Cache Stability (QuantumLock / Static Instructions)          │
│    Keep system prompt, tools schemas, and repo instructions byte-fixed.│
│    Enables 50–90% provider prompt-caching discounts.                   │
├────────────────────────────────────────────────────────────────────────┤
│ 2. Lossless Cross-Turn Dedup (Session-Dedup)                           │
│    Hashes suffix line blocks. Replaces duplicate reads with [dedup:ref]│
│    Local saving: 9.3% tokens (48M tokens saved), 0% information loss.  │
├────────────────────────────────────────────────────────────────────────┤
│ 3. Deterministic Tool Output Filtering (RTK)                           │
│    Prunes build output, test passes, git statuses. Preserves errors.   │
│    Savings: 60–80% on shell/bash results; zero code syntax risk.       │
├────────────────────────────────────────────────────────────────────────┤
│ 4. Tabular Structure Compaction (Headroom / SmartCrusher)              │
│    Compresses uniform JSON arrays (>= 8 rows) from MCP/API tools.      │
│    Savings: 60–90% on structured data; preserves outliers and errors.  │
├────────────────────────────────────────────────────────────────────────┤
│ 5. Reversible Context Offloading (CCR)                                 │
│    Replaces large historical text blocks with [CCR retrieve hash=...]. │
│    Requires OpenCode to register `omniroute_ccr_retrieve` tool.        │
├────────────────────────────────────────────────────────────────────────┤
│ 6. Selective SLM Token Pruning (LLMLingua Request Lane)                │
│    Target: Old assistant/tool natural language (>2 turns old).         │
│    Gated by `src/policy.ts`: NEVER touches code, diffs, JSON, logs.    │
│    Savings: 40–50% on prose portions under context budget pressure.    │
├────────────────────────────────────────────────────────────────────────┤
│ 7. Response Output Steering (Caveman Output Mode)                      │
│    Injects system boundaries for terse prose while keeping code exact. │
│    Savings: 30–60% of output generation tokens.                        │
├────────────────────────────────────────────────────────────────────────┤
│ 8. Adaptive Escalation Floor (Context Budget)                          │
│    Only escalates to lossy compression when context approaches limit.  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Implementation deliverables in this repo

**Phase 1 (2026-10-22): core safety and policy modules.**

1. **`src/classify.ts`** — Conservative content classifier:
   - Detects code, unified diffs, JSON objects/arrays, structured logs, and empty content.
   - Computes path density and fence presence to protect technical text.
   - Evaluates whether text is safe for token-dropping compression (`isTokenCompressible`).
2. **`src/policy.ts`** — Safe selection policy engine:
   - Protects system messages, recent user turns (default 2), code, logs, and JSON.
   - Operates oldest-first under a configurable token budget.
   - Generates deterministic SHA-256 cache keys sensitive to text, model, and compression rate.
   - Rejects small chunks (<400 tokens) to avoid overhead.
   - Supports caller-marked `protected` parts and fails closed on non-finite options.

**Phase 1.5 (2026-10-25): V2 integration path.**

3. **`src/v2.ts`** — V2 transcript adapter:
   - Converts `Message.content` text parts and tool-result `text`/`content` payloads into policy text spans.
   - Marks tool-result `json` and `error` values protected.
   - Preserves message IDs, tool IDs/names, and source pointers for exact write-back.
4. **`src/optimizer.ts`** — Lane orchestration:
   - Reuses the policy, adds an LRU, in-flight dedupe, per-candidate timeout, literal validation, optional annotation, and an expansion guard.
   - Applies replacements in place and returns stage-level stats.
   - Fails open on backend errors, empty output, timeouts, and dropped literals.
5. **`src/watermark.ts`** — Estimates request pressure from system/tools/messages and gates the request lane against `ctx.model.list()` limits.
6. **`src/literals.ts`** — Post-checks paths, URLs, numbers, line references, and error codes.
7. **`src/expand.ts`** — Bounded original-text store plus deterministic `[ctx_expand:...]` markers.
8. **`src/tool-result.ts`** — Extracts a single tool-result text slot and protects write/edit/plan/etc. tools.
9. **`src/compressor.ts`** — HTTP sidecar client with the tiny JSON contract.
10. **`src/plugin.ts`** — OpenCode V2 plugin with watermark-gated `context`, precompress-only `compaction`, optional `execute.after` compression, and a `context_expand` tool.
11. **`python/llmlingua_worker.py`** — Optional warm LLMLingua-2 HTTP sidecar.
12. **`research/eval_quality.mjs`** — OpenCode Go A/B fact-retention harness.
13. **Tests** — `classify`, `policy`, `v2`, `optimizer`, `compressor`, `expand`, `literals`, `tool-result`, `watermark`, and `plugin` suites:
   - 74 unit tests covering multilingual tokens, turn boundaries, V2 content parts, tool-result JSON/error protection, code protection, cache eviction, timeouts, literal rejection, expand markers, watermark decisions, compaction, tool lane, and hook registration.
   - 100% passing (`npm test`), zero TypeScript compiler errors (`npm run typecheck`).

**Quality smoke test (2026-10-25):** `deepseek-v4.1-flash` via OpenCode Go retained 6/6 fact checks on both original and compressed transcripts over two runs, with an estimated 32.5% token reduction and about $0.0013 of API usage. This is a fixture-level check, not a SWE-bench-style evaluation.

**Not yet implemented:** free-pruning/dedupe, provider-usage-based token accounting, verification of `tool.execute.after` persistence across V2 history, and a broad task-success benchmark.

---

## 10. Practical integration & action guide

### Option A: Enable RTK + Safe Stack in OmniRoute (Recommended First Step)
To immediately activate verified tool-result compression without code modifications:
1. Open OmniRoute dashboard (`http://localhost:20128`) or CLI:
   ```bash
   omniroute context-eng rtk config set --intensity standard --applyToToolResults true
   ```
2. In OpenCode configuration (`~/.config/opencode/opencode.json`), provide the opt-in header for the `omniroute` provider:
   ```jsonc
   {
     "provider": {
       "omniroute": {
         "npm": "@ai-sdk/openai-compatible",
         "options": {
           "baseURL": "http://localhost:20128/v1",
           "headers": {
             "x-omniroute-compression": "allow-lossy"
           }
         }
       }
     }
   }
   ```
   *Note: Ensure `lite.compressToolResults` is disabled if using RTK so historical file reads aren't truncated.*

### Option B: Deploy Local OpenCode LLMLingua Plugin
All four lanes are now implemented:
1. Start the warm worker from `python/llmlingua_worker.py` (CPU or MPS).
2. Configure `src/plugin.ts` with `endpoint`, the request budget/rate, `watermarkRatio`, and compaction/tool flags. Without `endpoint` the plugin is inert.
3. **Context:** the watermark estimates system/tools/messages against `ctx.model.list()`; above the threshold, `src/v2.ts` adapts the transcript, `selectLlmlinguaCandidates` selects old prose, and misses go to the worker under a 1,200 ms deadline.
4. **Compaction:** the plugin pre-compresses the transcript handed to the summarizer and leaves `event.result` unset, so the native summary still runs.
5. **Tool output:** optional and default-off; completed tool text is extracted and run through the same policy path.
6. **Expand:** compressed spans carry `[ctx_expand:...]` markers and the `context_expand` tool returns the stored original.

Only approved text/tool-result spans are replaced; `system`, `tools`, code, JSON, errors, tool-call IDs, and recent turns stay byte-identical. Backend failures fail open, and a post-check rejects output that drops paths, URLs, numbers, line references, or error codes.

`research/eval_quality.mjs` provides the quality A/B gate through OpenCode Go. Still future work: free-pruning/dedupe, provider-usage token accounting, verified tool-output persistence, and a SWE-bench-style task-success benchmark.

---

## 11. Conclusion

- **Don't blindly compress coding contexts with LLMLingua.** Token-dropping models destroy code syntax, flatten log lines, and drop negative assertions.
- **The biggest wins for coding agents are deterministic:** RTK bash filtering (60–80% on CLI outputs), Session-Dedup (9.3% lossless), and Headroom JSON compaction.
- **LLMLingua belongs in a surgical, selective lane** targeting older natural-language explanations and search results, operating under strict policy gates with cache prefix protection.
- **The request lane is now implemented and reversible**: watermark-gated context compression, precompress-only compaction, optional tool-output compression, literal preservation, expand markers, and a fact-retention harness. The remaining work is evidence, not plumbing: free-pruning, provider-usage accounting, tool-hook persistence verification, and a broader task-success benchmark.

