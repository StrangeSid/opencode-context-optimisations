# opencode-context-optimisations

Making OpenCode V2 use LLMLingua-style prompt compression continuously, not only at
compaction time.

**Read [FINDINGS.md](./FINDINGS.md) first.** It covers the reference implementation,
the OpenCode V2 hook surface, measured LLMLingua latency/quality, a selective
three-lane design, risks, and the implementation plan.

## Layout

```
FINDINGS.md          research + design + plan
research/            version-pinned notes and benchmarks
src/classify.ts      conservative content classifier (phase 1 core)
tests/               classifier tests
```

## Status

Research spike. The classifier is implemented and tested; the V2 plugin,
compressor worker, cache, and compaction lane are next (FINDINGS §7).

```bash
npm test
npm run typecheck
```

## Headline

LLMLingua-2 is fast enough for selective per-request use (~0.2 s/1k tokens on
M3 Pro CPU, ~0.7 s/8k on MPS) but destroys code and log structure. The design
therefore compresses **old prose only**, protects code/JSON/logs/errors/recent
turns, caches by content hash, and adds an expand tool for retrieval. Native
compaction stays enabled; the compaction hook only reduces the summarizer's input.
