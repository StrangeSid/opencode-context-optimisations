# API Reference

The package root exports pure, deterministic classification, policy, adapter, optimizer, watermark, literal, expand, tool-result, and compressor APIs. The OpenCode host integration lives behind the `./plugin` subpath so importing the core does not load the host runtime.

```typescript
import { classifyText, selectLlmlinguaCandidates } from "opencode-context-optimisations"
import plugin from "opencode-context-optimisations/plugin"
```

---

## Content Classification (`src/classify.ts`)

### `classifyText(text: string): Classification`

Heuristically determines whether a text span is safe for token-dropping compression. The classifier is deliberately conservative: ambiguity returns `"unknown"`, which is never compressible.

#### Parameters
- `text`: `string` — The text to classify.

#### Returns
- `Classification`:
  - `kind`: `"empty" | "json" | "diff" | "code" | "log" | "prose" | "unknown"`
  - `confidence`: `number` — Between `0.0` and `1.0`
  - `reasons`: `string[]` — Diagnostic descriptions of the matched heuristics

#### Example
```typescript
import { classifyText } from "opencode-context-optimisations"

const sample = `import { readFile } from "node:fs/promises"
import path from "node:path"

export async function loadConfig(dir: string): Promise<Config> {
  const file = path.join(dir, "config.json")
  const raw = await readFile(file, "utf8")
  return JSON.parse(raw)
}`

console.log(classifyText(sample))
// { kind: "code", confidence: 0.8, reasons: ["6 declaration lines", "3 indented lines"] }
```

### `isTokenCompressible(classification: Classification): boolean`

Returns `true` only for `kind === "prose"` with `confidence >= 0.7`. Code, diffs, JSON, logs, empty text, and unknown content always return `false`.

### `estimateTokens(text: string): number`

Fast, zero-dependency estimate for budgets and stats. It is not a provider tokenizer: Latin text uses `chars / 4`, CJK code points use `count / 1.5`, and the result is rounded up.

---

## Policy Engine (`src/policy.ts`)

### `selectLlmlinguaCandidates(messages, options?): SelectionResult`

Pure, deterministic selection. It does not call a model and does not mutate the transcript.

#### Selection rules
1. Every message at or after the protected boundary is rejected as `"recent"`.
2. System messages are rejected as `"system"`.
3. Old user prose is rejected as `"role"` unless `allowUserProse` is true.
4. Old tool messages are rejected as `"role"` when `includeToolProse` is false.
5. Text parts marked `protected: true` are rejected as `"content"` with detail `"protected"`.
6. Non-prose content is rejected as `"content"` with the classification kind as detail.
7. Spans below `minTokens` are rejected as `"small"`.
8. Eligible spans are sorted oldest-first and admitted until `budgetTokens` is exhausted; oversized candidates are skipped and later candidates may fit.

#### Options
| Option | Default | Meaning |
|---|---:|---|
| `protectedTurns` | `2` | Number of recent user turns kept verbatim. Minimum 1; 1 is an explicit advanced override. |
| `minTokens` | `400` | Minimum estimated tokens for a candidate. |
| `budgetTokens` | `2000` | Maximum total estimated tokens selected. |
| `allowUserProse` | `false` | Permit stale user prose. |
| `includeToolProse` | `true` | Permit stale tool prose. |
| `modelId` | `"llmlingua-2"` | Included in the cache key. |
| `rate` | `0.6` | Included in the cache key. |

Non-finite numeric options (`NaN`, `Infinity`) fall back to their defaults. This is a safety behavior: `NaN` would otherwise make every comparison false and disable a gate. A `rate` outside `(0, 1]` also falls back to `0.6`.

#### Returns
- `candidates`: `Candidate[]` — Oldest-first eligible spans.
- `rejected`: `RejectedPart[]` — Reason and optional detail for every rejected span.
- `protectedFromIndex`: `number` — First index of the protected tail.
- `selectedTokens`: `number` — Sum of candidate token estimates.

`Candidate` fields: `messageIndex`, `partIndex` (`null` for legacy string content), `role`, `text`, `tokens`, `ageTurns`, `classification`, `cacheKey`.

```typescript
import { selectLlmlinguaCandidates } from "opencode-context-optimisations"

const { candidates, rejected, selectedTokens } = selectLlmlinguaCandidates(messages, {
  protectedTurns: 2,
  minTokens: 400,
  budgetTokens: 2000,
})
```

---

## V2 Transcript Adapter (`src/v2.ts`)

OpenCode V2 messages use `content: ContentPart[]`, and tool output is a tagged value rather than a plain text part. The adapter flattens every eligible textual span and remembers exactly where it came from.

```typescript
export interface V2Message {
  role: string
  content?: string | readonly V2ContentPart[]
  id?: string
}

export interface V2ContentPart {
  type: string
  text?: string | null
  id?: string
  name?: string
  namespace?: string
  result?: { type: string; value?: unknown }
}
```

### Span mapping
| Source | Policy treatment | Write-back target |
|---|---|---|
| `{ type: "text", text }` | Classified normally | `part.text` |
| `tool-result.result.type === "text"` | Classified normally | `result.value` |
| `tool-result.result.type === "json"` | `protected: true` (never compressed) | unchanged |
| `tool-result.result.type === "error"` | `protected: true` (never compressed) | unchanged |
| `tool-result.result.type === "content"` text entries | Classified normally | `result.value[i].text` |
| `tool-call`, `reasoning`, `media`, `compaction`, `effort` | Ignored | untouched |

### `toPolicyTranscript(messages: readonly V2Message[]): V2Transcript`

Returns:
- `messages`: one synthetic `PolicyMessage` per input message (indexes are preserved),
- `spans`: `V2TextSpan[]` with the original source pointer and `protected` flag,
- `byPolicyPart`: `Map<string, V2TextSpan>` keyed by `policySpanKey(messageIndex, policyPartIndex)`.

### `applyV2Replacements(messages, replacements): number`

Applies compressed strings to the exact source spans and returns how many replacements succeeded. It preserves message IDs, tool IDs/names, file attachments, JSON/error results, and all non-text parts.

### `policySpanKey(messageIndex, policyPartIndex): string`

Returns the `"messageIndex:policyPartIndex"` key used by the adapter map.

---

## Optimizer (`src/optimizer.ts`)

### `optimizeTranscript(messages, options, deps): Promise<OptimizerStats>`

The lane orchestration:

1. Adapt the V2 transcript.
2. Select candidates with the policy.
3. Serve cache hits; batch misses through an injected backend.
4. Enforce a per-candidate timeout.
5. Reject output that drops protected literals.
6. Optionally annotate the result with a retrieval marker.
7. Enforce the expansion guard.
8. Apply successful replacements in place.

Backend errors, empty output, timeouts, and literal failures leave the original span untouched. The function never throws because of a backend failure.

#### Options (extends `SelectionOptions`)
| Option | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Set `false` to skip all work. |
| `timeoutMs` | `1200` | Per-candidate deadline. |
| `cacheMaxEntries` | `500` | LRU capacity when no cache is supplied. |
| `maxCompressedRatio` | `0.9` | Skip results at least this fraction of the input size. |
| `validateLiterals` | `true` | Require paths, URLs, numbers, line references, and error codes to survive. |
| `literalOptions` | defaults | Tune the literal classes and maximum count. |

#### Dependencies
```typescript
interface OptimizerDeps {
  backend: CompressionBackend
  cache?: TextCache
  inflight?: Map<string, Promise<string>>
  onCompressed?: (event: {
    original: string
    compressed: string
    span: V2TextSpan
  }) => string
  now?: () => number
}

interface CompressionBackend {
  compress(request: CompressionRequest): Promise<string>
}
```

`onCompressed` is used by the plugin to append `[ctx_expand:...]` markers while keeping the raw compressed text in the cache.

#### Returned stats
`enabled`, `candidates`, `compressed`, `applied`, `cacheHits`, `failures`, `skipped`, `literalRejects`, `rejected`, `selectedTokens`, `savedTokens`, `latencyMs`, `protectedFromIndex`.

### `createLruCache(maxEntries: number): TextCache`

Insertion-ordered LRU. A capacity of zero disables storage. Cache keys come from the policy and include policy version, model ID, rate, and original text.

---

## Watermark (`src/watermark.ts`)

### `estimateRequestTokens(input): number`

Estimates the outgoing payload from system parts, tool schemas, message text, tool-call inputs, and tool-result content. It is a cheap approximation, not a provider token count.

### `evaluateWatermark(usedTokens, contextLimit, options?): WatermarkDecision | undefined`

```typescript
interface WatermarkOptions {
  highRatio?: number              // default 0.7
  outputReserveTokens?: number    // default 15% of limit, clamped to 1-16k
}

interface WatermarkDecision {
  usedTokens: number
  contextLimit: number
  reserveTokens: number
  usableTokens: number
  ratio: number
  threshold: number
  shouldCompress: boolean
}
```

Returns `undefined` for an unusable model limit. The plugin then falls back to running compression without a watermark.

---

## Literal Preservation (`src/literals.ts`)

### `extractProtectedLiterals(text, options?): string[]`

Extracts deduplicated file paths, URLs, error codes, line references, and numbers. Options can disable any class and cap the result count.

### `findMissingLiterals(original, compressed, options?): string[]`

Returns the extracted literals that are absent from the compressed text. An empty array means the output passed the post-check. This is intentionally strict: a path that gains spaces around punctuation is considered lost.

---

## Expand Store (`src/expand.ts`)

### `createExpandStore(options?): ExpandStore`

Bounded LRU of original spans with deterministic `ctx_<sha256-prefix>` handles. Options: `maxEntries` (200), `maxChars` (1,000,000), `maxQueryLines` (40), `maxReturnChars` (20,000).

### `createExpandAnnotator(store): ReplacementAnnotator`

Returns an optimizer `onCompressed` callback that stores the original and appends:

```text
[ctx_expand:ctx_ab12cd34ef56]
```

The marker is deterministic for identical original text.

---

## Tool-Result Helpers (`src/tool-result.ts`)

### `findToolTextSlot(result): ToolTextSlot | undefined`

Chooses the longest textual payload from `result.content` (string or text entries) or a string `result.output`. The returned `apply()` replaces only that slot and preserves file attachments, metadata, and tool identity.

### `isProtectedTool(tool, protectedTools): boolean`

Exact-name or trailing-`*` prefix matching. The plugin's default protected list includes `write`, `edit`, `patch`, `task`, `todowrite`, `question`, `context_expand`, and `plan_*`.

---

## HTTP Compressor (`src/compressor.ts`)

### `createHttpCompressor(options): CompressionBackend`

```typescript
const backend = createHttpCompressor({
  endpoint: "http://127.0.0.1:8765/compress",
  timeoutMs: 1200,
})
```

The request body is:

```json
{
  "text": "...",
  "rate": 0.6,
  "model": "llmlingua-2",
  "kind": "text",
  "tool": "read"
}
```

`kind` is `"text"` or `"tool-result"`; `tool` is present only for tool results. The response must be JSON with a non-empty `text` field (`compressed` is accepted as an alias). Non-2xx responses, timeouts, and malformed bodies reject; the optimizer catches those and fails open.

---

## Plugin (`src/plugin.ts`)

### Default export

The default export is a `Plugin.define({ id: "opencode-llmlingua", setup })` definition. `setup` reads `ctx.options` and registers:

- `ctx.session.hook("context")` — watermark-gated request compression.
- `ctx.session.hook("compaction")` — precompress the summarizer transcript; never sets `event.result`.
- `ctx.tool.hook("execute.after")` — only when `toolOutputEnabled` is true.
- `ctx.tool.transform(...)` — adds `context_expand` when `expandToolEnabled` is true.

The plugin registers nothing when `enabled` is `false` or neither `endpoint` nor an injected backend is available.

### `createContextPlugin(runtime?)`

Builds a plugin definition with injected dependencies:

```typescript
interface PluginRuntime {
  backend?: CompressionBackend
  cache?: TextCache
  inflight?: Map<string, Promise<string>>
  expandStore?: ExpandStore
  logger?: (message: string) => void
}
```

### `resolvePluginConfig(raw)`

Maps `ctx.options` into a `ContextPluginConfig`. Unknown keys are ignored. A blank `endpoint` is treated as absent and is trimmed.

### Plugin options
| Option | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Master switch. |
| `endpoint` | `undefined` | Full sidecar URL. Without it the plugin is inert. |
| `debug` | `false` | Log one-line stats, watermark decisions, and failure details. |
| `protectedTurns` | `2` | Request-lane recency window. |
| `minTokens` | `400` | Request-lane minimum chunk. |
| `budgetTokens` | `2000` | Request-lane budget. |
| `allowUserProse` | `false` | Permit stale user prose. |
| `includeToolProse` | `true` | Permit tool-role prose. |
| `modelId` | `"llmlingua-2"` | Cache-key/backend model identifier. |
| `rate` | `0.6` | Default compression rate. |
| `timeoutMs` | `1200` | Request-lane deadline. |
| `cacheMaxEntries` | `500` | LRU capacity. |
| `maxCompressedRatio` | `0.9` | Expansion guard. |
| `validateLiterals` | `true` | Literal post-check. |
| `watermarkEnabled` | `true` | Gate the request lane. |
| `watermarkRatio` | `0.7` | Pressure threshold. |
| `outputReserveTokens` | 15% clamp | Response reserve. |
| `compactionEnabled` | `true` | Precompress compaction input. |
| `compactionProtectedTurns` | inherits | Compaction recency window. |
| `compactionMinTokens` | inherits | Compaction minimum chunk. |
| `compactionBudgetTokens` | `8000` | Compaction budget. |
| `compactionRate` | `0.7` | Compaction rate. |
| `compactionTimeoutMs` | `12000` | Compaction deadline. |
| `toolOutputEnabled` | `false` | Incremental tool-output lane. |
| `toolMinTokens` | `300` | Tool-output minimum. |
| `toolBudgetTokens` | `2000` | Tool-output budget. |
| `toolRate` | `0.6` | Tool-output rate. |
| `toolTimeoutMs` | `1200` | Tool-output deadline. |
| `protectedTools` | built-in list | Exact names or `prefix*`. |
| `expandToolEnabled` | `true` | Store originals, append markers, register the tool. |
| `expandStoreMaxEntries` | `200` | Original-store capacity. |
| `expandStoreMaxChars` | `1,000,000` | Original-store character budget. |

### `context_expand` tool

Input: `{ handle: string, query?: string }`. It returns the original span, or lines matching `query` with `L<n>:` prefixes. Unknown handles return a plain text message. The tool is local-only and never touches the network.

### What the hooks do not touch

`event.system`, `event.tools`, `event.options`, tool-call inputs, reasoning parts, media, compaction checkpoints, JSON tool results, error tool results, tool-call/result IDs, and the protected recent window.

---

## Known limitations

- The tool-output lane is default-off. V2 docs show result replacement, but persistence across history is unverified; test your OpenCode build before enabling it.
- Compaction is precompress-only. The plugin never sets `event.result` or replaces the summarizer.
- The watermark uses a heuristic token estimate, not provider usage. If `ctx.model.list()` cannot supply a limit, the plugin falls back to running compression without a gate.
- Literal validation is a post-check, not force-token protection. Technical prose with many numbers/paths will often be rejected rather than compressed.
- The root package does not bundle an LLMLingua model or Python runtime; the worker is optional and external.
- Token estimates are heuristic, not provider token counts.
- The worker binds to loopback and has no authentication.
- The plugin assumes the outgoing V2 `context` and `compaction` messages are mutable at the nested `content[].text` and `tool-result.result.value` level. The research note flags this as an open runtime question; if a build freezes those objects, switch the adapter to immutable message replacement.
- `context_expand` is in-memory and bounded; markers add a small token cost. On restart, old handles are gone.
- The quality harness is a fact-retention smoke test, not a SWE-bench-style task-success evaluation.
