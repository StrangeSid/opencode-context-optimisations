# FINDINGS — making OpenCode use LLMLingua more often

**Status:** research spike, 2026-10-22
**Target:** OpenCode v2.1.3 (`@opencode/plugin@2.1.3`), Apple M3 Pro / 18 GB / macOS
**Reference studied:** [`evermeer/context-optimizer`](https://github.com/evermeer/context-optimizer) v0.5.0, commit `d3fbe31`
**Local evidence:** [`research/`](./research) — hook types, reference audit, LLMLingua notes, benchmarks

---

## 0. TL;DR

1. **The reference is a useful skeleton, but it does not do what this project needs.** It calls LLMLingua only when OpenCode compacts, and each call spawns a fresh Python process that reloads three models. Measured cold start of that path is **2.6–4.2 s** before any compression. That architecture cannot support "use LLMLingua more often."
2. **OpenCode V2 exposes the right hooks.** `ctx.session.hook("context")` runs before every agent-loop model request and can mutate the outgoing `system`, `messages`, `tools`, and `options`. `ctx.session.hook("compaction")` can pre-compress the transcript or replace the summarizer entirely via `event.result`. `ctx.tool.hook("execute.after")` can inspect or replace a tool result.
3. **`context` edits are transient.** History is rebuilt on every call, so the same old text returns next step. Compression must be **cached by content hash**, not written into message metadata, or it will be recomputed on every tool continuation.
4. **LLMLingua is a token-dropping compressor, not a summarizer.** On this machine LLMLingua-2 BERT-base takes **~0.20 s per 1k tokens** on CPU, **~1.6 s per 8k**, and **~0.7 s per 8k on MPS**. It is fast enough for selective use, not for blind whole-context compression on every call.
5. **Quality is the real blocker, not latency.** Measured output destroys code (`tsc` fails with `TS1005`, zero braces/newlines), collapses logs to one line, and loses negations in prose. LLMLingua must be restricted to **old natural-language text**, with code/JSON/logs/errors/recent turns protected.
6. **Auto-compaction cannot be prevented from the `context` hook.** In 2.1.3 the auto-compaction decision is made *before* `request.primary` triggers the hook. Compression lowers cost and overflow risk, but native compaction still fires at its threshold. Disabling `compaction.auto` is a separate, riskier decision.
7. **Recommended shape:** a V2 plugin with three lanes — **continuous request compression** (old prose only, watermark-triggered), **compaction pre-compression** (reduce the summarizer's input), and **optional tool-output compression** (structural pruning, not token-level). Plus a content-hash cache, warm worker, and a `context_expand` tool so lossy compression is recoverable.
8. **Expected saving is unknown and probably modest in code-heavy sessions.** Tool results dominate a coding transcript, and most of them are code, diffs, JSON or logs — all poor LLMLingua targets. The realistic wins are old prose/narration, web/doc output, pasted logs after structural pruning, and the compaction lane. Do not ship default-on until an A/B evaluation shows quality retention. The honest pitch is "compress the prose, preserve the code," not "compress everything."

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

- dedupe identical tool calls (same name + parameters), keep newest output;
- replace string inputs of errored tool calls older than 4 user turns with a marker.

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

So `context` compression **cannot stop this step's auto-compaction**. It can lower the *next* step's measured usage (provider token counts reflect the compressed request), which may influence later thresholds indirectly. Do not promise "no more compaction."

**If the product goal is compression instead of compaction**, the only honest options are:

1. accept compaction and use LLMLingua to reduce cost between compactions (recommended);
2. set `compaction.auto: false` and rely on compression, accepting a one-shot overflow recovery (risky);
3. make compression durable (`prompt` or `tool.execute.after`, both lossy and not clearly persisted);
4. use the `compaction` hook to make compaction cheaper/better, not to avoid it.

### 2.3 The reference plugin is V1-only

The reference's `packages/opencode/src/plugin.ts` returns V1 hooks (`command.execute.before`, `experimental.session.compacting`, `experimental.chat.messages.transform`). **V2 does not translate these.** It loads the default export's `id` and `setup()`; a V1 `server()` implementation is ignored. The reference must be ported, not installed, on v2.1.3. Its Python pipeline and config logic can be reused behind the V2 hooks.

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

The output is reconstructed by joining word pieces with spaces. That is why punctuation, indentation, and newlines are lost. It is not a formatting-preserving editor.

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

The JS port is attractive for packaging (no Python, no 1.4 GB venv, MIT, browser/Node). It is also explicitly **experimental, with no unit tests**, and the TinyBERT output at `rate=0.6` turned `"./utils.js"` into `". / utils. js "`. Treat it as a phase-3 packaging option, not the first implementation.

### 3.3 Quality evidence

From the local benchmark (`rate=0.6`):

- **TypeScript:** output had 0 newlines, 0 `{`, 0 `}`, mismatched parentheses; `tsc` failed immediately with `TS1005`. Not usable.
- **Build log:** 5,716 chars became 4,176 chars on **one line**; timestamps and structure destroyed. Key error strings happened to survive, but line-oriented consumers cannot use it.
- **Prose:** readable but telegraphic. Negation markers dropped from 3→2 (1k) and 23→15 (8k). Keyword presence is not task accuracy.

Published evidence (LLMLingua-2 paper): good on MeetingBank-style summarization/QA, but Synthetic tasks drop ~16 points and BBH ~8 points. **There is no published study of LLMLingua-2 inside an agentic coding loop.** Our local code test is a strong negative signal.

**Conclusion:** LLMLingua is suitable for *redundant natural-language narration* and for *compaction input that an LLM will summarize anyway*. It is not suitable for code, diffs, JSON, logs, stack traces, exact identifiers, instructions, or the recent window.

---

## 4. Proposed design

### 4.1 Principles

1. **Selective, not universal.** Compress only content whose exact form does not matter.
2. **Transient by default.** Mutate the outgoing request, never persisted history. Add an explicit expand path for retrieval.
3. **Cache the stable prefix.** Compress each message/chunk once, keyed by content hash; serve repeats synchronously.
4. **Preserve chronology and tool pairing.** Compress in place; never reorder messages or drop a tool result without its call.
5. **Fail open.** Any timeout, malformed output, or classifier doubt → send the original text.
6. **Protect the tail.** The last N user turns and the current request stay verbatim.
7. **Make savings measurable.** Record tokens in/out per stage, latency, cache hit rate, and fallbacks.
8. **Do not break prompt caching.** The compressed prefix must be deterministic and stable across calls.

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

| Lane | Trigger | Content | Persistence | Default |
|---|---|---|---|---|
| **Request** | context > soft watermark (e.g. 55%) | old prose / tool narration | transient | on (conservative) |
| **Compaction** | native/manual compaction | transcript, code-safe | compaction result | on |
| **Tool output** | single result > size threshold | prose tool output; logs via structure | unverified | off initially |

The request lane is the direct answer to "use LLMLingua more often": it runs automatically on every model call, but only does work when the context is under pressure and only on safe content. The compaction lane is automatic too; commands exist only for inspection and overrides.

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

**Hard rule:** if the classifier is not confident, do not compress. A false negative costs tokens; a false positive costs correctness.

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
- **Budget-driven:** compress until the target is met, oldest first; do not compress the whole history every time.
- **Chunk cap:** 1–2k tokens per request; 8k takes 1.6 s on CPU and is not acceptable on the critical path. Batch multiple small chunks into one worker call.
- **Rate:** 0.8 for user prose, 0.6 for assistant/tool narration. Lower rates save more but lose negations and numbers.
- **Token accounting:** subscribe to `session.step.ended` and use `tokens.input` (+ cache read/write as appropriate) as the measured baseline; add a character/token estimate for content appended since that step. Fall back to `chars/4` if no event has arrived. Flag the estimate in stats; do not pretend it is exact.

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
- Cache per **message part**, not per rolling window. Appending a tool result must not invalidate old keys.
- Evict on compaction events; old prefixes are dead after history replacement.
- Include the model/rate in the key so a config change cannot silently reuse stale output.
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
- Do not load the reranker/embedder for the request lane; only the compressor. Load them only for compaction ranking if used.

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
- Do not cap to 12 messages; use a token budget.
- Keep paths, identifiers, error strings, decisions, and open tasks verbatim (a structured "state block" is better than hoping LLMLingua keeps them).
- Native provider compaction (`compaction.type: "native"`) likely bypasses the hook; test before relying on it.
- Do not disable `compaction.auto` by default. `context` compression cannot reliably prevent compaction, and an overflow triggers a one-shot recovery anyway.

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

- estimated input tokens, actual provider `tokens.input` from `session.step.ended`;
- bytes/tokens before/after per stage (free prune, LLMLingua, fallback);
- compression latency p50/p95, cache hit rate, worker restarts;
- number of protected parts skipped by reason;
- compaction count and summary size.

Expose `/llmlingua stats`, `/llmlingua context`, `/llmlingua on|off`, and a debug dump of before/after snippets. Do not put compressed text in logs by default (secrets).

---

### 4.11 Enabling it

A local V2 plugin is loaded from `.opencode/plugins/` or the `plugins` array:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/workspace/opencode-context-optimisations",
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

The reference's README warning is consistent with this: smaller output, vital context missing. The fix is not a better rate; it is **not compressing the wrong content**.

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

## 6. Evaluation plan

Before default-on, build an offline replay harness:

1. **Corpus:** 20–50 real sessions (or synthetic equivalents) with tool-heavy coding, research, and long-running refactor tasks.
2. **A/B:** same model, same prompts, compression off vs on. Compare task success, number of turns, tool calls, and final diff correctness.
3. **Retention probes:** after compression, ask the model to recall exact paths, error codes, numbers, decisions, and user constraints. Score exact match.
4. **Structural validity:** for code samples, run `tsc`/`eslint`/parser on compressed text; require 100% valid or fall back.
5. **Log usability:** grep for error lines, timestamps, test counts; require key lines survive.
6. **Latency:** p50/p95 added per model call; enforce a budget (e.g. p95 < 300 ms for free pruning, < 1.2 s when paid compression runs).
7. **Cost:** tokens saved per lane × price; compare with the extra latency and any quality loss.

Ship default-on only if quality retention is within an agreed tolerance (e.g. ≥95% on retention probes) and p95 latency is acceptable.

---

## 7. Implementation plan

| Phase | Scope | Exit criterion |
|---|---|---|
| **0. Spike (this repo)** | Findings, hook map, benchmarks, reference audit | This document |
| **1. Core** | Content classifier, token estimator, cache, policy engine, fake compressor + unit tests | Policy tests pass; no OpenCode dependency (`src/classify.ts` + `tests/classify.test.ts` started) |
| **2. Plugin** | V2 `context` hook, config, stats, `context_expand`, fail-open worker | Runs against a local OpenCode v2.1.3 session; no crashes; logs savings |
| **3. Compaction** | `compaction` hook `precompress` mode, chronology-safe, code-safe | Summarizer input smaller, summary quality unchanged on eval set |
| **4. Quality** | Replay harness, retention probes, rate tuning, line-level LLMLingua experiment | Defaults justified by data |
| **5. Packaging** | Python daemon installer **or** JS/ONNX backend, model download UX, docs | One-command install; works offline after first run |

### Immediate next experiments

1. **Line-level LLMLingua for logs.** Score each line (or batch of lines) with the classifier, keep whole lines by salience, preserve newlines. This should fix the "one-line log" failure and make LLMLingua usable on the largest tool-output class.
2. **Span-preserving prose compression.** Use `return_word_label=True` / offset mapping to reconstruct kept spans with original whitespace instead of joining words. Verify readability and negation retention.
3. **BERT-base ONNX (JS) benchmark.** Determine whether the pure-JS path matches Python quality at acceptable latency; if yes, drop Python entirely.
4. **`tool.execute.after` persistence test.** Does replacing `event.result` persist to history? If yes, one-time compression becomes viable; if no, keep it transient.
5. **Auto-compaction ordering test on 2.1.3.** Confirm the runtime inference and whether `compaction` hook fires for native compaction.

---

## 8. Risks and open questions

1. **V2 API stability.** Hooks are new; `@opencode/plugin` is versioned with OpenCode. Pin the version and test on upgrade. `context`/`compaction` are documented, not experimental, but semantics can change.
2. **Transient vs durable.** If `tool.execute.after` replacements persist, a bug could permanently corrupt history. Keep it off by default until verified; snapshot originals.
3. **Compaction interaction.** `context` compression does not stop auto-compaction; users may expect it to. Document this explicitly.
4. **Prompt caching.** Any change to the compressed prefix invalidates provider caches. Keep the prefix byte-stable and cache compression output.
5. **Token estimation.** OpenCode's internal estimator is not exposed; `session.step.ended` usage is the best signal but arrives after the call. Use a conservative buffer.
6. **Model quality.** LLMLingua-2 is trained on MeetingBank, not code. No agentic-coding evidence. The local code test is negative. The evaluation harness is mandatory.
7. **Python packaging.** 1.4 GB venv, 5–6 min install, model download, MPS quirks. A JS/ONNX backend is the better long-term distribution story.
8. **Privacy.** All compression is local; no context leaves the machine. Still, the expand store may contain secrets; encrypt or redact, and document retention.
9. **Concurrency.** Multiple sessions can hit the worker at once; serialize or pool, and enforce per-call timeouts.
10. **Native provider compaction.** Likely bypasses the hook; do not assume it can be customized.

---

## 9. Recommendation

**Build it, but scope it as selective compression.**

- Start with the **request lane** and a **warm daemon + content-hash cache**. It is the only way to use LLMLingua "more often" without wrecking quality or latency.
- Compress **old prose and tool narration only**. Protect code, JSON, logs, errors, instructions, and the recent window.
- Add the **expand tool** from day one; lossy compression without retrieval is not defensible.
- Keep **native compaction** and use the **compaction lane** to make the summarizer's input cheaper. Do not disable `compaction.auto` until the evaluation proves compression alone is safe.
- Treat **"compress everything" as out of scope**. The measured quality damage is too large, and the reference's own warning confirms it.
- If the goal is maximum LLMLingua usage rather than maximum safety, the honest next step is **line-level/span-preserving LLMLingua**, not a lower rate on the existing token-level path.

**Success metric:** tokens saved per session with no measurable loss on retention probes, at p95 < 1.2 s added latency when compression runs.

---

## 10. Sources and local research

### Local

- [`research/opencode-v2-hooks.md`](./research/opencode-v2-hooks.md) — exact V2 hook types, runtime ordering, token visibility, open questions.
- [`research/reference-repo.md`](./research/reference-repo.md) — line-by-line audit of `evermeer/context-optimizer`.
- [`research/llmlingua.md`](./research/llmlingua.md) — install, API, model sizes, quality, alternatives.
- [`research/bench.md`](./research/bench.md) — M3 Pro latency/quality benchmark, raw data in `bench.json`.
- [`research/bench_llmlingua.py`](./research/bench_llmlingua.py) — reproducible benchmark.

### Upstream

- OpenCode V2 plugins: <https://opencode.ai/v2/docs/build/plugins>
- OpenCode V2 compaction: <https://opencode.ai/v2/docs/compaction>
- OpenCode V2 migration (V1 hooks do not run in V2): <https://opencode.ai/v2/docs/build/plugins/migrate-v1>
- LLMLingua: <https://github.com/microsoft/LLMLingua>
- LLMLingua-2 paper: <https://arxiv.org/abs/2403.12968>
- BERT model card: <https://huggingface.co/microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank>
- XLM-R model card: <https://huggingface.co/microsoft/llmlingua-2-xlm-roberta-large-meetingbank>
- JS port: <https://www.npmjs.com/package/@atjsh/llmlingua-2>
- Prior art: <https://github.com/AidenGeunGeun/opencode-context-compress> (token-threshold auto-compression, V2; model-directed, not LLMLingua)
- Prior art: <https://github.com/Plutarch01/opencode-lcm> (durable long-memory store; V1 hooks)

### Verified versions

- OpenCode `v2.1.3`, `@opencode/plugin@2.1.3`, Node `26.10.0`
- `llmlingua` 0.2.2, `torch` 2.14.1, `transformers` 5.20.2, Python 3.12.9
- `@atjsh/llmlingua-2` 3.0.0, `@huggingface/transformers` 4.2.0
