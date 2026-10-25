# ADR 0001: Selective Prose Compression Over Whole-Transcript Pruning

## Status
Accepted; implementation extended on 2026-10-25 with the V2 adapter, context plugin, LRU cache, watermark gate, compaction lane, optional tool-output lane, literal preservation, `context_expand`, optional HTTP worker, and OpenCode Go quality harness.

## Context
Initial implementations of prompt compression (e.g., `evermeer/context-optimizer`) attempted to compress prompt contexts globally using LLMLingua. When applied blindly to agentic coding transcripts, this caused severe regressions:
1. Programming languages rely on exact structural tokens (braces, punctuation, indentation, identifiers). LLMLingua-2 BERT classifiers frequently drop closing braces and keywords, producing syntax errors (`TS1005` in TypeScript).
2. Diagnostic logs and stack traces collapse into unreadable single-line blocks, stripping timestamps and error locations.
3. Natural language statements with negation qualifiers ("do not delete X") lose important words, inverting agent intent.
4. Mutating early prompt blocks continuously breaks provider prompt caching (OpenAI/Anthropic KV prefix caching), increasing costs and latency.

## Decision
We restrict token-level SLM compression (LLMLingua) to **stale, natural-language prose only**:
- System messages, prompt instructions, and tool definitions are permanently protected to preserve upstream prompt-cache hits.
- Code, diffs, JSON schemas, and structured logs are strictly filtered out by a conservative heuristic classifier (`classifyText`).
- The V2 adapter treats tool-result `json` and `error` values as protected, and only writes compressed text back to approved `text`/tool-result spans.
- The most recent *N* user turns (default: 2) remain untouched to preserve current developer intent and immediate context. The policy permits 1 only as an explicit advanced override.
- The request lane is watermark-gated: it runs only when estimated usage crosses 70% of the model's usable context (configurable).
- Compressed chunks are memoized by a deterministic SHA-256 content key (`policy_version + model + rate + text`); the plugin stores successful outputs in an in-memory LRU.
- A hard token budget (default: 2,000 tokens) is allocated oldest-first.
- A post-check rejects output that drops file paths, URLs, numbers, line references, or error codes.
- Originals are retained in a bounded in-memory store and linked with `[ctx_expand:...]` markers when the retrieval tool is enabled.
- Compaction pre-compresses the summarizer transcript but does not replace the summarizer result. The tool-output lane is optional and default-off until persistence is verified.

## Consequences
### Positive
- Zero syntax corruption on source code or diff hunks.
- Upstream prompt caching remains stable across conversation turns.
- Transparent fail-open behavior: unknown, ambiguous, or protected content is never mutated. Backend timeouts and errors leave the original span intact.
- Deterministic and verifiable through unit testing without requiring live LLM calls.
- Tool-result IDs, names, JSON, errors, and non-text parts survive the adapter/replacement round trip.

### Negative
- Overall session token reduction from LLMLingua is limited to natural-language prose segments (10–25% of total transcript tokens in code-heavy sessions, per the research estimate).
- CLI outputs and JSON arrays must be handled by separate, dedicated deterministic engines (RTK and Headroom/SmartCrusher) rather than a single universal model.
- Literal preservation is a post-check, not force-token protection; technical prose with many exact tokens is often rejected rather than compressed.
- The watermark is a local approximation, not provider token usage.
- The tool-output lane's replacement persistence is unverified in V2; it remains default-off.
- Compaction is precompress-only and cannot prevent the threshold decision that triggered it.
- The quality harness is a small fact-retention smoke test, not a broad task-success evaluation.
