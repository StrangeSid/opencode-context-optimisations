# Reference repo analysis: `evermeer/context-optimizer`

- **Source:** <https://github.com/evermeer/context-optimizer>
- **Local clone:** `/tmp/ctxopt-ref` (read-only for this analysis)
- **Commit analysed:** `d3fbe31b23eb093f23fdc4484c29440420369f72` (2026-09-25)
- **Package version:** `0.5.0` (`package.json:3`)
- **Size:** 37 files, ~3,756 lines including tests and README
- **Status:** self-described "experimenal" (`README.md:7`)
- **Purpose:** context compression for OpenCode and Claude Code using rerank + dedupe + LLMLingua-2, with a local Python bridge.

All references below are `file:line` in `/tmp/ctxopt-ref` unless stated otherwise.

---

## 0. TL;DR

1. **Two adapters, one shared core.** `packages/core` owns config, payload shaping, the Python bridge, stats, debug/eval storage, detection and installation. `packages/opencode` and `packages/claude-code` are thin host adapters. The ML work is entirely Python (`python/context_optimizer.py`).
2. **LLMLingua runs almost only at compaction time.** OpenCode runs it only when `experimental.session.compacting` has just flagged the session and `experimental.chat.messages.transform` fires for the summarizer. Per-turn OpenCode optimisation is pure TypeScript dedupe + error-input purge; **no Python, no LLMLingua**. Claude Code runs it in `PreCompact` (manual and auto), plus the manual `/context-optimizer:compact` command and the CLI `optimize` command.
3. **The bridge is one-shot.** Every call spawns a new `python3 context_optimizer_cli.py`, which imports PyTorch/SentenceTransformers/LLMLingua and constructs three models from scratch, reads one JSON payload from stdin, writes one JSON result to stdout, and exits (`packages/core/src/bridge.ts:59-138`, `python/context_optimizer_cli.py:34-101`). There is no worker, no model reuse, no result cache.
4. **The default compaction budget is tiny.** After ranking, dedupe and an 8,000-char budget, only `max_chunks=12` docs reach LLMLingua (`packages/core/src/config.ts:9-13`, `python/context_optimizer.py:120-155,185`). In OpenCode one doc = one whole message (`packages/opencode/src/plugin.ts:77-95`), so "12 chunks" can mean "12 messages". This quantitatively explains the README's warning that the result is much smaller but misses vital context (`README.md:12-15`).
5. **Ranking destroys chronology.** Docs are sorted by reranker score and never restored to original order (`python/context_optimizer.py:134-136,157-166`). The query used for automatic compaction is the constant `DEFAULT_QUERY`, not the last user request (`packages/core/src/payload.ts:3,50`; `packages/opencode/src/plugin.ts:134`; `packages/claude-code/src/hook.ts:211`). Code, file contents and tool inputs are compressed too; `PROTECTED_TOOLS` only protects against TS dedupe/purge, not LLMLingua (`packages/core/src/strategies.ts:14-26`).
6. **Accounting is chars, not tokens, and conflates stages.** `initial_size` is the sum of docs before error purge/prune; `final_size` is the compressed string. "Saved %" includes pruning, dedupe and compression, and negative savings are clamped to zero (`python/context_optimizer_cli.py:63,86`; `packages/core/src/config.ts:236-238`). Per-turn TS savings are never recorded.
7. **Fail-open is real, but expensive.** Every adapter catches errors and leaves context untouched (`packages/opencode/src/plugin.ts:163-178,336-340`; `packages/claude-code/src/hook.ts:327-332`). But the default bridge timeout is 300,000 ms, `child.kill()` is SIGTERM only, there is no circuit breaker, and a hung model load can block a compaction for five minutes (`packages/core/src/bridge.ts:90-93`).
8. **Tests are mock-only.** Python tests inject fake `sentence_transformers`/`llmlingua`; CLI tests stub `ContextOptimizer`; JS tests fake `runOptimizer`/bridge scripts. No test loads real weights, checks compression quality, measures latency/memory, or covers timeout/concurrency (`tests/test_context_optimizer_core.py:23-86`, `tests/test_context_optimizer_cli.py:35-56`, `tests/core.test.mjs:168-173`, `tests/claude-hook.test.mjs:153-162`).
9. **Reusable for V2:** config precedence/validation, payload/outcome shaping, TS strategy primitives, transcript/message serializers, the Python pipeline itself, the debug bundle layout, the LLM-judge evaluation rubric, and the fake-bridge test pattern.
10. **V2 direction:** long-lived Python worker with model reuse + cache; `ctx.session.hook("context")` for cheap TS strategies plus optional bounded ML compression; `ctx.session.hook("compaction")` + `event.result` instead of the flag/splice workaround; `ctx.tool.hook("execute.after")` for incremental tool-output compression; token-aware, stage-aware stats; code-aware/preserve-order compression.

---

## 1. Architecture map

### 1.1 Repository layout

```
/tmp/ctxopt-ref
├── package.json                     # v0.5.0, bin, exports, build/test scripts
├── tsup.config.ts                   # 4 bundles: index, cli, opencode, claude-hook
├── tsconfig.json
├── README.md
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── index.ts             # re-exports core modules
│   │       ├── config.ts            # defaults, env/stored config, stats CSV/table
│   │       ├── bridge.ts            # spawn Python, JSON stdin/stdout, timeout, errors
│   │       ├── payload.ts           # build payload, summarize, format outcomes
│   │       ├── strategies.ts        # markers, protected tools, tool signature
│   │       ├── paths.ts             # ~/.context-optimizer paths
│   │       ├── log.ts               # file log + stderr diagnostic
│   │       ├── debug.ts             # Claude debug bundles/eval storage
│   │       ├── detect.ts            # OpenCode/Claude detection
│   │       ├── install.ts           # pip deps, model warm-up, adapter install
│   │       └── cli.ts               # install/detect/optimize/stats/config/debug
│   ├── opencode/
│   │   └── src/
│   │       ├── plugin.ts            # OpenCode plugin/hooks/commands
│   │       └── strategies.ts        # live per-turn dedupe + error purge
│   └── claude-code/
│       ├── src/hook.ts              # precompact/sessionstart/postcompact
│       └── commands/                # markdown slash commands
├── python/
│   ├── context_optimizer.py         # ContextOptimizer ML pipeline
│   └── context_optimizer_cli.py     # stdin JSON -> stdout JSON wrapper
└── tests/
    ├── core.test.mjs
    ├── opencode-strategies.test.mjs
    ├── claude-hook.test.mjs
    ├── test_context_optimizer_core.py
    └── test_context_optimizer_cli.py
```

The build produces four ESM bundles (`tsup.config.ts:3-14`): `dist/index.js` (core), `dist/cli.js` (bin), `dist/opencode.js` (plugin), `dist/claude-hook.js` (Claude hook). The package exports them as `.`, `./opencode`, `./claude-code` (`package.json:10-15`). There are no runtime npm dependencies; everything is bundled. Python dependencies (`sentence-transformers`, `llmlingua`, and transitively PyTorch) are installed separately (`packages/core/src/install.ts:57-63`).

### 1.2 Core modules

| Module | Responsibility | Key entry points |
|---|---|---|
| `packages/core/src/config.ts` | Defaults, env > stored > default resolution, per-model limits, config value validation, results CSV and stats table. | `resolveEffectiveConfig` (`:97-156`), `optimizerOptionsFromConfig` (`:162-174`), `parseConfigValue` (`:183-210`), `recordOptimizationStats` (`:230-253`), `formatStatsTable` (`:282-321`) |
| `packages/core/src/bridge.ts` | Resolve Python command, spawn bridge, merge global options, enforce timeout, normalize stdout/errors, warn once. | `runOptimizer` (`:59-138`), `normalizePythonResult` (`:17-37`), `resolvePythonCommand` (`:9-15`) |
| `packages/core/src/payload.ts` | Build the canonical request, apply `model_limits`, summarize context, format user-facing outcomes. | `buildPayload` (`:24-55`), `summarizeContext` (`:57-69`), `formatSizeSummary` (`:71-77`), `formatOutcomeMessage` (`:86-108`) |
| `packages/core/src/strategies.ts` | Shared TS primitives: markers, 4-turn error purge, protected tool set, stable tool signature. | `OPTIMIZED_OUTPUT_MARKER` (`:8-9`), `PROTECTED_TOOLS` (`:14-26`), `toolSignature` (`:49-52`) |
| `packages/core/src/paths.ts` | All state under `CONTEXT_OPTIMIZER_HOME` or `~/.context-optimizer`, plus OpenCode/Claude config dirs. | `dataDir` (`:6-8`), `pythonCliPath` (`:26-28`), `claudeSessionDir` (`:31-33`), `debugDir` (`:36-38`) |
| `packages/core/src/log.ts` | Append timestamped log lines; fall back to stderr. | `writeLog` (`:15-23`), `writeDiagnostic` (`:7-13`) |
| `packages/core/src/debug.ts` | Claude debug mode: per-session/per-compaction folders, `plugin.txt`/`native.txt`/`meta.json`/`index.md`, latest lookup. | `isDebugEnabled` (`:47-51`), `recordPluginDebug` (`:91-114`), `recordNativeDebug` (`:127-156`), `findDebugCompaction` (`:223-254`) |
| `packages/core/src/detect.ts` | Detect OpenCode via `~/.config/opencode` or binary; Claude via `~/.claude` or binary. | `detectOpenCode` (`:17-19`), `detectClaudeCode` (`:21-23`) |
| `packages/core/src/install.ts` | Check Node/Python, pip install, copy Python bridge, warm models, install plugin/hooks/commands. | `install` (`:155-185`), `copyPythonFiles` (`:65-74`), `downloadModels` (`:76-86`), `installClaudeAdapter` (`:112-153`) |
| `packages/core/src/cli.ts` | CLI surface: `install`, `detect`, `optimize`, `stats`, `config`, `debug`. | `runConfig` (`:52-94`), `runDebug` (`:96-134`), `main` (`:136-193`) |
| `packages/core/src/index.ts` | Re-export all core modules for programmatic use/tests. | `:1-9` |

### 1.3 OpenCode adapter

`packages/opencode/src/plugin.ts` exports `id = "context-optimizer"` (`:113`), an async factory `ContextOptimizerPlugin` (`:115-347`), and `server`/`default` aliases (`:349-351`). The factory returns:

- a `command` map with five `/context-optimizer*` commands (`:290-312`);
- `command.execute.before` (`:313`) for command handling;
- `experimental.session.compacting` (`:314-316`), which only records a timestamp for the session;
- `experimental.chat.messages.transform` (`:317-341`), which runs TS strategies on every turn and, if the session was just flagged, replaces the summarizer's messages with the Python result.

Two important implementation details:

1. **Compaction is a two-hook workaround.** `experimental.session.compacting` receives no messages, so it only sets `compactingSessions.set(sessionID, Date.now())` (`:314-316`). The next `messages.transform` consumes the flag if it is younger than 10 s (`:128-129,329-334`). The comment at `:121-125` explains this is because the compacting hook's `context` starts empty and the transform runs on the exact messages serialized for the summarizer.
2. **The transform mutates in place.** `optimizeCompaction` calls `messages.splice(0, messages.length, {info: lastUser.info, parts: [{type:"text", text:"## Optimized Context\n\n..."}]})` (`:164-171`). The comment says "In place: OpenCode keeps its own reference to this array" (`:166`). Per-turn strategies also mutate `part.state.output`/`part.state.input` in place (`packages/opencode/src/strategies.ts:62,83`).

`messagesToDocs` (`:77-95`) flattens the session into one doc per message:

- role prefix: `[User]` only for `info.role === "user"`, everything else `[Assistant]` (`:80`);
- text and reasoning parts if `part.text && !part.ignored` (`:83-84`);
- tool parts: `[tool <name>] <JSON input>` (`:85-86`);
- completed tool output (untruncated) (`:87`);
- error line `[error] <error>` (`:88`);
- empty messages skipped (`:91-92`).

Commands are handled by `command` (`:181-288`). `context` reads the session via `dependencies.client.session.messages` (`:199-205`) and returns counts; `stats` returns the CSV table; `compact` runs one optimization pass and prints the JSON result without changing the session (`:222-236`); `config` supports show/get/set/reset (`:238-285`). Replies mutate the host's `output.parts` and set `output.noReply = true` (`:192-197`).

### 1.4 Claude Code adapter

`packages/claude-code/src/hook.ts` is a standalone Node script invoked as `node claude-hook.mjs <mode>` (`packages/core/src/install.ts:129-141`). It reads one JSON object from stdin (`:52-56,313-320`) and supports:

- **`precompact`** (`:184-258`): parse the transcript (`transcriptToDocs`, `:93-160`), skip if no transcript/docs/size below `min_chars`, run the bridge, then:
  - debug mode: save the plugin result only; native compaction proceeds (`:224-228`);
  - manual `/compact`: on success write a project-keyed hand-off file and exit 2 to block Claude's compaction; the user must run `/clear` (`:233-243`);
  - auto-compact: on success write a session-keyed hand-off file and let Claude's compaction proceed; the optimized context is injected next to the native summary (`:245-257`).
- **`sessionstart`** (`:269-298`): for `source === "compact"` consume the session hand-off and outcome report; for `source === "clear"` consume the project hand-off; inject `## Optimized Context` as `additionalContext` and show the outcome as `systemMessage` (which does not enter context).
- **`postcompact`** (`:300-311`): only in debug mode; capture `compact_summary` next to the plugin result, write `native.txt`, update `meta.json`/`index.md`, print a report to stderr and exit 2.

Hand-off files live under `~/.context-optimizer/claude-sessions/` (`packages/core/src/paths.ts:31-33`). A `/clear` hand-off expires after 1 hour (`hook.ts:182,263`); stale files are consumed and dropped (`:281-285`). SessionStart output shape is `{systemMessage?, hookSpecificOutput:{hookEventName:"SessionStart", additionalContext}}` (`:288-297`).

The adapter's `transcriptToDocs` (`:93-160`) differs from OpenCode:

- It parses JSONL, extracts only `text` blocks (`extractTexts`, `:58-70`), tracks tool_use/tool_result pairs, and caps each tool result at 2,000 chars (`:72,124`).
- It dedupes identical tool calls by signature, keeping only the newest result (`:142-148`); older duplicates are dropped entirely, not replaced with a marker (`:150-157`).
- It drops errored tool results older than 4 user turns (`:154`).
- It keeps protected tools (`:152`), skips orphan tool results (`:121-122`), and keeps only the last 200 docs (`:41,159`).

### 1.5 Python ML core

`python/context_optimizer.py` defines `ContextOptimizer` (`:18-185`):

- Constructor defaults: reranker `BAAI/bge-reranker-large`, embedder `all-MiniLM-L6-v2`, compressor auto by device, rate 0.6, max_chunks 12, dedupe 0.9, prune budget 8,000 chars, error prefixes `("[error]", "[context-optimizer] error")` (`:19-29,57`).
- Device: CUDA if `torch.cuda.is_available()`, else CPU (`:30`).
- Compressor default: `microsoft/llmlingua-2-xlm-roberta-large-meetingbank` on CUDA, `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` on CPU (`:31-39`).
- Loads three models sequentially: `CrossEncoder`, `SentenceTransformer`, `PromptCompressor(use_llmlingua2=True)` (`:45-51`).
- Pipeline: normalize docs (`:61-69`), purge docs whose *first characters* match an error prefix (`:71-76,177`), embedder prefilter to `max(40, max_chunks*4)` docs (`:101-118`), reranker score (`:129`), sort desc (`:134-136`), greedy cosine dedupe (`:78-99`), greedy char budget (`:138-155`), slice `max_chunks` (`:185`), LLMLingua `compress_prompt(docs, rate=...)` (`:157-166`).

`python/context_optimizer_cli.py` is the bridge process (`:34-101`):

- reads all stdin bytes and decodes UTF-8 explicitly (`:40`);
- parses JSON (`:41-45`);
- validates `docs` is a list of strings (`:51-59`);
- computes `initial_size` as the sum of all doc lengths (`:63`);
- enforces `min_input_size` if present and an int (`:64-76`);
- pops `min_input_size`, constructs `ContextOptimizer(**options)`, calls `optimize(query, docs)` (`:78-88`);
- emits `{ok:true, optimized_context, initial_size, final_size}` or a structured error (`:90-97`, `:7-21`).

The installer copies all `python/*.py` to `~/.context-optimizer/python/` (`packages/core/src/install.ts:65-74`), which is the default `CONTEXT_OPTIMIZER_CLI` path (`packages/core/src/paths.ts:26-28`).

### 1.6 Tests

| File | Scope |
|---|---|
| `tests/core.test.mjs` | Payload flattening/error docs, size formatting, result normalization, config round-trip/tuning/validation, stats CSV/table, bridge fail-open on a missing script, plugin loader shape, OpenCode compaction replacement, commands, skip/fail-open paths (`:13-241`). |
| `tests/opencode-strategies.test.mjs` | Dedupe newest-wins, key-order equivalence, protected tools, error-input purge age, idempotence/malformed input (`:25-86`). |
| `tests/claude-hook.test.mjs` | SessionStart injection/consumption, stale `/clear` hand-off, non-compact silence, missing transcript, transcript dedupe/purge/protected/orphan, manual block, debug bundle/report/latest, debug no-result reason, auto outcome report, failed auto, stale outcome (`:19-284`). |
| `tests/test_context_optimizer_core.py` | Fake `sentence_transformers`/`llmlingua` modules; init logging, compressor device default/override, rerank/compress, exact dedupe, empty input, error purge, protected docs, tuple normalization, prune budget, oversized high-value doc (`:23-210`). |
| `tests/test_context_optimizer_cli.py` | Invalid JSON, empty docs, invalid docs type, min threshold, mixed docs, happy path, `min_input_size` not forwarded to constructor, runtime error, missing CLI (`:60-219`). |

### 1.7 End-to-end flows

**OpenCode automatic compaction**

```
session.compacting
  -> compactingSessions.set(sessionID, now)            plugin.ts:314-316
messages.transform (messages serialized for summarizer)
  -> applyOptimizationStrategies (TS dedupe/purge)     plugin.ts:319-327
  -> if flag fresh (<=10s):
       messagesToDocs                                  plugin.ts:77-95
       buildPayload (model_limits gate)                payload.ts:24-55
       runOptimizer                                    bridge.ts:59-138
         -> spawn python3 context_optimizer_cli.py
         -> ContextOptimizer(): load 3 models
         -> prefilter/rerank/dedupe/budget/slice/LLMLingua
         -> JSON stdout
       messages.splice -> one "## Optimized Context"   plugin.ts:164-171
  -> OpenCode summarizer LLM summarizes that one message
```

**OpenCode normal turn**

```
messages.transform
  -> applyOptimizationStrategies (dedupe + error purge only, in place)
  -> no flag -> return
```

**Claude Code manual `/compact`**

```
PreCompact (trigger=manual)
  -> transcriptToDocs (dedupe/purge/truncate/last 200)
  -> runOptimizer -> Python
  -> on success: write clear-<project>.md, exit 2, native compaction blocked
User runs /clear
  -> SessionStart (source=clear)
  -> consume hand-off, inject "## Optimized Context" as additionalContext
```

**Claude Code auto-compact**

```
PreCompact (trigger=auto)
  -> optimizer result written to <session>.md + <session>.outcome.txt
  -> native compaction proceeds on full transcript
SessionStart (source=compact)
  -> inject optimized context next to native summary
  -> show outcome report once as systemMessage
```

**CLI**

```
stdin JSON -> runOptimizer -> Python -> stdout normalized JSON
```

---

## 2. Bridge protocol (exact)

### 2.1 Transport and lifecycle

- **Direction:** TypeScript parent -> Python child over pipes. One request per process.
- **Command:** `CONTEXT_OPTIMIZER_PYTHON` if set, else `python3` on non-Windows, `py -3` on Windows (`packages/core/src/bridge.ts:9-15`). The env var is treated as a single executable path, not split into argv.
- **Script:** `CONTEXT_OPTIMIZER_CLI` if set, else `~/.context-optimizer/python/context_optimizer_cli.py` (`packages/core/src/paths.ts:26-28`).
- **Spawn:** `child_process.spawn(python[0], [...python.slice(1), cliPath], {stdio:["pipe","pipe","pipe"]})` (`bridge.ts:77-79`).
- **Request write:** `JSON.stringify(mergedPayload)` to stdin, then `stdin.end()` (`bridge.ts:126-131`). No newline framing, no request id, no length prefix.
- **Response read:** stdout is accumulated as a string until `close`, then `JSON.parse` (`bridge.ts:95-97,113-124`). stderr is accumulated separately (`:99-101`) and only appended to the error message if stdout parsing fails (`:118-122`).
- **Exit:** Python writes one JSON object, flushes, and raises `SystemExit` (`context_optimizer_cli.py:7-10`). Success/no-op exit 0; errors exit 1 (`:13-21`). **The TS side does not inspect the exit code**; it parses stdout regardless (`bridge.ts:113-124`).
- **Concurrency:** one child per call. No pool, no semaphore, no queue. Multiple sessions can spawn multiple Python processes, each loading three models.

### 2.2 Request payload (stdin)

The canonical shape is `OptimizerPayload` (`packages/core/src/payload.ts:5-11`):

```json
{
  "model": "claude-sonnet-4-20250514",
  "query": "Optimize the most relevant context for compaction.",
  "docs": ["[User]: ...", "[Assistant]: ..."],
  "size": 123456,
  "options": {
    "compression_rate": 0.6,
    "max_chunks": 12,
    "dedupe_threshold": 0.9,
    "total_prune_budget_chars": 8000,
    "reranker_model": "BAAI/bge-reranker-large",
    "embed_model": "all-MiniLM-L6-v2",
    "min_input_size": 2000
  }
}
```

| Field | Producer | Meaning | Consumed by Python? |
|---|---|---|---|
| `model` | `buildPayload`: `input.model || output.model` (`payload.ts:28`) | Model id used for `model_limits` lookup and diagnostics. | No (`context_optimizer_cli.py:47-49` ignores it) |
| `query` | `output.prompt || input.prompt || DEFAULT_QUERY` (`payload.ts:50`) | Reranker query and LLMLingua context. Default is the constant `"Optimize the most relevant context for compaction."` (`payload.ts:3`). | Yes (`:48,86`) |
| `docs` | `output.context`, filtered to non-empty strings (`payload.ts:33-36`) | Text chunks to rank/dedupe/compress. | Yes (`:47,51-59`) |
| `size` | Sum of `docs` lengths in JS (`payload.ts:37`) | Used for `model_limits` gating and diagnostics. | No |
| `options` | Merged from global config, payload, model limits (`payload.ts:29-46`; `bridge.ts:69-74`) | Tuning knobs forwarded as `ContextOptimizer.__init__` kwargs after popping `min_input_size`. | Yes (`:80-82`) |

**Option merge order (lowest to highest precedence):**

1. Defaults / stored config / env, resolved by `resolveEffectiveConfig` (`config.ts:97-156`).
2. `optimizerOptionsFromConfig(config)` — only the seven tuning keys, and `compressor_model` only if non-empty (`config.ts:162-174`).
3. `payload.options` supplied by the adapter or caller — wins over global config (`bridge.ts:69-74`).
4. `model_limits[model]` — applied inside `buildPayload` *only* when `size >= auto_compression_chars` (`payload.ts:38-46`). Since `buildPayload` runs before `runOptimizer`'s merge, these keys overwrite global and payload options.

**Important:** `model_limits` is only applied by `buildPayload`. The Claude `precompact` path and the CLI `optimize` path construct payloads manually and never call `buildPayload` (`packages/claude-code/src/hook.ts:209-217`; `packages/core/src/cli.ts:158-167`). So `model_limits` and `auto_compression_chars` are effectively **OpenCode-only** in this version.

**No `min_input_size` by default:** OpenCode automatic compaction adds it (`plugin.ts:153-160`), the OpenCode `/compact` command adds it (`:224-232`), and Claude adds it (`hook.ts:209-217`). The CLI `optimize` does not (`cli.ts:158-167`), so a direct CLI payload below the threshold still runs unless the caller includes it.

**Unknown option keys are fatal:** after popping `min_input_size`, the remaining `options` are splatted into `ContextOptimizer(**options)` (`context_optimizer_cli.py:80-82`). A typo or an extra key in `model_limits` raises `TypeError`, which is caught and emitted as `runtime_error`; the whole optimization is lost. There is no schema validation.

### 2.3 Response payload (stdout)

Success with optimization (`context_optimizer_cli.py:90-97`):

```json
{
  "ok": true,
  "optimized_context": "compressed text",
  "initial_size": 123456,
  "final_size": 4321
}
```

No-op (`context_optimizer_cli.py:54-56,64-76`):

```json
{
  "ok": true,
  "status": "no_optimization",
  "reason": "no compaction documents were provided.",
  "optimized_context": "",
  "initial_size": 0,
  "final_size": 0
}
```

Error (`context_optimizer_cli.py:13-21`):

```json
{
  "ok": false,
  "error_code": "runtime_error",
  "message": "..."
}
```

TS normalization (`bridge.ts:17-37`):

```json
{
  "ok": true,
  "optimizedContext": "compressed text",
  "initialSize": 123456,
  "finalSize": 4321,
  "status": "optimized",
  "reason": ""
}
```

| Python field | TS field | Notes |
|---|---|---|
| `ok` | `ok` | Truthiness checked; a missing `ok` becomes `ok:false` with `error_code:"runtime_error"` and `message:"Unknown error"` (`bridge.ts:30-36`). |
| `optimized_context` | `optimizedContext` | Defaults to `""` (`bridge.ts:22`). |
| `initial_size` | `initialSize` | Passed through unvalidated; may be `undefined` if Python omitted it. |
| `final_size` | `finalSize` | Same. |
| `status` | `status` | Defaults to `"optimized"` if `optimized_context` is non-empty, else `"no_optimization"` (`bridge.ts:25`). On error it is forced to `"failed"` (`:35`). |
| `reason` | `reason` | Defaults to `""`; on error falls back to `message`. |
| `error_code` | `errorCode` | Defaults to `"runtime_error"`. |
| `message` | `message` | Defaults to `"Unknown error"`. |

### 2.4 Error codes

| Code | Emitted by | Trigger | Retryable? |
|---|---|---|---|
| `invalid_input` | Python CLI (`:44-45,51-52,58-59`) | Malformed JSON; `docs` not a list; any non-string doc. | No, fix the sender. |
| `dependency_missing` | Python CLI (`:30-31,83-84`) | `ModuleNotFoundError` importing `context_optimizer` (usually missing `sentence_transformers`, `llmlingua`, or torch); `ContextOptimizer` import unavailable. | No until install. |
| `runtime_error` | Python CLI (`:87-88`) | Any exception constructing/using `ContextOptimizer` (model load, OOM, bad option key, LLMLingua failure). | Maybe; often OOM/transient. |
| `timeout` | TS bridge (`:90-93`) | Timer fired; child killed with SIGTERM. | Maybe with a longer timeout / smaller input. |
| `python_missing` | TS bridge (`:103-106`) | `spawn` error (e.g. ENOENT, permission). | No until Python path fixed. |
| `runtime_error` | TS bridge (`:117-123`) | stdout is empty or not valid JSON; stderr appended to `message`. | Maybe; inspect stderr. |

There is no distinct code for model-download failure, CUDA OOM, cancellation, or protocol version mismatch. OOM usually surfaces as `runtime_error` or a killed process with empty stdout.

### 2.5 Timeouts and cancellation

- **Default:** `DEFAULT_TIMEOUT_MS = 300000` (5 minutes) (`config.ts:7`), resolved per call (`bridge.ts:63`), env-overridable via `CONTEXT_OPTIMIZER_TIMEOUT_MS`.
- **Implementation:** `setTimeout(() => { child.kill(); finish({ok:false,errorCode:"timeout",...}) }, timeoutMs)` (`bridge.ts:90-93`).
- **No SIGKILL escalation:** `child.kill()` sends SIGTERM. If Python is inside a native PyTorch/CUDA call and ignores SIGTERM, the promise resolves but the child may linger; for the CLI/hook process, the child handle can keep the event loop alive.
- **No AbortSignal:** `runOptimizer` exposes only `timeoutMs` (`bridge.ts:51-56`); host cancellation/user interrupt is not propagated.
- **Host-level timeout:** Claude Code/OpenCode may impose their own hook/plugin timeouts outside this repo. The bridge's 5-minute default can exceed those, in which case the host kills the hook and the fail-open path never runs. The repo does not configure host timeouts.
- **Timer scope:** cleared on `error` and `close` (`bridge.ts:104,114`); a `settled` guard prevents double resolution (`:82-88`).
- **Per-call override:** `runOptimizer({timeoutMs})` is supported but no adapter passes it; all use the config default.

### 2.6 Protocol fragility / sharp edges

1. **stdout must be pure JSON.** Any library warning/progress printed to stdout makes `JSON.parse` fail and turns a successful compression into `runtime_error` (`bridge.ts:17-18,113-124`). Python logs go to stderr (`context_optimizer.py:5-10`), but third-party libraries are not controlled.
2. **Exit code ignored.** A Python traceback with a valid partial JSON object on stdout would be treated as success; an exit 1 with valid JSON is also accepted (`bridge.ts:113-124`).
3. **No request id / schema version.** Cannot correlate responses, detect version skew, or safely add fields. The payload is a bare object.
4. **Huge payloads are buffered in memory.** `JSON.stringify(mergedPayload)` and Python `sys.stdin.buffer.read()` hold the entire request; OpenCode includes untruncated tool inputs/outputs (`plugin.ts:86-88`). There is no max size.
5. **No streaming.** The child produces nothing until the final JSON; the parent cannot show progress or cancel cleanly.
6. **stderr accumulation is unbounded** (`bridge.ts:99-101`); model download/progress bars can consume memory.
7. **`warnOnce` is an unbounded in-process Set** keyed by session+message (`bridge.ts:39-49`); long-lived OpenCode servers accumulate keys.
8. **`CONTEXT_OPTIMIZER_PYTHON` cannot contain arguments** (e.g. `"python3 -u"`); it is used as argv[0] (`bridge.ts:10-12`).
9. **No environment hardening:** no `PYTHONUNBUFFERED`, `HF_HOME`, `OMP_NUM_THREADS`, `CUDA_VISIBLE_DEVICES`, or offline flags are set; the child inherits the host environment.
10. **Python import errors are only partly caught.** The CLI catches `ModuleNotFoundError` (`context_optimizer_cli.py:24-31`), but `context_optimizer.py` imports `sentence_transformers` and `llmlingua` at module top before its optional torch guard (`context_optimizer.py:1-16`). A broken CUDA/torch install that raises `OSError`/`ImportError` instead of `ModuleNotFoundError` produces a traceback and no JSON.

---

## 3. Configuration defaults

### 3.1 Defaults and env vars

`packages/core/src/config.ts:7-18` defines the constants; `resolveEffectiveConfig` (`:97-156`) applies env > stored `~/.context-optimizer/config.json` > defaults.

| Key | Default | Env var | Notes |
|---|---:|---|---|
| `timeout_ms` | `300000` | `CONTEXT_OPTIMIZER_TIMEOUT_MS` | Bridge timeout in ms. No minimum; `0` means immediate timeout. |
| `min_chars` | `2000` | `CONTEXT_OPTIMIZER_MIN_CHARS` | JS-side skip threshold; also forwarded as `min_input_size` and re-checked in Python. |
| `compression_rate` | `0.6` | `CONTEXT_OPTIMIZER_COMPRESSION_RATE` | LLMLingua-2 `rate`: fraction of tokens kept. Higher = more detail. |
| `max_chunks` | `12` | `CONTEXT_OPTIMIZER_MAX_CHUNKS` | Positive integer; rounded in JS (`:112-121`), used as slice in Python. |
| `dedupe_threshold` | `0.9` | `CONTEXT_OPTIMIZER_DEDUPE_THRESHOLD` | Cosine similarity >= threshold => duplicate. |
| `total_prune_budget_chars` | `8000` | `CONTEXT_OPTIMIZER_PRUNE_BUDGET_CHARS` | Char budget of ranked+deduped docs kept before compression. `<=0` makes `_pre_prune` return `[]` (`python/context_optimizer.py:122-123`). |
| `auto_compression_chars` | `4000` | `CONTEXT_OPTIMIZER_AUTO_COMPRESSION_CHARS` | **Not an auto-compression trigger.** Gate for applying `model_limits` in `buildPayload` (`payload.ts:42`). |
| `reranker_model` | `BAAI/bge-reranker-large` | `CONTEXT_OPTIMIZER_RERANKER_MODEL` | CrossEncoder. Large/slow default. |
| `embed_model` | `all-MiniLM-L6-v2` | `CONTEXT_OPTIMIZER_EMBED_MODEL` | SentenceTransformer used for prefilter + dedupe. |
| `compressor_model` | `""` (auto) | `CONTEXT_OPTIMIZER_COMPRESSOR_MODEL` | Empty means Python picks by device: xlm-roberta-large on CUDA, bert-base multilingual on CPU (`context_optimizer.py:35-39`). Only forwarded when non-empty (`config.ts:171-173`). |
| `model_limits` | `{}` | `CONTEXT_OPTIMIZER_MODEL_LIMITS` | Per-model overrides, e.g. `{"gpt-4.1":{"compression_rate":0.65,"max_chunks":8}}`. Only OpenCode `buildPayload` applies it; only if size >= `auto_compression_chars`. |
| `debug` | `false` (absent) | `CONTEXT_OPTIMIZER_DEBUG` overrides | Stored in config; `debug.ts:47-51` treats `1/true/on/yes` as on and any other non-empty value as off. |
| `CONTEXT_OPTIMIZER_HOME` | `~/.context-optimizer` | env only | Root for config, log, stats, Python bridge, sessions, debug (`paths.ts:6-8`). |
| `CONTEXT_OPTIMIZER_PYTHON` | `python3` / `py -3` | env only | Single executable path. |
| `CONTEXT_OPTIMIZER_CLI` | `~/.context-optimizer/python/context_optimizer_cli.py` | env only | Bridge script path. |

### 3.2 Precedence summary

```
per-request payload.options
  > model_limits[model] (OpenCode only, size >= auto_compression_chars)
  > env var
  > stored config.json
  > default
```

Within `buildPayload`, `output.options` wins over `input.options` (`payload.ts:29-32`). Within `runOptimizer`, the global config is the base and payload options win (`bridge.ts:69-74`). Within `resolveEffectiveConfig`, env wins over stored (`config.ts:97-156`).

### 3.3 Validation quirks

- `parseConfigValue` rejects any numeric value `<= 0` (`config.ts:196-199`). This means `config set compression_rate 0` and `config set dedupe_threshold 0` are rejected even though the documented range is 0–1 (`README.md:203-205`), and `auto_compression_chars` cannot be set to 0 via the CLI even though the resolver clamps it to >=0 (`config.ts:135-143`).
- Env/stored values bypass `parseConfigValue`: negative or out-of-range values are accepted by `resolveEffectiveConfig` (only `max_chunks`, `total_prune_budget_chars`, `auto_compression_chars` are rounded/clamped). A negative `timeout_ms` becomes an immediate timer; a negative `compression_rate` reaches LLMLingua and fails; `dedupe_threshold > 1` disables dedupe.
- `max_chunks` is rounded in JS (`config.ts:112-121`), and `parseConfigValue` requires an integer (`:201-203`). `total_prune_budget_chars` is rounded in JS but not required to be an integer by `parseConfigValue`.
- `model_limits` values are not validated at all. Arbitrary keys are forwarded to `ContextOptimizer(**kwargs)` and can cause `TypeError`.
- Config writes are direct `writeFileSync` with no temp-file/rename (`config.ts:82-86`); concurrent config commands can corrupt the file.
- `readStoredConfig` silently returns `{}` on parse/read errors (`config.ts:74-80`); a malformed config file is silently ignored rather than reported.
- The CSV header is written only if the file does not exist (`config.ts:251-252`); concurrent first writes can duplicate the header. Rows are appended without locking (`:252`).

---

## 4. When LLMLingua actually runs

### 4.1 Decision table

| Path | Trigger | LLMLingua? | What is sent | What happens to the result | Skips |
|---|---|---|---|---|---|
| OpenCode automatic compaction | `experimental.session.compacting` sets a flag; next `experimental.chat.messages.transform` consumes it within 10 s | **Yes** | `messagesToDocs` of the messages serialized for the summarizer | Replaces the summarizer's messages with one `## Optimized Context` message; the summarizer LLM then summarizes it | no last user; no docs; `size < min_chars`; Python failure; empty `optimized_context` |
| OpenCode normal chat turn | `experimental.chat.messages.transform` without a fresh flag | **No** | n/a | TS dedupe + error-input purge only | n/a |
| OpenCode `/context-optimizer compact` | User command | **Yes** | Current session messages via SDK, `messagesToDocs` | Printed as JSON in the command reply; **session is not changed** | no docs; Python failure |
| OpenCode `/context-optimizer context` | User command | No | Counts only (`summarizeContext`) | Displayed | n/a |
| Claude Code manual `/compact` | `PreCompact` with `trigger="manual"` | **Yes** | `transcriptToDocs` (text + tool results, last 200) | Plugin result becomes the entire next context via `/clear`; native LLM summary is blocked | no transcript; docs/size below `min_chars`; Python failure; empty result |
| Claude Code auto-compact | `PreCompact` with `trigger="auto"` | **Yes** | Same transcript docs | Native summary still runs on the full transcript; optimized context is injected next to it at `SessionStart` | same as manual |
| Claude Code debug mode | `PreCompact` with debug on | **Yes** (compute) | Same transcript docs | Saved only; native compaction proceeds; plugin result is not used for the session | same as manual; stats not recorded |
| Claude Code normal turn | no hook | **No** | n/a | n/a | n/a |
| Claude `/context-optimizer:compact` | Slash command instructs the model to collect text and pipe JSON to `context-optimizer optimize` | **Yes** | Whatever text the model chooses to collect (`commands/context-optimizer/compact.md:6-11`) | JSON result shown; no session mutation | model may omit content; costs a model turn |
| CLI `context-optimizer optimize` | stdin JSON | **Yes** | Caller-provided docs | stdout JSON; stats row if `ok && optimized_context` | no docs; Python failure; optional `min_input_size` only if caller provides it |
| Installer model warm-up | `context-optimizer install` | **No compression** | n/a | Constructs all three models once to warm the disk cache | n/a |

### 4.2 OpenCode compaction, step by step

1. `experimental.session.compacting` fires with `{sessionID}`; the plugin stores `Date.now()` in `compactingSessions` (`plugin.ts:314-316`). It does **not** receive messages and does **not** call Python.
2. OpenCode calls `experimental.chat.messages.transform` on the exact messages it will serialize for the summarizer (per the comment at `plugin.ts:121-125`).
3. The transform always runs `applyOptimizationStrategies` first (`plugin.ts:319-327`). This mutates tool parts in place: older duplicate completed outputs become `OPTIMIZED_OUTPUT_MARKER`; old errored call inputs become `OPTIMIZED_ERROR_INPUT_MARKER` (`opencode/strategies.ts:45-91`).
4. The transform reads `sessionID` from `messages[0]?.info?.sessionID`, looks up the flag, deletes it, and rejects it if older than 10 s (`plugin.ts:329-334`).
5. `optimizeCompaction` (`:131-179`):
   - finds the last user message (`:133`);
   - builds docs from **all** messages (`:134`);
   - reads `min_chars` (`:135`);
   - returns early if no last user or no docs (`:137-140`);
   - returns early if `payload.size < min_chars` (`:142-147`);
   - logs doc count/size (`:149-151`);
   - calls `runOptimizer` with `options: {min_input_size: minChars, ...payload.options}` (`:153-160`);
   - logs the outcome (`:162`);
   - on `ok && optimizedContext`: records stats (`:165`) and splices the messages down to one user message containing `## Optimized Context\n\n<text>` (`:167-170`), then shows a toast (`:171`);
   - on failure: shows an error toast (`:172-178`), leaving messages untouched.
6. OpenCode's summarizer then summarizes the single optimized message. **LLMLingua output is the summarizer's input, not the final compacted context.** There is still an LLM summary call, so the content is lossy twice.

### 4.3 OpenCode per-turn: no LLMLingua

`applyOptimizationStrategies` is pure TS (`opencode/strategies.ts:96-108`):

- `collectToolParts` walks messages, increments a turn counter on user messages, and collects every tool part with a string `tool` and a `state` (`:28-43`).
- `deduplicate` groups completed, non-protected tool parts by `toolSignature(tool, state.input)`, then replaces all but the last group member's `state.output` with `OPTIMIZED_OUTPUT_MARKER` (`:45-67`).
- `purgeErrors` finds errored, non-protected tool parts whose turn is at least `PURGE_ERROR_TURNS = 4` behind the current turn, and replaces every string value in `state.input` with `OPTIMIZED_ERROR_INPUT_MARKER`; the error output is kept (`:69-91`, `core/strategies.ts:12`).

This is the only "per-turn optimization". It never calls Python, never uses embeddings, and never compresses prose or file contents. README's phrase "OpenCode additionally optimizes each chat turn live" (`README.md:28,103`) refers to this TS-only path.

### 4.4 Claude Code: PreCompact only

`precompact` (`hook.ts:184-258`) always calls the bridge when the transcript is large enough, regardless of manual/auto, except that debug mode still computes but does not use the result (`:224-228`). The transcript conversion (`:93-160`) applies TS strategies at transcript level, not per turn:

- dedupe: newest result per tool signature wins; older results are **dropped**, not marked (`:142-157`);
- purge: errored tool results older than 4 user turns are **dropped entirely** (`:154`), unlike OpenCode which keeps the error output;
- protected tools are kept (`:152`);
- each tool result is truncated to 2,000 chars (`:72,124`);
- only the last 200 docs are kept (`:41,159`).

There is no Claude hook that rewrites the live conversation. The README says this explicitly (`README.md:133-138`). So Claude gets LLMLingua only at compaction, plus the manual slash command and CLI.

### 4.5 What exactly is compressed

**OpenCode (`messagesToDocs`, `plugin.ts:77-95`):**

- all `text` and `reasoning` parts (unless `part.ignored`) with `[User]`/`[Assistant]` prefix;
- all tool inputs as compact JSON (`[tool name] {...}`), including full `write`/`edit` content;
- all completed tool outputs, untruncated;
- error lines for errored tools (`[error] ...`);
- one doc per message, joined with newlines.

**Claude (`transcriptToDocs`, `hook.ts:93-160`):**

- every text block in the transcript;
- every tool result as `[tool name] <first 2000 chars>`;
- no tool inputs;
- deduped/purged/protected as above;
- last 200 docs.

**Python pipeline:** all docs are normalized, error-prefixed docs are dropped, then embedder prefilter -> reranker -> dedupe -> char budget -> slice -> LLMLingua. The compressor sees the surviving docs as a list; LLMLingua joins them (the tests' fake joins with `\n\n`, `tests/test_context_optimizer_core.py:61-63`).

**Protected tools are not protected from LLMLingua.** `PROTECTED_TOOLS` (`core/strategies.ts:14-26`) only guards the TS dedupe/purge passes. `messagesToDocs` and `transcriptToDocs` still include `write`, `edit`, `task`, etc., and Python compresses them. This is a critical distinction.

### 4.6 What is skipped

- **No docs / no last user:** OpenCode returns before calling Python (`plugin.ts:137-140`); Claude returns if no docs (`hook.ts:198-207`).
- **Below `min_chars`:** checked in OpenCode JS (`plugin.ts:142-147`), Claude JS (`hook.ts:198-207`), and Python via `min_input_size` (`context_optimizer_cli.py:64-76`).
- **Error-prefixed docs:** Python drops docs whose lowercased text starts with `[error]` or `[context-optimizer] error` (`context_optimizer.py:57,71-76,177`). In practice this rarely fires because OpenCode docs start with `[User]:`/`[Assistant]:` and Claude tool docs start with `[tool ...]`.
- **Budget exhausted:** `_pre_prune` stops adding docs when `total_prune_budget_chars` is exhausted (`:138-155`).
- **No pruned docs:** `optimize` returns `""` (`:181-183`); the adapters treat empty `optimized_context` as no optimization.
- **`total_prune_budget_chars <= 0`:** returns `[]` immediately (`:122-123`), disabling the entire pipeline.
- **Docs beyond the prefilter cap:** if there are more than `max(40, max_chunks*4)` docs, only the top ones by embedder cosine to the query proceed (`:101-118,127`). With defaults the cap is 48. Older context beyond the cap is never ranked or compressed.
- **Beyond `max_chunks`:** after ranking/dedupe/budget, only the first `max_chunks` docs are compressed (`:185`).
- **No-op result:** if Python returns `ok:true` with empty `optimized_context`, OpenCode leaves messages untouched (`plugin.ts:163-178`); Claude falls through to native compaction (`hook.ts:233-257`).

### 4.7 Default budget math (why the result is small)

With defaults:

- prefilter cap: `max(40, 12*4) = 48` docs (`context_optimizer.py:127`);
- reranker scores those 48;
- dedupe drops near-duplicates at cosine >= 0.9;
- char budget: 8,000 chars total (`config.ts:12`);
- `max_chunks`: 12 docs (`config.ts:10`);
- LLMLingua `rate=0.6` keeps ~60% of the tokens it sees (`config.ts:9`).

So the compressor normally sees at most 8,000 chars / 12 docs, except that one oversized high-value doc can exceed the budget (`context_optimizer.py:145-150`). It emits roughly 60% of the tokens it sees; the resulting char count is approximate and often lower. In OpenCode a doc is an entire message, so a 100-message session is reduced to at most 12 messages before compression, and the 8,000-char budget may cut that to 2–4 messages. The native summarizer would see the whole transcript. This is exactly the trade-off the README warns about (`README.md:12-15,34,142`).

Illustrative example (not measured): 200,000 chars of session -> prefilter 48 docs -> rerank/dedupe -> 8,000 chars -> 12 docs -> LLMLingua keeps ~60% of the tokens in that ~8,000-char slice (chars are approximate). Stats report `(200000-4800)/200000 = 97.6% saved`, but LLMLingua's own ratio applies only to the ~8,000 chars it saw; most of the "saving" is pruning. This is why `% saved` in stats is not a compression-quality metric.

### 4.8 Why the README warning is expected

The README says:

> "the plugins context result is considerably smaller but also often misses vital context. I am currently fine tuning the compact pipeline to get a better result, but it is still not as good as the native compaction." (`README.md:12-15`)

The code explains it:

1. **Aggressive recall limits:** 48-doc prefilter, 8,000-char budget, 12-doc slice (`context_optimizer.py:101-155,185`).
2. **Generic query:** automatic compaction ranks against `"Optimize the most relevant context for compaction."`, not the actual task (`payload.ts:3,50`; `plugin.ts:134`; `hook.ts:211`). The reranker has no idea what the user is doing.
3. **Chronology loss:** sorted by relevance, never restored (`context_optimizer.py:134-136,157-166`). Coding sessions are causal; reordering breaks "what changed after what".
4. **Code compression:** token-level LLMLingua on code/file contents, no `force_tokens`, no code-fence awareness (`context_optimizer.py:161-164`).
5. **Double loss in OpenCode:** LLMLingua output is then summarized by an LLM (`plugin.ts:164-171`; README `:102`).
6. **Repeated compaction:** already-compressed text can be compressed again on the next compaction (no cache/incremental; see §5.3).

The repo's own review quotes in `README.md:45-55` are more optimistic, but the author's warning is the authoritative signal: smaller, not necessarily better.

---

## 5. Limitations and risks for "use LLMLingua more often, including automatic compression"

### 5.1 Python process spawn per call and model reload cost

**What happens today:** every optimization is a fresh `spawn` (`bridge.ts:77-79`). The child imports `sentence_transformers`, `llmlingua` and torch, then `ContextOptimizer.__init__` constructs three models (`context_optimizer.py:45-51`). It handles exactly one payload and exits (`context_optimizer_cli.py:7-10,34-101`). Nothing is reused between calls.

**Consequences:**

- **Fixed cost paid on every compaction.** Model weights are read from disk into RAM/VRAM and initialized each time. The installer's warm-up (`install.ts:76-86`) only populates the Hugging Face disk cache; it does not keep a process or models alive. A "warm" run still pays import + checkpoint load.
- **No warm start for automatic compression.** If LLMLingua were called per turn, the user would pay this cost on every message. This is the primary blocker for per-turn use.
- **The 5-minute timeout hides the cost.** `DEFAULT_TIMEOUT_MS=300000` (`config.ts:7`) is large enough that a slow CPU load can look like a hang; users see no progress because stdout is silent until the final JSON.
- **Concurrency multiplies memory.** Two sessions compacting at once spawn two Python processes, each loading reranker + embedder + compressor. On a GPU this can OOM; on CPU it can thrash. There is no global semaphore or queue (`bridge.ts:59-138`).
- **No process reuse / health check.** A crashed Python process is not restarted or quarantined; the next call simply spawns again. A repeated dependency failure pays the spawn/import cost every time.
- **No cancellation.** A user interrupt does not kill the child; only the 300 s timer does, and only with SIGTERM (`bridge.ts:90-93`).
- **No model selection by workload.** The same three models load even for a tiny 2,000-char compaction or a request that will be discarded by `max_chunks`.

**What "more often" requires:** a long-lived worker (or a small pool with concurrency 1) that constructs `ContextOptimizer` once, keeps models resident, handles many JSON requests, and exposes health/readiness. Keep the one-shot CLI as a fallback for `optimize`/portability, but do not use it for per-turn hooks.

### 5.2 Three separate heavy models, initialization order and failure coupling

**Initialization order (`context_optimizer.py:45-51`):**

1. `CrossEncoder(reranker_model, device=device)` — default `BAAI/bge-reranker-large`, the largest/slowest default (README recommends `bge-reranker-base` for CPU, `README.md:224-231`).
2. `SentenceTransformer(embed_model, device=device)` — default `all-MiniLM-L6-v2`, used twice (prefilter and dedupe).
3. `PromptCompressor(model_name=compressor_model, use_llmlingua2=True, device_map=device)` — default xlm-roberta-large on CUDA or bert-base multilingual on CPU (`:35-39`).

**Risks:**

- **All-or-nothing loading.** If the reranker fails to load (OOM, missing weights, offline), the constructor raises before the compressor is created, so no compression happens at all. There is no staged degradation (e.g., skip rerank and compress the pruned docs, or skip compression and return pruned docs). The same applies if `PromptCompressor` fails: the already-loaded reranker/embedder work is wasted.
- **Sequential latency.** Loads are synchronous; time-to-first-result is the sum of all three. There is no parallel loading, lazy loading, or background warm-up inside the bridge.
- **Memory pressure.** All three stay resident for the life of the process. On CUDA, xlm-roberta-large + bge-reranker-large + embedder can be several GB; with concurrent processes this is a real OOM risk. There is no dtype/quantization/`low_cpu_mem_usage`/`empty_cache`.
- **Embedder does double work.** `_prefilter` encodes all docs plus the query (`:114-116`), then `dedupe` re-encodes the ranked subset (`:82`). The same model runs twice per optimization; embeddings are not cached.
- **Reranker does a full forward pass per (query, doc) pair** (`:129`). With the 48-doc cap this is bounded, but it dominates CPU latency; there is no batch-size control, no score cache, and no fallback to embedder-only ranking.
- **Compressor is not optional.** Even if LLMLingua is the only thing you want, the pipeline insists on loading reranker + embedder first. For per-turn tool-output compression, the compressor alone would suffice; loading all three is wasteful.
- **Device default is global.** `torch.cuda.is_available()` decides the device for all three (`:30`); there is no per-model device or CPU-offload policy. An explicit `compressor_model` does not change the device.

**Design implication:** split the runtime into optional stages/workers:

- `rank` worker: embedder + reranker for compaction;
- `compress` worker: LLMLingua only for tool outputs/per-turn;
- lazy-load each stage on first use; if a stage is unavailable, fall back to the previous stage's output (pruned docs, recency order, or raw text);
- warm the compressor in the background at plugin start, but do not block the first turn.

### 5.3 Compaction-only usage vs per-turn; no incremental compression; no caching

**Current usage is compaction-centric.** The only automatic LLMLingua path is OpenCode compaction (`plugin.ts:314-341`) and Claude PreCompact (`hook.ts:184-258`). Normal turns get TS dedupe/purge only. There is no threshold-triggered automatic compression when the context grows; `auto_compression_chars` is just a `model_limits` gate (`payload.ts:42`), not an auto-compress trigger.

**No incremental compression.** Every compaction sends the whole current doc set through the full pipeline:

- no content-addressed cache of compressed docs;
- no reuse of embeddings, reranker scores, or LLMLingua outputs;
- no "only compress the new/changed messages since last compaction" path;
- no session-level map of part hash -> compressed text;
- no cross-session cache for stable content (e.g., the same file read in many sessions).

**Repeated compaction degrades.** In OpenCode, after a compaction the session continues from the summarized text; the next compaction includes that summary in `messagesToDocs` and may compress it again. In Claude manual mode, `/clear` starts from the optimized text; the next compaction includes it and compresses again. Each pass is lossy; without a cache or "already compressed" marker, content can be eroded repeatedly.

**TS strategies are the only incremental part.** Dedupe markers persist in the message parts and are skipped on later runs (`opencode/strategies.ts:51`), so dedupe/purge are idempotent and incremental-ish. LLMLingua has no equivalent.

**No background/precompute.** The plugin does not compress while idle, does not precompute a compacted context, and does not overlap model load with the user's turn. Every compaction is a cold, synchronous request.

**No cache invalidation model.** If a cache were added, keys must include model name, compression rate, code version, and content hash; none of that exists today.

### 5.4 Mutating persisted message parts with markers; protected tools; dedupe correctness

#### 5.4.1 In-place mutation and persistence

- OpenCode per-turn strategies mutate `part.state.output` and `part.state.input` in place (`opencode/strategies.ts:62,83`). The tests assert the mutation (`tests/opencode-strategies.test.mjs:34,49-50,70-72`).
- The compaction path splices the host's `messages` array in place (`plugin.ts:167-170`). The comment says the host keeps its own reference (`:166`), which implies the array may be the one OpenCode uses/persists, not a disposable copy.
- **Risk:** if these objects are persisted, the original tool outputs/inputs are gone permanently. There is no raw backup for OpenCode markers (Claude debug mode saves plugin/native text, not per-part originals). A bug in dedupe or a wrong protected-tool decision becomes irreversible data loss in the session store.
- **Risk:** replacing `messages` with a single user message during a normal turn (if the 10 s flag fires at the wrong time) would replace the live conversation, not just the summarizer input. The flag is only TTL-guarded, not tied to a specific compaction event (`plugin.ts:128-129,329-334`). If compaction is canceled and the user sends a message within 10 s, `optimizeCompaction` can run on that normal turn and splice it.
- **Risk:** non-string tool outputs. `deduplicate` assigns a string marker to `state.output` regardless of its original type (`opencode/strategies.ts:62`); a host/UI expecting an object/array may break. `purgeErrors` only replaces string-valued keys and leaves non-strings, so input shape becomes mixed (`:81-85`).
- **Risk:** marker text is an assertion ("information superseded or no longer needed") that may be false; the model sees it as content. Markers are English-only and coupled by exact string equality; if the host truncates or rewrites them, idempotence breaks.

**V2 recommendation:** never mutate persisted parts. Return a replacement plan / new messages via `event.result`, keep the raw content in a sidecar keyed by part id/hash, and make markers explicit/versioned with a link to the raw content when the host allows retrieval.

#### 5.4.2 Protected tools

`PROTECTED_TOOLS` (`core/strategies.ts:14-26`):

```
task, skill, todowrite, todoread, batch, plan_enter, plan_exit, write, edit, patch, question
```

- Matching is lowercased (`:28-30`), so case variants are covered.
- **Not protected:** `read`, `bash`, `grep`, `glob`, `webfetch`, `mcp__*`, `apply_patch`, `multiedit`, and any host-specific tools. `read` dedupe is intentional (same file read twice -> older output dropped), but `bash` with the same command in a different cwd/env can be a false duplicate. `mcp__*` tools can have side effects and are not covered by the policy.
- **Protected only against TS strategies.** Python still receives `write`/`edit`/`task` content and compresses it (`plugin.ts:134`; `hook.ts:133`; `context_optimizer.py:161-164`). If the goal is "never compress write/edit payloads", the protection must be applied when building docs, not only in dedupe.
- The list is hard-coded, not configurable. Users cannot protect a custom MCP tool without editing source.

#### 5.4.3 Dedupe correctness

**Signature:** `toolSignature(tool, input)` = `tool + "::" + JSON.stringify(sortKeys(input))` (`core/strategies.ts:49-52`). `sortKeys` recursively sorts object keys and drops `undefined`/`null` values (`:32-43`). This gives key-order-insensitive, null-insensitive equality. Tests cover key order and protected tools (`tests/opencode-strategies.test.mjs:39-52`).

**OpenCode behavior (`opencode/strategies.ts:45-67`):**

- only `status === "completed"` parts participate (`:49`);
- protected tools skipped (`:50`);
- parts already equal to the marker skipped (`:51`);
- groups by signature; all but the last part in the group get the marker (`:60-65`);
- "last" is array order, assumed chronological.

**Correctness risks:**

1. **False positives from implicit context.** Two identical `bash` commands run in different working directories, environments, or after state changes have the same signature. The older output is discarded even though it may describe a different result.
2. **No path/command normalization.** `./a.ts` vs `a.ts`, whitespace differences, or equivalent flags produce different signatures (false negatives) or the same signature (false positives).
3. **Newest is not always best.** If the newest duplicate failed or returned an empty/partial result, the older successful output is still removed. OpenCode only groups completed results, so an errored newest is excluded and the older success survives—but a completed empty result will win.
4. **No recency/age limit.** Dedupe applies across the entire message list, including very old calls; it does not consider whether the older output is still referenced.
5. **No output-size threshold.** Even tiny duplicate outputs are replaced; the marker overhead can exceed the saved content for very short outputs.
6. **No cross-session awareness.** Fine (per-session), but no dedupe of repeated file reads across sessions.
7. **Signature collisions from dropped nulls.** `{path:"a", recursive:null}` and `{path:"a"}` are treated as identical; usually harmless, but can merge calls that the tool distinguishes.
8. **`JSON.stringify` can throw** on circular/non-serializable input; the transform catches at the plugin level (`plugin.ts:325-327`), but the whole per-turn strategy pass is then skipped.
9. **Marker equality is exact.** If a tool's real output equals `OPTIMIZED_OUTPUT_MARKER`, it is treated as already optimized; negligible but illustrates the coupling.

**Claude behavior (`hook.ts:142-157`):**

- Builds `newestBySignature` from non-protected tool results (`:142-148`).
- Drops every non-newest duplicate entirely (`:153`).
- Then drops errored results older than 4 turns (`:154`).
- **Bug-like interaction:** if a tool was called twice, the older result succeeded, and the newest result is an old error, the older is dropped as a duplicate and the newest is dropped as an old error -> **no result survives**. The model loses both. This cannot happen in OpenCode because errors are excluded from dedupe groups.
- Claude drops duplicates instead of marking them, so there is no trace that content was removed. Native compaction would at least summarize it.

#### 5.4.4 Error purge inconsistency

- **OpenCode:** after 4 user turns, string inputs of errored calls are replaced with `[input removed due to failed tool call]`; the error output is kept (`opencode/strategies.ts:69-91`; `README.md:106`). This preserves the failure message but destroys the command/path that caused it. For `read`, the path is replaced; the error output may or may not include it.
- **Claude:** after 4 user turns, errored tool results are dropped entirely (`hook.ts:154`; `README.md:136`). No marker, no error output. This contradicts OpenCode's "keep the error output" behavior.
- **Python:** `_purge_error_docs` drops docs whose first characters match `[error]`/`[context-optimizer] error` (`context_optimizer.py:71-76,177`). Adapter docs start with `[User]:`, `[Assistant]:`, or `[tool ...]`, so this is effectively dead for both adapters. Only direct CLI payloads with `[error]`-prefixed docs trigger it.
- **Result:** three different error policies, none tested for parity. A V2 design should pick one policy (keep error output + redact inputs; or drop both) and implement it in one shared place.

#### 5.4.5 Compaction flag / TTL

- The flag is keyed by session and expires after 10 s (`plugin.ts:128-129`). It is not correlated with a compaction id.
- The transform reads `sessionID` from `messages[0]?.info?.sessionID` (`:330`); if the first message lacks it, the flag is never consumed.
- If the flag is set but `messages.transform` is not called (compaction fails/canceled), it leaks until TTL; a normal turn within 10 s can consume it and be replaced with optimized context.
- If two compactions interleave, the second `set` overwrites the first timestamp; one transform consumes the flag, the other does not.
- `compactingSessions` is per plugin instance; a plugin reload loses pending flags.

V2's `ctx.session.hook("compaction")` + `event.result` should eliminate this entire class of bugs by binding the optimization to the compaction event.

### 5.5 Quality risk: code/file content, chronology, query, double compression

#### 5.5.1 Compressing code and file content

- OpenCode includes full tool inputs (`plugin.ts:86`), so `write`/`edit` payloads can contain entire files. It includes full completed outputs (`:87`), so `read`/`bash`/`grep` can contain code, diffs, logs, and paths.
- Claude includes tool results truncated to 2,000 chars (`hook.ts:72,124`), which can cut mid-code and mid-line; there is no "truncated" marker.
- LLMLingua-2 is a token-classification compressor. It drops low-information tokens; on code it can remove braces, punctuation, identifiers, imports, or path segments. The call passes only `rate` (`context_optimizer.py:161-164`); it does **not** pass `force_tokens`, `min_length`, `token_budget`, `condition_in_question`, or any code-aware option. There is no code-fence detection or syntax validation.
- The reranker/budget can drop a large code file entirely: the default query is generic, and the 8,000-char budget may not fit a file even if it is relevant. The oversized-first-doc exception only keeps one doc if its score is > 0 (`:145-150`).
- `_normalize_doc` joins tuple/list docs with spaces (`:65-67`), which destroys newlines/indentation if a caller supplies structured docs. The adapters currently supply strings, but the API supports tuples (test at `tests/test_context_optimizer_core.py:166-175`).
- Dedupe embeddings operate on whole docs; two similar code files may be treated as near-duplicates at cosine >= 0.9, or two versions of the same file may be collapsed, losing the diff history.

**Recommendation:** classify docs (`code`, `diff`, `logs`, `prose`, `json`, `error`). For code/diffs, default to lossless strategies: keep head/tail, preserve file path and line ranges, never LLMLingua. If compressing code is explicitly enabled, pass `force_tokens` for identifiers/paths/operators, keep fenced blocks intact, and validate that key symbols still appear.

#### 5.5.2 Chronology loss

`_pre_prune` sorts docs by reranker score descending (`:134-136`), dedupes in that order (`:134-136`), then `compress(pruned[:max_chunks])` preserves ranked order (`:181-185`). The final string is a relevance-ordered concatenation, not the original conversation order. This is a major quality issue for coding agents:

- "I changed X, then test Y failed, then I fixed Z" becomes a bag of chunks.
- File reads before/after edits lose their temporal relationship.
- Error messages may appear before the command that caused them.
- The summarizer (OpenCode) sees the reordered text and may infer wrong causality.

There is no `preserve_order` option, no re-sort by original index, and no metadata carrying turn numbers through the pipeline after serialization. The only ordering signal is the doc's position in `docs`, which is lost when sorted.

**Recommendation:** keep an index/turn on every doc; after ranking/dedupe/budget, either restore original order or emit grouped chronological sections ("earliest -> latest") with relevance used only for selection, not presentation.

#### 5.5.3 Generic query for automatic compaction

- `buildPayload` uses `output.prompt || input.prompt || DEFAULT_QUERY` (`payload.ts:50`).
- OpenCode `optimizeCompaction` passes only `{model}` and `{context}` (`plugin.ts:134`); there is no prompt, so the query is always `"Optimize the most relevant context for compaction."` (`payload.ts:3`).
- Claude `precompact` uses `input.custom_instructions || DEFAULT_QUERY` (`hook.ts:211`); custom instructions are usually absent, so also generic.
- The OpenCode `/compact` command allows `query: args || payload.query` (`plugin.ts:227`), and the CLI accepts a caller query, but automatic paths do not use the last user request.

The reranker therefore ranks "what looks generally important" rather than "what matters for the current task". A better query is the last user message, the compaction prompt, or a short task summary; even better, score against multiple queries and keep the union.

#### 5.5.4 Double compression in OpenCode

OpenCode replaces the summarizer's input with LLMLingua output, then the summarizer LLM writes a summary (`plugin.ts:164-171`; README `:102`). So the content is:

1. pruned by rerank/dedupe/budget;
2. token-drop compressed by LLMLingua at 0.6;
3. paraphrased/summarized by the LLM.

Three lossy stages. Claude manual mode skips the LLM summary (plugin output is the final context), which is arguably higher fidelity but still token-drop compressed. Claude auto mode has native summary + optimized context side by side, i.e., duplication rather than replacement.

#### 5.5.5 Protected tools still compressed

As noted in §5.4.2, `PROTECTED_TOOLS` only affects TS dedupe/purge. A `write` with a full file content is sent to Python and compressed. If the user's goal is "never lose code", this is the opposite of protection. The README's "mutating/planning tools are protected and never optimized away" (`README.md:106`) is true only for the per-turn TS strategies, not for compaction LLMLingua.

### 5.6 Token accounting and stats

**What is recorded (`config.ts:212-253`):**

- CSV columns: `timestamp, cli, session_id, trigger, initial_chars, result_chars, saved_chars` (`:212`).
- `initialChars = max(0, result.initialSize)`, `resultChars = max(0, result.finalSize)`, `savedChars = max(0, initial - result)` (`:236-238`).
- `cli` is `"opencode"`, `"claude-code"`, or `"cli"`; `trigger` is free text (`"manual"`, `"auto"`, etc.).
- Rows are appended only when the adapter has `ok && optimizedContext` (`plugin.ts:164-165`; `hook.ts:236,252`; `cli.ts:164`). Failures/no-ops are not counted.
- `formatStatsTable` aggregates by last/session/today/week/month/overall (`:282-321`).

**Problems:**

1. **Chars, not tokens.** A char count is a poor proxy across code/prose/Unicode; no tokenizer is used. `README.md:32` talks about tokens, but stats are chars.
2. **`initial_size` is pre-purge.** Python computes it from all docs before `_purge_error_docs`/prune (`context_optimizer_cli.py:63,86`). So "saved" includes dropped error docs and pruned docs, not just LLMLingua.
3. **Stages are conflated.** Rerank selection, dedupe, char budget, and LLMLingua are all folded into one `saved` number. You cannot tell whether LLMLingua contributed 5% or 50%.
4. **Negative savings are clamped to 0** (`config.ts:238`). If compression expands the text (short docs, overhead), the table reports 0% instead of a regression.
5. **Per-turn TS savings are not recorded.** Dedupe/purge counts are logged (`plugin.ts:320-324`) but never added to stats. The biggest recurring savings may be invisible.
6. **No per-hook/per-stage/latency/cache fields.** Cannot answer "how much did `execute.after` save?" or "what was the model load time?".
7. **No cost model.** No input-token price, no API cost saved, no comparison to native compaction size.
8. **CSV append is not atomic.** Concurrent compactions can interleave rows; the header race can duplicate headers (`:251-252`). `readResults` does a naive `split(",")` (`:260`); fields are sanitized (`:224-227`), so this is usually safe, but it is fragile.
9. **Debug runs are excluded** from stats (`hook.ts:224-228`; README `:165`), which is correct for accounting but means debug/eval sessions do not contribute to the table.
10. **`recordOptimizationStats` is called even if the host later discards the result** (e.g., OpenCode compaction fails after the transform, Claude manual hand-off never consumed). The stat says "saved" even if the user never used it.

**Recommendation:** record one row per hook invocation with `hook`, `stage`, `chars_in/out`, `tokens_in/out`, `latency_ms`, `model`, `cache_hit`, `error_code`, and `session_id`. Use a tokenizer. Do not clamp negative. Keep the existing CSV/table for backward compatibility, add a JSONL detail log.

### 5.7 Fail-open, timeouts, concurrency

**Fail-open is implemented well at the adapter level:**

- OpenCode plugin startup catches and returns `{}` (`plugin.ts:343-346`); transform catches strategy errors (`:325-327`) and compaction errors (`:336-340`); `optimizeCompaction` leaves messages untouched on failure (`:163-178`).
- Claude `main().catch` logs and exits 0 (`hook.ts:327-332`); missing transcript returns (`:188-192`); manual only blocks on success (`:233-243`); auto always proceeds (`:245-257`).
- Bridge resolves structured errors instead of throwing (`bridge.ts:76-137`); Python emits structured errors (`context_optimizer_cli.py:7-21`).

**But fail-open can still hurt:**

- **Long block:** a 300 s timeout blocks the compaction/turn. The user may think the agent is hung. Host-level timeouts may kill the hook before the bridge's own fail-open runs.
- **Repeated cost:** a failure still pays spawn/import/model-load. There is no circuit breaker ("after 2 failures, skip for 10 minutes/session"). `warnOnce` suppresses duplicate logs per session+message (`bridge.ts:42-49`) but does not stop the work.
- **SIGTERM only:** a CUDA hang may ignore SIGTERM; the child lingers. There is no SIGKILL follow-up or process-group kill.
- **No cancellation:** user interrupt/ESC does not abort the bridge; the promise keeps running.
- **Concurrency:** no global lock; N sessions -> N model loads. On GPU this is the most likely OOM path. On CPU it multiplies latency.
- **stdout fragility:** a library warning on stdout turns success into `runtime_error`; stderr is only surfaced on parse failure. There is no structured log channel.
- **Partial failure:** if the model loads but `optimize` throws (e.g., bad option key, OOM), the whole result is lost. There is no fallback to "pruned docs without LLMLingua" or "deduped docs only".
- **No health/readiness:** a worker-less design cannot tell whether Python is installed/working until the first user compaction. The installer checks `python --version` and pip, but not that the models load successfully beyond the warm-up subprocess (`install.ts:45-86`).

**Recommendation:** short per-turn timeout (e.g., 1–2 s) + longer compaction timeout; circuit breaker per session; SIGTERM -> SIGKILL after grace; AbortSignal; worker health check at plugin load; staged fallback; never block a normal turn on ML.

### 5.8 Tests: what is covered and what is not

**Covered (mock/unit level):**

- Payload flattening, error docs retained for Python, size formatting, result normalization (`tests/core.test.mjs:13-49`).
- Config defaults/round-trip/tuning/validation, stats CSV/table (`:51-136`).
- Bridge fail-open when the script path is missing (`:138-145`).
- Plugin loader shape, OpenCode compaction splice, commands, skip/fail-open (`:147-241`).
- TS dedupe newest-wins, key-order equivalence, protected tools, error purge age, idempotence (`tests/opencode-strategies.test.mjs:25-86`).
- Claude SessionStart hand-off/expiry, transcript dedupe/purge/protected/orphan, manual block, debug bundle/report/latest, auto outcome, failure reporting (`tests/claude-hook.test.mjs:19-284`).
- Python pipeline with fake models: init log, compressor device default/override, rank/compress, exact dedupe, empty, error purge, protected, tuple normalization, budget, oversized doc (`tests/test_context_optimizer_core.py:90-210`).
- Python CLI validation/errors/happy path (`tests/test_context_optimizer_cli.py:60-219`).

**Not covered (important gaps):**

- **No real model tests.** `test_context_optimizer_core.py:23-86` injects fake `sentence_transformers` and `llmlingua`; `test_context_optimizer_cli.py:35-56` stubs `ContextOptimizer`; JS tests fake `runOptimizer` (`core.test.mjs:168-173`) or use fake bridge scripts (`claude-hook.test.mjs:153-162`). No test loads actual weights, runs PyTorch, or checks LLMLingua output.
- **No quality tests.** No assertion that file paths, function names, error messages, or code fences survive compression; no comparison to native compaction; no golden fixtures.
- **No performance/memory tests.** No cold/warm latency, model load time, RSS/VRAM, throughput, or concurrency benchmark.
- **No timeout/cancellation tests.** `timeout` and `python_missing` are untested; the "missing bridge" test actually spawns Python against a nonexistent `.py`, which yields `runtime_error`, not `python_missing` (`core.test.mjs:138-145`).
- **No protocol fuzz/edge cases.** Empty stdout, stdout noise, non-zero exit with valid JSON, huge payload, invalid UTF-8, `docs` with Unicode/newlines, `options` with unknown keys, `min_input_size` non-int.
- **No `model_limits`/`auto_compression_chars` integration test.** Only `optimizerOptionsFromConfig` forwarding is tested (`core.test.mjs:58-99`); `buildPayload`'s gating is not.
- **No env precedence tests.** Env vs stored vs default is untested.
- **No OpenCode TTL/concurrency tests.** 10 s expiry, interleaved compactions, normal-turn mis-fire, empty sessionID.
- **No persistence tests.** Whether in-place mutations survive host serialization is not verified; tests only inspect the in-memory objects.
- **No Claude edge cases.** `MAX_TRANSCRIPT_ENTRIES=200` cap, newest-error-both-dropped interaction, `/clear` hand-off leak within 1 h, concurrent debug pair mispairing.
- **No e2e host tests.** No real OpenCode/Claude Code process, no actual hook dispatch, no browser/TUI.
- **No install/detect tests.** `install.ts`/`detect.ts` are untested.
- **No Windows tests.** The CLI explicitly handles Windows UTF-8 (`context_optimizer_cli.py:35-40`), but nothing exercises it.
- **No mutation testing / property tests** for `sortKeys`/`toolSignature`.

### 5.9 Operational, security and distribution risks

- **Sensitive content in debug files.** `~/.context-optimizer/debug/<session>/<stamp>/plugin.txt` and `native.txt` contain full optimized/native context (code, paths, possibly secrets). They are plaintext, with default filesystem permissions, and never cleaned up (`debug.ts:91-156`). `claude-sessions/*.md` and `*.outcome.txt` are also plaintext and may persist if not consumed (`hook.ts:162-178`).
- **Logs.** `writeLog` records doc counts/sizes and outcome messages, not full content (`plugin.ts:149-151,162`; `log.ts:15-23`), but error messages may include stderr/tracebacks with paths.
- **Model downloads.** `pip install sentence-transformers llmlingua` is unpinned (`install.ts:57-63`); a future LLMLingua/SentenceTransformers release can change behavior or break the API. The installer does not create a venv; it installs into whatever `python3` resolves to.
- **Disk usage.** README says ~3–5 GB for models (`README.md:63`); no cleanup/uninstall command. `context-optimizer install` only adds; there is no `uninstall`.
- **Network:** first run downloads models from Hugging Face; no offline/air-gapped mode or `HF_HUB_OFFLINE` handling.
- **Windows:** `py -3` default, UTF-8 stdin workaround (`context_optimizer_cli.py:35-40`), `where` for detection (`detect.ts:8-10`); untested.
- **Concurrent installs/config writes:** no locking; `settings.json`/`config.json` direct writes (`install.ts:120-145`; `config.ts:82-86`).
- **Hook registration collisions:** `upsertHook` removes any hook whose command contains `"context-optimizer"` (`install.ts:105-110`), which could remove an unrelated command containing that substring.
- **No telemetry/metrics:** no way to see latency/error rates without reading logs.
- **No uninstall/rollback:** removing the package leaves hooks/plugins/config/model cache behind; users must edit `settings.json` and `~/.config/opencode/plugins` manually.

---

## 6. Reusable code/design pieces

Legend: **Reuse** = directly usable or lightly adapted; **Refactor** = keep the idea, change the interface/behavior; **Replace** = do not carry into V2 as-is.

| Piece | Location | Verdict | Notes for V2 |
|---|---|---|---|
| Defaults + env/stored/default resolver | `packages/core/src/config.ts:7-18,97-156` | **Reuse** | Keep precedence and key names; add new keys; make writes atomic; validate env values. |
| Config value validation | `config.ts:183-210` | **Refactor** | Per-key schema; allow `compression_rate=0`/`dedupe_threshold=0` if intended; reject unknown `model_limits` keys early. |
| Stats CSV/table | `config.ts:212-321` | **Refactor** | Keep the table for compatibility; add JSONL with tokens/stages/hook/latency/cache; stop clamping negative savings. |
| Paths | `packages/core/src/paths.ts:6-46` | **Reuse** | Add `cacheDir`, `workerLog`, `rawPartsDir`; keep `CONTEXT_OPTIMIZER_HOME` override. |
| Logging | `packages/core/src/log.ts:7-23` | **Reuse** | Add structured/leveled logging and rotation; keep stderr fallback. |
| Payload builder | `packages/core/src/payload.ts:24-55` | **Refactor** | Add `mode`, `content_kind`, `deadline_ms`, `token_budget`, `preserve_order`, `request_id`; apply `model_limits` consistently for all adapters (or remove it). |
| Context summary/outcome formatting | `payload.ts:57-108` | **Reuse** | Keep user-facing wording; extend with stage/token/cache details. |
| Python result normalization | `packages/core/src/bridge.ts:17-37` | **Reuse/Refactor** | Keep camelCase mapping; add `request_id`, `stages`, `tokens`, `retryable`; validate types. |
| One-shot bridge | `bridge.ts:59-138` | **Refactor** | Extract a `Transport` interface: `runOnce()` for CLI/fallback + `WorkerClient` for hooks. Add AbortSignal, SIGKILL, exit-code check, max payload, structured stderr. |
| `warnOnce` | `bridge.ts:42-49` | **Reuse** | Bound the Set (LRU/TTL); add circuit-breaker state. |
| Strategy markers + 4-turn purge + protected tools + signature | `packages/core/src/strategies.ts:8-52` | **Reuse/Refactor** | Keep signature logic; make markers versioned/configurable; make protected list configurable and include `mcp__*` policy; add path normalization. |
| OpenCode per-turn strategies | `packages/opencode/src/strategies.ts:28-108` | **Refactor** | Keep algorithms; convert to pure planner returning replacements, not in-place mutation; add size thresholds and stats. |
| `messagesToDocs` serializer | `packages/opencode/src/plugin.ts:77-95` | **Refactor** | Split into a shared serializer; add per-part docs, truncation, kind/turn/hash metadata; apply protection before Python; cap total size. |
| Compaction flag + splice | `plugin.ts:121-179,314-340` | **Replace** | V2 `ctx.session.hook("compaction")` + `event.result` removes the TTL flag and in-place splice. Keep `optimizeCompaction`'s skip/stat/fail-open logic as a service. |
| OpenCode commands | `plugin.ts:181-312` | **Reuse/Refactor** | Keep command names; move handlers to V2 command API; don't return raw JSON blobs to the model unless asked. |
| Claude transcript parser | `packages/claude-code/src/hook.ts:93-160` | **Reuse/Refactor** | Keep as a Claude-specific adapter; share dedupe/purge primitives; fix newest-error-both-dropped; add truncation markers; stream/lazy-read large transcripts. |
| Claude hand-off lifecycle | `hook.ts:162-298` | **Reuse** | Keep file hand-off/expiry/consume pattern if V2 Claude still lacks a context hook; add a pending marker to prevent unrelated `/clear` leaks. |
| Python `ContextOptimizer` | `python/context_optimizer.py:19-185` | **Reuse/Refactor** | Keep pipeline; split stages into functions; add `preserve_order`, token budgets, code-aware `force_tokens`, optional stages, cache hooks; make constructor reusable across requests. |
| Python CLI protocol | `python/context_optimizer_cli.py:7-101` | **Reuse/Refactor** | Keep JSON shape for one-shot; add worker mode with JSON-lines, request ids, health, cancellation; keep stdout pure JSON. |
| Debug bundle | `packages/core/src/debug.ts:23-254` | **Reuse** | Excellent for eval; add stage snapshots, token counts, latency, raw parts, and a manifest. Keep `index.md`/`meta.json`/`plugin.txt`/`native.txt`. |
| LLM-judge rubric | `packages/claude-code/commands/context-optimizer/evaluate.md:6-38` | **Reuse** | Use the five criteria (task continuity, key facts, fidelity, noise, size) as the V2 quality harness prompt; automate pair selection via `debug latest`. |
| Installer/detect | `packages/core/src/install.ts:57-185`, `detect.ts:7-23` | **Reuse/Refactor** | Keep detection/upsert; add worker script copy, pinned deps/venv option, uninstall, and model/version checks. |
| Fake bridge test pattern | `tests/claude-hook.test.mjs:153-170` | **Reuse** | Ideal for protocol/worker tests: a tiny Python script that reads stdin and prints a fixed JSON result. Extend to JSON-lines worker. |
| Test temp-home pattern | `tests/core.test.mjs:8`; `tests/opencode-strategies.test.mjs:7` | **Reuse** | `CONTEXT_OPTIMIZER_HOME` to a temp dir keeps tests isolated; use for all V2 tests. |

### 6.1 Pieces that are especially worth preserving

1. **The Python pipeline itself** (`context_optimizer.py:78-185`). Rerank -> dedupe -> budget -> LLMLingua is a reasonable retrieval/compression skeleton. The problems are the fixed budget/order/quality policy, not the basic stages.
2. **The strategy primitives** (`core/strategies.ts:8-52`). Stable tool signatures and explicit markers are a good foundation for idempotent, auditable pruning.
3. **The debug bundle + evaluate rubric** (`debug.ts:23-254`, `commands/context-optimizer/evaluate.md:6-38`). This is the repo's best quality tooling and directly reusable for V2 A/B tests against native compaction.
4. **The one-shot protocol shape** (`context_optimizer_cli.py:7-101`, `bridge.ts:17-37`). A simple, language-agnostic request/response is easy to test and keep as a fallback; V2 can layer a worker protocol on top.
5. **Config precedence** (`config.ts:97-156`). Env > stored > default is the right model for a plugin; keep it and add per-hook overrides.

### 6.2 Pieces to drop or avoid

- The two-hook compaction flag + `messages.splice` (`plugin.ts:121-179,314-340`). Replace with an event-scoped hook result.
- In-place mutation of tool parts (`opencode/strategies.ts:62,83`). Replace with immutable replacement plans + raw sidecar.
- `model_limits` only in OpenCode `buildPayload` (`payload.ts:38-46`). Either apply consistently or remove; current behavior is surprising.
- Char-only stats (`config.ts:212-253`). Replace/extend with token and stage accounting.
- Spawn-per-call in hook paths (`bridge.ts:59-138`). Keep only for CLI/fallback.

---

## 7. V2 hook redesign

The target V2 surface named by the caller:

- `chat.messages.transform` -> `ctx.session.hook("context")`
- `session.compacting` -> `ctx.session.hook("compaction")` with `event.result`
- tool outputs -> `ctx.tool.hook("execute.after")`

The mapping below assumes those hooks can read the current messages/parts and write a result. Where the exact V2 semantics differ (especially `event.result`), the design should be adjusted rather than copied blindly.

### 7.1 Hook mapping at a glance

| V2 hook | Current equivalent | What moves | What must change |
|---|---|---|---|
| `ctx.session.hook("context")` | `experimental.chat.messages.transform` (`plugin.ts:317-341`) + `applyOptimizationStrategies` (`opencode/strategies.ts:96-108`) | TS dedupe/purge; optional per-span ML compression | Pure planner, immutable result, per-turn timeout, cache, content-kind policy, no persisted mutation. |
| `ctx.session.hook("compaction")` + `event.result` | `experimental.session.compacting` flag (`plugin.ts:314-316`) + transform splice (`:329-340`, `:164-171`) | `messagesToDocs`, `buildPayload`, `runOptimizer`, skip/stat/fail-open logic | Single event-scoped hook; set `event.result`; remove TTL flag/splice; query from task; preserve order; mode `input`/`augment`/`replace`. |
| `ctx.tool.hook("execute.after")` | No direct equivalent; closest is post-hoc dedupe (`opencode/strategies.ts:45-67`) and Claude 2,000-char truncation (`hook.ts:124`) | Per-output compression, dedupe, truncation, cache, stats | New: classify output, protect code/errors, cache raw/compressed, marker with hash, per-tool budget, transparent retrieval. |
| Worker/transport | `bridge.ts:59-138` | One-shot protocol/error normalization | Long-lived process, JSON-lines, health, restart, concurrency 1, cancellation, SIGKILL. |
| Config/stats | `config.ts` | Defaults/precedence/validation/CSV table | New keys; token/stage/hook/latency/cache fields; negative savings allowed. |
| Debug/eval | `debug.ts`, `commands/context-optimizer/evaluate.md` | Bundle layout + LLM-judge rubric | Add stage snapshots, token/latency data, V2 hook names. |

### 7.2 `ctx.session.hook("context")` — per-turn context

**Current behavior to replace:** `messages.transform` always runs `applyOptimizationStrategies`, which mutates parts in place (`plugin.ts:317-327`; `opencode/strategies.ts:96-108`). It never uses LLMLingua. The compaction splice is also done in this hook via a flag (`plugin.ts:329-340`).

**Target behavior:** one context hook that (a) always runs cheap, deterministic TS strategies and (b) optionally runs bounded ML compression on selected spans, without blocking the turn.

**Proposed algorithm:**

```
onContext(event):
  msgs = event.messages
  index = buildPartIndex(msgs)                  # partId, role, turn, kind, hash, protected, pinned
  plan = planDedupeAndPurge(index, config)      # pure, returns replacements (no mutation)
  if config.mode includes "turns":
      candidates = selectCandidates(index, plan, config)
      for c in candidates:
          if cache.has(c.hash): plan.replace(c, cache.get(c.hash)); continue
          if worker.ready and budget.remaining > 0:
              res = await worker.compress({
                  text: c.text,
                  kind: c.kind,
                  query: lastUserText(msgs),
                  max_output_chars: c.budget,
                  force_tokens: c.forceTokens,
                  deadline_ms: config.turn_timeout_ms,
              })
              if res.ok: cache.set(c.hash, res.text); plan.replace(c, marker(res))
  return plan.result                         # event.result / new messages
```

**Rules:**

1. **Never mutate persisted parts.** `planDedupeAndPurge` should take immutable snapshots and return a list of `{partId, replacement}`. Apply at the host boundary via `event.result` or a returned messages array. Keep raw text in a sidecar (`cache/raw/<hash>`) for audit/undo.
2. **Cheap path is always on.** Dedupe/purge should not depend on Python. If the worker is down/slow, return the TS-only plan.
3. **Per-turn ML is opt-in and bounded.** Compress only:
   - tool outputs above `tool_min_chars` (e.g., 4k);
   - older than `min_turns` (e.g., 2) or outside a "hot" recent window;
   - not protected, not pinned, not an error;
   - kind in `{logs, prose, json}`; skip `code`/`diff` by default.
4. **Budget, not whole-conversation.** Per-turn LLMLingua should compress the selected spans, not re-compress the entire session. This avoids the compaction budget trap and keeps latency predictable.
5. **Timeout:** e.g., 1–2 s per turn. On timeout, use the TS-only plan; do not block the model response.
6. **No reordering.** Only replace spans in place; preserve message/part order. The context hook should never sort messages.
7. **Idempotence:** markers must be versioned and include a hash/link to raw content. Skip parts already marked by the current version; re-mark if the marker version changes.
8. **Stats:** record per-turn dedupe/purge counts and ML compress chars/tokens/latency/cache hit.

**Why this is safe:** the hook can always return "no change" in <1 ms; ML failures are isolated to individual spans; no persisted history is destroyed.

### 7.3 `ctx.session.hook("compaction")` with `event.result`

**Current behavior to replace:** `experimental.session.compacting` sets a TTL flag (`plugin.ts:314-316`); the next `messages.transform` builds docs, calls Python, and splices the messages (`:329-340`, `:131-179`). This is fragile and mixes compaction with per-turn logic.

**Target behavior:** one event-scoped hook. Build docs from the compaction event, call the optimizer, and write the result through `event.result`.

**Proposed algorithm:**

```
onCompaction(event):
  docs = serializeForCompaction(event.messages)       # typed docs: role, turn, kind, protected, hash
  query = event.prompt || lastUserText(event.messages) || config.defaultQuery
  if totalChars(docs) < config.min_chars: return     # native compaction
  res = await worker.optimize({
      docs, query, mode:"compaction",
      token_budget: config.compaction_token_budget,
      preserve_order: true,
      protect_kinds: ["code","diff"],                 # select, don't compress
      deadline_ms: config.compaction_timeout_ms,
  })
  if !res.ok: return                                  # native compaction
  switch config.compaction_mode:
    case "input":   event.result = `## Optimized Context\n\n${res.text}`   # summarizer input
    case "augment": event.result = `${event.nativeSummary ?? ""}\n\n## Optimized Context\n\n${res.text}`
    case "replace": event.result = `## Optimized Context\n\n${res.text}`   # no LLM summary
  recordStats({hook:"compaction", trigger:event.trigger, stages:res.stages, ...})
```

**Semantics to verify in V2:**

- If `event.result` is the **final compacted context**, `replace` skips the host's LLM summary. That is the Claude-manual behavior and the highest quality risk. Default should be `input` or `augment`, not `replace`.
- If `event.result` is the **summarizer input**, `input` is the right mode; the host still summarizes, matching current OpenCode.
- If the host exposes a native summary and an injection channel, `augment` avoids throwing away the native summary (current Claude auto behavior).
- If `event.result` can only be set after the native summary, append `## Optimized Context` rather than replacing.

**Rules:**

1. **Use the real task query.** Prefer `event.prompt`, then the last user message, then a task summary. Do not use the constant `DEFAULT_QUERY` for automatic compaction.
2. **Preserve chronology.** Rank for selection, then restore original order (or emit chronological sections). This alone should improve quality substantially.
3. **Token budget, not 8k chars.** Use a model-aware token budget; keep `max_chunks` as a secondary cap.
4. **Protect code/diffs/protected tools.** Select them, but do not LLMLingua them by default. If they must be compressed, use `force_tokens` and validate key symbols.
5. **Do not double-compress.** Mark the result as already compressed; on the next compaction, skip/limit re-compression of the synthetic summary. Cache by content hash.
6. **Fail open.** On any error/timeout, return without setting `event.result`; the host compacts natively.
7. **Record stats with trigger and stages.** Include `manual`/`auto`, doc count, tokens in/out, prune/compress split, latency, cache hits.
8. **No TTL flag, no splice.** The event object is the correlation boundary.

**Migration note:** `optimizeCompaction` (`plugin.ts:131-179`) can become a pure service `optimizeCompaction(messages, {query, model, trigger}) -> OptimizerResult`; the hook wrapper handles `event.result`. Delete `compactingSessions` (`:128-129`), the flag checks (`:329-334`), and the `messages.splice` (`:167-170`).

### 7.4 `ctx.tool.hook("execute.after")` — incremental tool-output compression

This is the biggest opportunity for "use LLMLingua more often" because it is **incremental by construction**: one tool output at a time, no whole-session re-serialization, cacheable by content hash, and naturally bounded.

**Current gap:** OpenCode only dedupes/purges tool parts at the next `messages.transform` (`opencode/strategies.ts:45-91`); Claude only truncates tool results at PreCompact (`hook.ts:124`). Neither compresses a tool output when it is produced.

**Proposed algorithm:**

```
onToolExecuteAfter(event):
  if event.error: return                       # never alter errors
  if isProtected(event.tool): return
  out = event.output
  if typeof out !== "string" or out.length < config.tool_min_chars: return
  kind = classify(out)                         # code | diff | logs | prose | json | unknown
  if kind in config.skip_kinds: return
  key = hash(event.tool, event.input, out, config.model, config.rate)
  cached = cache.get(key)
  if cached: event.output = cached; record(cache_hit); return
  if kind in {"code","diff"}:
      event.output = headTail(out, config.code_head, config.code_tail)  # lossless, marked
      cache.set(key, event.output); return
  res = await worker.compress({
      text: out, kind, query: event.tool + " " + summarizeInput(event.input),
      max_output_chars: config.tool_max_chars,
      force_tokens: extractIdentifiers(out),
      deadline_ms: config.tool_timeout_ms,
  })
  if res.ok:
      event.output = `[compressed ${out.length}->${res.text.length} chars; raw:${key}]\n${res.text}`
      cache.set(key, event.output)
      record({hook:"tool", tool:event.tool, kind, chars_in:out.length, chars_out:...})
```

**Rules:**

1. **Never compress errors.** Preserve `event.error`/error output exactly; errors are high-value and often short.
2. **Protected tools skip.** Include `write`, `edit`, `patch`, `task`, `todowrite`, `plan_*`, `question`, plus configurable MCP patterns. `read` can be compressed only if the output is prose/logs, not code.
3. **Classify first.** Code/diffs get lossless head/tail or no change. Logs/prose get LLMLingua. JSON gets schema-aware handling or skip (token drop can invalidate JSON).
4. **Preserve identifiers.** Build a `force_tokens` set from file paths, function/class names, error codes, URLs, commands, and numbers. LLMLingua supports forcing tokens; use it.
5. **Per-output budget.** Cap both input and output chars; keep first/last lines for logs; keep stack traces/error lines.
6. **Raw sidecar.** Store the original output under `cache/raw/<hash>`; the marker includes the hash. This makes compression auditable and reversible by the host/tooling.
7. **Cache key includes model/rate/version.** Invalidate on model/rate change. TTL/size limit (LRU) to bound disk.
8. **Dedupe at source.** Maintain a session map `signature -> latest callId/output hash`; when a duplicate completes, replace the older output with a marker (or leave it for the context hook). Do this carefully: side-effecting tools should not have their outputs treated as interchangeable if the environment changed.
9. **Stats per call.** Record tool name, kind, chars/tokens in/out, latency, cache hit, skipped reason.
10. **Do not block the tool result.** If the worker is slow, return the raw output and compress asynchronously for the next turn (or skip). The tool call should not wait seconds for compression.

**Why this helps:** repeated file reads, test logs, grep results, and command outputs are the bulk of long sessions. Compressing them at production time avoids re-reading/re-compressing the whole transcript at compaction, and the cache makes repeated identical outputs free. It also lets the context hook stay cheap.

### 7.5 Worker/transport/protocol redesign

**Problem:** `runOptimizer` spawns a process per call and reloads three models (`bridge.ts:59-138`; `context_optimizer.py:45-51`). This is incompatible with per-turn/`execute.after` usage.

**Target:** a long-lived Python worker (or two) owned by the plugin process, with the one-shot bridge retained for the CLI/fallback.

#### 7.5.1 Process model

- **Start:** at plugin init, spawn `python3 -u context_optimizer_worker.py` with `stdio: ["pipe","pipe","pipe"]`. Do not block plugin startup; start warm-up in the background.
- **Handshake:** worker prints one JSON line `{"ready":true,"protocol":1,"device":"cuda","models":{...}}` after loading (or `{"ready":false,"error":...}`). Parent gates ML calls on `ready`.
- **Requests:** newline-delimited JSON, one object per line:
  ```json
  {"id":"uuid","mode":"compress","payload":{...},"deadline_ms":1500}
  ```
- **Responses:** newline-delimited JSON keyed by `id`:
  ```json
  {"id":"uuid","ok":true,"text":"...","stages":{...},"tokens":{...},"latency_ms":123}
  ```
- **stderr:** structured logs only; never stdout. Parent drains stderr to a log file/ring buffer.
- **Health:** periodic ping (`{"id":"...","mode":"health"}`) with a short timeout; mark unhealthy after N failures.
- **Idle shutdown:** after `worker_idle_ms` (e.g., 10 min) with no requests, terminate gracefully; respawn on demand.
- **Crash/restart:** on exit, reject in-flight requests with `worker_crashed`; restart with exponential backoff (e.g., 1s, 5s, 30s, max 3 attempts); then disable ML for the session and fall back to TS-only.
- **Concurrency:** one request at a time per worker (GPU memory/serialization). Queue with a bounded size; drop/merge low-priority per-turn requests when busy; compaction requests take priority over per-turn tool compression.
- **Timeouts:** per-request `deadline_ms` enforced by the parent; send a cancel message if the worker supports it; after a grace period, SIGTERM then SIGKILL.
- **Model reuse:** construct `ContextOptimizer` once in the worker; call `optimize`/`compress` repeatedly. The current class is stateless per call, so reuse is safe.
- **Optional split workers:**
  - `rank` worker: embedder + reranker for compaction;
  - `compress` worker: LLMLingua only for tool outputs/per-turn.
  This avoids loading reranker/embedder for every tool-output compression and reduces peak memory. If only one worker is feasible, lazy-load the compressor and keep the embedder/reranker for compaction.

#### 7.5.2 Worker request modes

| Mode | Input | Output | Used by |
|---|---|---|---|
| `optimize` | `docs`, `query`, `options`, `token_budget`, `preserve_order` | `text`, `stages`, `tokens`, `initial_size`, `final_size` | compaction |
| `compress` | `text`, `kind`, `query`, `max_output_chars`, `force_tokens` | `text`, `tokens`, `latency_ms` | per-turn/tool |
| `health` | none | `ok`, `device`, `models`, `queue_depth` | plugin init/periodic |
| `warmup` | optional model overrides | `ready` | plugin init |

#### 7.5.3 Protocol hardening

- Add `protocol_version`, `request_id`, `mode`, `deadline_ms`, `max_payload_bytes`, `content_kind`, `force_tokens`, `preserve_order`, `token_budget`.
- Response: `ok`, `request_id`, `text`, `stages`, `tokens`, `latency_ms`, `error_code`, `message`, `retryable`.
- Error codes: `invalid_input`, `dependency_missing`, `model_load_failed`, `oom`, `timeout`, `cancelled`, `worker_crashed`, `protocol_error`, `runtime_error`.
- Validate payload size before writing; reject with a structured error.
- Keep stdout pure JSON; send all logs/progress to stderr.
- Check exit codes; treat nonzero without a valid response as `worker_crashed`.
- Never `JSON.parse` a partial line; buffer until newline.

#### 7.5.4 Keep the one-shot path

- `context-optimizer optimize` and `install` warm-up can keep using the one-shot `context_optimizer_cli.py` protocol.
- The one-shot path is also the fallback if the worker cannot start (e.g., old Python, no `-u` support, sandbox restrictions).
- Share the payload/result schema between one-shot and worker to avoid drift; the worker can be a thin loop around the same `ContextOptimizer` methods.

### 7.6 Config V2 additions

Keep the existing keys/defaults for compatibility; add:

| Key | Suggested default | Purpose |
|---|---:|---|
| `enabled` | `true` | Master switch. |
| `mode` | `"compaction"` | `off` / `tools` / `turns` / `compaction` / `all`. Controls where ML runs. |
| `worker_idle_ms` | `600000` | Idle shutdown. |
| `worker_max_queue` | `8` | Bounded queue; drop/merge per-turn requests when full. |
| `turn_timeout_ms` | `1500` | Per-turn ML deadline; fall back to TS-only. |
| `tool_timeout_ms` | `1500` | Per-tool compression deadline. |
| `compaction_timeout_ms` | `120000` | Compaction deadline (longer than per-turn). |
| `tool_min_chars` | `4000` | Only compress tool outputs above this size. |
| `tool_max_chars` | `20000` | Max input chars per tool output. |
| `tool_output_max_chars` | `8000` | Max compressed output chars per tool. |
| `compress_kinds` | `["logs","prose"]` | Content kinds eligible for LLMLingua. |
| `protect_kinds` | `["code","diff","json","error"]` | Kinds never token-compressed. |
| `protect_tools` | existing + `mcp__*` policy | Extend `PROTECTED_TOOLS`. |
| `compaction_mode` | `"input"` or `"augment"` | `input` / `augment` / `replace`; default away from `replace`. |
| `compaction_token_budget` | model-aware | Token budget for compaction selection. |
| `preserve_order` | `true` | Restore chronological order after ranking. |
| `force_tokens` | `[]` / auto | Identifiers/paths to force during LLMLingua. |
| `cache_dir` | `~/.context-optimizer/cache` | Compressed/raw cache. |
| `cache_max_mb` | `512` | LRU size cap. |
| `cache_ttl_ms` | `604800000` (7 days) | Cache TTL. |
| `circuit_failures` | `3` | Failures before disabling ML for a session. |
| `circuit_cooldown_ms` | `600000` | Cooldown before retry. |

Validation should be per-key, allow valid zeros where documented, reject unknown `model_limits` keys, and validate env values the same way as stored values.

### 7.7 Stats/observability V2

Record one event per hook/stage, not one aggregate row per compaction:

```json
{
  "ts": "2026-10-22T...",
  "session_id": "...",
  "hook": "context|compaction|tool",
  "tool": "read",
  "trigger": "auto|manual|turn",
  "stage": "dedupe|purge|rank|compress|truncate|cache",
  "chars_in": 12345,
  "chars_out": 4567,
  "tokens_in": 3000,
  "tokens_out": 900,
  "latency_ms": 120,
  "model": "microsoft/llmlingua-2-...",
  "cache_hit": false,
  "error_code": null
}
```

- Use a tokenizer for `tokens_*`; fall back to chars if unavailable.
- Do not clamp negative savings; report expansion.
- Keep the existing CSV/table as a compatibility view; add JSONL detail and a `stats --json`/`stats --by-hook` CLI.
- Track cache hit rate, worker restarts, queue depth, model load time, and failure rate.
- Log skipped reasons (below threshold, protected, code kind, worker unavailable) so users can see why compression didn't run.

### 7.8 Test/eval plan for V2

**Unit (no models):**

- Pure planner: dedupe/purge, protected tools, `mcp__*`, null/key-order signatures, idempotence, marker versioning.
- Serializer: role/turn/kind/hash, truncation markers, code/diff classification, Unicode, non-string outputs.
- Config: env > stored > default, per-key validation, `model_limits` scope, atomic writes.
- Cache: key includes model/rate/version, TTL/LRU, raw sidecar.
- Protocol: request/response schema, malformed lines, unknown fields, error codes.

**Integration (fake worker, no models):**

- One-shot bridge and JSON-lines worker; handshake, health, timeout, cancel, crash/restart, queue overflow.
- `ctx.session.hook("context")` returns immutable replacements and leaves input untouched.
- `ctx.session.hook("compaction")` sets `event.result` in each mode; no result on failure.
- `ctx.tool.hook("execute.after")` compresses/skips/caches; errors preserved; protected tools untouched.
- Concurrency: two sessions, worker queue, no OOM (fake sleep).

**Real-model smoke (gated by `CONTEXT_OPTIMIZER_REAL_MODELS=1`):**

- Load the CPU compressor only (smallest model) and compress a fixture.
- Assert non-empty output, ratio within an expected range, and key identifiers/paths preserved.
- Assert cold vs warm latency (worker reuse) improves.
- Skip by default in CI; document how to run locally.

**Quality harness (reuse existing debug/eval):**

- Run both native compaction and plugin compaction on the same transcript (debug mode), store `native.txt`/`plugin.txt`/`meta.json`.
- Use the existing `evaluate.md` rubric (task continuity, key facts, fidelity, noise, size) as the LLM judge prompt (`commands/context-optimizer/evaluate.md:10-38`).
- Add deterministic checks: all file paths/identifiers from a whitelist survive; no code fence is unbalanced; error messages are present; chronology markers are in order.
- Aggregate verdicts by session type (short/long, code/prose, manual/auto) and by config (rate/budget/order).
- Store results under `~/.context-optimizer/debug/<session>/<stamp>/evaluation.md`; add a `eval` CLI to summarize.

**Performance:**

- Benchmark cold start (spawn + load), warm start (worker ready), per-turn compress, compaction, memory (RSS/VRAM), and concurrency 1/2.
- Compare one-shot vs worker; embedder/reranker disabled vs enabled; CPU vs CUDA.
- Publish numbers in the README instead of relying on "CPU is slower".

**E2E:**

- OpenCode: real plugin load, real `messages.transform`/`compaction` dispatch, real session DB; assert history is not corrupted.
- Claude: real hooks with a temp transcript; assert manual block/`/clear` hand-off, auto injection, debug bundle.
- Install/uninstall on macOS/Linux/Windows.

### 7.9 Phased implementation plan

**P0 — correctness/safety (no new ML):**

1. Replace in-place mutation with an immutable replacement plan; add raw sidecars.
2. Fix the compaction hook to be event-scoped (`event.result`); delete the 10 s flag and splice.
3. Move protected-tool checks into doc building so Python never compresses protected content.
4. Fix dedupe/error semantics consistency (OpenCode vs Claude); fix Claude newest-error-both-dropped.
5. Add token/stage/hook fields to stats; stop clamping negative savings.
6. Add timeout/cancellation/exit-code checks to the one-shot bridge; SIGTERM -> SIGKILL.
7. Add tests for timeout, `python_missing`, `model_limits`, env precedence, TTL/concurrency.

**P1 — worker + per-turn/tool compression:**

1. Implement the long-lived worker with handshake/health/restart/queue.
2. Add `ctx.tool.hook("execute.after")` with classification, protected tools, cache, raw sidecar, stats.
3. Add `ctx.session.hook("context")` with cheap TS always + optional bounded ML.
4. Add config keys and circuit breaker; warm up in the background.
5. Benchmark cold/warm latency and memory; set defaults from measurements.

**P2 — quality:**

1. Chronological restore/preserve order.
2. Real task query (last user message / compaction prompt).
3. Code/diff-aware policy + `force_tokens` + validation.
4. Token-aware budgets and staged fallbacks (prune-only, no rerank, no compress).
5. Quality harness with rubric + deterministic key-fact checks; A/B against native compaction.
6. Documentation: when to use `input` vs `augment` vs `replace`; quality warning; tuning guide.

---

## 8. The repo's own quality warning and the debug/eval tooling worth reusing

### 8.1 The warning

`README.md:12-15` is unusually candid for a project README:

> "After adding the slash commands for enabeling a debug mode plus an evaluation (debugon, debugoff and evaluate) which will compare the plugin's compaction with the native compaction, i found out that the plugins context result is considerably smaller but also often misses vital context. I am currently fine tuning the compact pipeline to get a better result, but it is still not as good as the native compaction. I will keep you updated on this."

This is the single most important product signal in the repo. It means:

- The pipeline's size win is real, but the quality win is not established.
- The author's own A/B testing found missing context, not just different wording.
- The default configuration (8k chars, 12 chunks, rate 0.6, generic query, relevance ordering) is the likely cause; see §4.7–4.8.
- Any V2 that makes LLMLingua run **more often** must not assume "more compression = better". It should default to preserving native compaction and add compression only where it is demonstrably safe (tool logs, repeated outputs, old noise), with an opt-in `replace` mode.

Other relevant README caveats:

- **Small sessions:** "When the conversation being compacted is small, the bookkeeping around compaction costs more than the compaction saves. Only manually run a `/compact` after you have send multiple messages and want a fresh context." (`README.md:34`)
- **Lossy, not paraphrasing:** "Quality-wise it's lossy compression, not paraphrasing — LLMLingua drops low-information tokens... if a compaction ever trims something you needed, raise `compression_rate` or `max_chunks`." (`README.md:142`)
- **Native vs plugin:** native `/compact` is a single LLM summary; the plugin replaces it for manual compaction with local rerank/dedupe/LLMLingua and no LLM call (`README.md:140-142`). The plugin is cheaper but not necessarily better.
- **Long sessions:** the plugin is aimed at long-running sessions; short sessions see little benefit (`README.md:30`).

### 8.2 Debug mode (Claude Code)

Debug mode is off by default; `CONTEXT_OPTIMIZER_DEBUG=1/true` overrides the stored flag (`debug.ts:47-51`; README `:159-161`). While on:

1. **PreCompact** runs the optimizer as usual but blocks/hands off nothing; native compaction proceeds (`hook.ts:224-228`).
2. **PostCompact** captures `compact_summary`, pairs it with the newest pending plugin result (within 1 h), writes `native.txt`, updates `meta.json`, appends a row to `index.md`, prints a report to stderr, exits 2 (`hook.ts:300-311`; `debug.ts:116-156,186-209`).
3. Debug runs are **not** counted in stats (`README.md:165`; `hook.ts:224-228`).

Folder layout (`README.md:180-187`; `debug.ts:23-28,91-114`):

```
~/.context-optimizer/debug/<session-id>/
├── index.md
└── <timestamp>/
    ├── plugin.txt      # optimizer result (if any)
    ├── native.txt      # Claude's compact summary
    ├── evaluation.md   # written by /context-optimizer:evaluate
    └── meta.json       # sizes, status, reason
```

`meta.json` fields (`debug.ts:34-44`): `sessionID`, `stamp`, `trigger`, `originalChars`, `pluginChars`, `pluginStatus`, `pluginReason`, `nativeChars`. `pluginStatus` can be `optimized`, `no_optimization`, `failed`, `skipped`, or `missing` (no PreCompact run). `pluginVsNative` returns a percentage (`debug.ts:161-164`); the report includes native chars, plugin chars, % of native, and original chars (`:166-184`).

`context-optimizer debug latest [session-id]` prints the newest compaction with a native summary as JSON, including `plugin` path or `null`, `native`, `evaluation`, sizes, trigger, stamp, sessionID (`cli.ts:119-129`; `debug.ts:223-254`). This is machine-readable and ideal for an external eval harness.

### 8.3 The evaluation rubric

`packages/claude-code/commands/context-optimizer/evaluate.md:6-38` defines a reusable LLM-judge rubric:

- **Task continuity:** goal, current state, next step clear?
- **Key facts:** file paths, identifiers, commands, decisions, errors/fixes, user preferences; list facts only one side kept.
- **Fidelity:** anything wrong/garbled/ambiguous/unsupported; plugin text is token-compressed (check readability/unambiguity); native text is an LLM paraphrase (check invented/over-generalized detail).
- **Noise:** irrelevant/stale/duplicated content.
- **Size:** chars and what the extra size buys.
- Verdict: `plugin | native | tie`, plus criteria table, "only in plugin", "only in native", "problems found", "recommendation" (tune `compression_rate`, `max_chunks`, `total_prune_budget_chars`).

It is run in a **new session** so the judge's context contains only the two files (`evaluate.md:6`). The command reads both files in full and writes `evaluation.md` to the same folder (`:8-38`).

**Reuse:** this is a good judge prompt for V2. Automate pair selection (`debug latest` JSON), feed both files, and aggregate verdicts. Add deterministic checks (key identifiers/paths/errors preserved; code fences balanced; chronology order) because an LLM judge can be inconsistent.

**Limitation:** there is no scoring script, no statistical aggregation, no inter-run comparison, and no OpenCode equivalent. Debug mode is Claude-only because it relies on `PreCompact`/`PostCompact` (`debug.ts:1-14`; `hook.ts:300-311`). V2 should add an OpenCode debug bundle/native comparison.

### 8.4 Other reusable tooling

- **Stats table** (`config.ts:212-321`): a compact markdown table with last/session/today/week/month/overall windows. Reuse the UX; extend the schema.
- **Outcome message** (`payload.ts:71-108`): consistent "initial/final/saved/%" wording; reuse for user-facing reports.
- **Fake bridge** (`tests/claude-hook.test.mjs:153-170`): a tiny Python script that reads stdin and prints fixed JSON; perfect for testing the worker protocol and timeout/crash paths.
- **Temp home** (`tests/core.test.mjs:8`; `tests/opencode-strategies.test.mjs:7`): `CONTEXT_OPTIMIZER_HOME` to a temp dir; use for all V2 integration tests.
- **`warnOnce`** (`bridge.ts:42-49`): suppress duplicate warnings per session/message; reuse with a bounded cache.
- **`formatDebugReport`** (`debug.ts:166-184`): a concise side-by-side report; reuse in the V2 debug bundle.
- **`recordPluginDebug` reasons** (`debug.ts:91-114`): stores why there was no result (skipped/failed/reason); reuse for observability.

### 8.5 What the debug tooling proves

The existence of debug mode and the evaluate rubric is evidence that the author knows quality is unproven. V2 should treat the debug bundle + rubric as the **acceptance test** for any "compress more often" change:

- Baseline: native compaction only.
- Candidate: plugin compaction (input/augment/replace) and/or per-turn/tool compression.
- Judge: rubric + deterministic key-fact checks.
- Gate: do not enable a mode by default unless it beats/matches native on task continuity and key facts without unacceptable noise/size.

---

## 9. Open questions / things to verify in V2

1. **`event.result` semantics.** Is it the final compacted context, the summarizer input, or an injection channel? Does setting it skip the host LLM summary? Can it be appended to a native summary? This determines whether the default is `input`, `augment`, or `replace`.
2. **Hook ordering.** Does `ctx.session.hook("compaction")` run before or after the host computes its summary? Is there a separate "after compaction" event for debug capture?
3. **Persistence.** Does `ctx.session.hook("context")` receive the persisted message objects or a serialization copy? Does returning replacements persist them? The current OpenCode code assumes the former (`plugin.ts:166`), which is risky.
4. **Tool hook output shape.** Is `event.output` a string, structured object, or stream? Can it be replaced without breaking the tool result/UI? Is there an error channel separate from output?
5. **Host timeouts.** What are the OpenCode/Claude hook timeouts? The bridge's 300 s default may exceed them. V2 needs per-hook deadlines below the host limit.
6. **Tokenizer.** Which tokenizer/model should budgets use? The host model's tokenizer is ideal but may not be available locally; a conservative estimate is better than chars.
7. **LLMLingua input limits.** What happens with docs longer than the checkpoint's max length? Does `compress_prompt` truncate, chunk, or error? The current code passes whole docs with only `rate` (`context_optimizer.py:161-164`) and has no test.
8. **Model memory.** Actual RSS/VRAM for the three defaults on CPU/CUDA; whether xlm-roberta-large + reranker-large + embedder fit alongside the host model. Measure before enabling per-turn.
9. **Code-aware compression.** Does LLMLingua-2 support `force_tokens` in the installed version? How to preserve identifiers/paths/operators reliably? Is a code-aware pre-tokenizer needed?
10. **Dedupe semantics.** Should identical tool calls with different cwd/env be considered duplicates? How to normalize paths/commands? Should MCP tools be protected by default?
11. **Error policy.** Keep error output + redact inputs (OpenCode) vs drop both (Claude) vs drop error docs (Python)? Pick one and test parity.
12. **Cache invalidation.** Key must include model name, rate, code version, prompt version, and content hash; decide TTL/size and whether raw content may be stored (privacy).
13. **Privacy.** Debug bundles/cache may contain secrets/code. Add permissions (0700), retention, redaction, and an opt-out.
14. **Cross-platform.** Windows `py -3`, UTF-8 stdin, path separators, long paths, and `where` detection are untested.
15. **Install/uninstall.** Pinned dependency versions, venv option, model cache cleanup, hook removal, and upgrade migration.

---

## 10. Appendix: key file:line index

### Core

- Defaults: `packages/core/src/config.ts:7-18`
- Env/stored/default resolution: `config.ts:97-156`
- Options forwarded to Python: `config.ts:162-174`
- Config validation: `config.ts:183-210`
- Stats CSV/table: `config.ts:212-321`
- Bridge spawn/timeout/normalize: `packages/core/src/bridge.ts:59-138`, `:17-37`, `:90-93`
- Payload build/model limits: `packages/core/src/payload.ts:24-55`
- Outcome formatting: `payload.ts:57-108`
- Markers/protected/signature: `packages/core/src/strategies.ts:8-52`
- Paths: `packages/core/src/paths.ts:6-46`
- Logging: `packages/core/src/log.ts:7-23`
- Debug bundle: `packages/core/src/debug.ts:23-254`
- Detect: `packages/core/src/detect.ts:7-23`
- Install: `packages/core/src/install.ts:57-185`
- CLI: `packages/core/src/cli.ts:52-193`

### OpenCode

- Plugin factory/hooks: `packages/opencode/src/plugin.ts:115-347`
- `messagesToDocs`: `plugin.ts:77-95`
- Compaction flag/optimize: `plugin.ts:121-179`, `:314-340`
- Commands: `plugin.ts:181-312`
- Per-turn strategies: `packages/opencode/src/strategies.ts:28-108`

### Claude Code

- Transcript parser: `packages/claude-code/src/hook.ts:93-160`
- PreCompact: `hook.ts:184-258`
- SessionStart: `hook.ts:269-298`
- PostCompact/debug: `hook.ts:300-311`
- Hand-off files/expiry: `hook.ts:162-182,261-285`
- Evaluate rubric: `packages/claude-code/commands/context-optimizer/evaluate.md:6-38`

### Python

- Constructor/model load: `python/context_optimizer.py:19-59`
- Normalize/purge: `python/context_optimizer.py:61-76`
- Dedupe: `python/context_optimizer.py:78-99`
- Prefilter: `python/context_optimizer.py:101-118`
- Pre-prune/budget: `python/context_optimizer.py:120-155`
- Compress: `python/context_optimizer.py:157-166`
- Optimize: `python/context_optimizer.py:168-185`
- CLI protocol: `python/context_optimizer_cli.py:7-101`

### Tests

- Core: `tests/core.test.mjs:13-241`
- OpenCode strategies: `tests/opencode-strategies.test.mjs:25-86`
- Claude hook: `tests/claude-hook.test.mjs:19-284`
- Python core (fake models): `tests/test_context_optimizer_core.py:23-210`
- Python CLI (stub optimizer): `tests/test_context_optimizer_cli.py:35-219`

### README

- Quality warning: `README.md:12-15`
- Per-platform flow: `README.md:98-142`
- Config table: `README.md:193-216`
- Models: `README.md:218-249`
- Debug/eval: `README.md:159-191`
- Troubleshooting: `README.md:276-285`

---

*End of analysis. No files in `/tmp/ctxopt-ref` were modified; only this research document was written.*
