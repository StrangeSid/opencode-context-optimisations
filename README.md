# opencode-context-optimisations

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-v2.1.3-blueviolet)](https://opencode.ai)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-20%20passed-success)](./tests)

Selective, cache-aware context compression and token optimization for OpenCode V2 coding agents.

> [!IMPORTANT]
> **LLMLingua token-dropping models destroy code syntax, flatten multi-line logs, and drop negative assertions.** This project implements a strict, content-classified pipeline that reserves SLM compression exclusively for stale natural-language prose while keeping code, JSON schemas, diffs, errors, and recent dialogue byte-identical.

---

## Overview

OpenCode builds prompt context dynamically on every turn. As agentic coding sessions scale beyond 50+ tool invocations, prompt overhead degrades latency, inflates token spend, and risks displacing critical context.

While naive approaches attempt to run LLMLingua across the entire conversation history, empirical benchmarking on Apple Silicon (M3 Pro) reveals:
- **Code corruption**: Syntax breaks immediately (`tsc` throws `TS1005` syntax errors due to stripped braces and control tokens).
- **Log degradation**: Structured multi-line compiler/test outputs collapse into unreadable single-line strings.
- **Cache thrashing**: Continuous mutations to early prompt segments destroy upstream provider KV-prefix caching (OpenAI/Anthropic prompt cache misses).

`opencode-context-optimisations` solves this with a **multi-tiered, selective compression architecture**.

---

## Architecture: The 3 Operational Layers

Understanding what can and can't reduce billed API tokens on hosted frontier models:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Pre-Request Client/Gateway Compression (Usable on APIs)       │
│ • Deterministic CLI output pruning (RTK)                               │
│ • Content-addressed cross-turn deduplication (Session-Dedup)           │
│ • Tabular JSON array compaction (Headroom / SmartCrusher)              │
│ • Reversible caching with retrieval markers (CCR)                      │
│ • Selective SLM token pruning on aged prose (LLMLingua Request Lane)   │
│ → REDUCES BILLED INPUT TOKENS ON OPENAI / ANTHROPIC / GEMINI APIS     │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ (HTTP / JSON)
┌────────────────────────────────────▼───────────────────────────────────┐
│ Layer 2: Soft Parameter / Latent Vectors (White-Box Models Only)       │
│ • ICAE (In-Context Autoencoder), AutoCompressor, Gist Tokens           │
│ → Requires access to model weights and custom attention masks.         │
│ → CANNOT BE USED WITH HOSTED BLACK-BOX APIS.                           │
└────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 3: Server-Side Inference Engine KV-Eviction (Decode Phase)       │
│ • StreamingLLM, H2O, SnapKV, PyramidKV                                 │
│ → Runs inside vLLM / llama.cpp / SGLang during token generation.       │
│ → ZERO REDUCTION IN BILLED INPUT TOKENS FOR API USERS.                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Key Features

- **Conservative Content Classifier (`src/classify.ts`)**: Fast, heuristic inspection of message content. Identifies code, unified diffs, JSON, structured logs, and technical path density. Refuses token compression on any non-prose content.
- **Aged Selection Policy (`src/policy.ts`)**: Pure deterministic policy engine. Guarantees:
  - System prompts and tool schemas are never mutated (preserves provider prefix caching).
  - The latest *N* user turns (default 2) remain byte-identical.
  - Only old assistant responses and tool prose are eligible for compression.
  - Generates deterministic SHA-256 cache keys to prevent repeated re-compression.
  - Enforces strict token budgets and chunk minimums.
- **Gateway Interoperability (OmniRoute 3.8+)**: Integrates with local gateway engines (RTK, Session-Dedup, Headroom) with verified fail-open policies and zero-risk defaults.

---

## Project Structure

```
opencode-context-optimisations/
├── LICENSE                   # GNU General Public License v3.0
├── FINDINGS.md               # Complete research spike, gateway audit & taxonomy matrix
├── package.json              # ES module configuration & test scripts
├── tsconfig.json             # TypeScript strict configuration
├── src/
│   ├── index.ts              # Package entry point
│   ├── classify.ts           # Content-kind heuristic classifier
│   └── policy.ts             # Selection policy & candidate selection engine
├── tests/
│   ├── classify.test.ts      # Classifier test suite (9 tests)
│   └── policy.test.ts        # Policy test suite (11 tests)
└── research/
    ├── README.md             # Research directory overview & benchmark scripts
    ├── bench.md              # M3 Pro CPU/MPS execution benchmarks
    ├── bench.json            # Raw benchmark data & output samples
    ├── bench_llmlingua.py    # Python benchmark harness
    ├── bench_llmlingua_js.mjs# JS/ONNX TinyBERT benchmark harness
    ├── opencode-v2-hooks.md  # OpenCode V2 hook specifications
    └── reference-repo.md     # Reference audit of context-optimizer
```

---

## Quick Start

### Prerequisites

- Node.js >= 22
- Npm

### Installation & Verification

```bash
# Clone the repository
git clone https://github.com/StrangeSid/opencode-context-optimisations.git
cd opencode-context-optimisations

# Install dependencies
npm install

# Run test suite
npm test

# Verify type safety
npm run typecheck
```

---

## Research Benchmarks Summary

Evaluated on Apple M3 Pro (18 GB RAM):

| Pipeline / Model | Hardware | Throughput / Latency | Compression Ratio | Quality Impact |
|---|---|---|:---:|---|
| **LLMLingua-2 (BERT-base)** | CPU | ~0.20 s / 1k tokens<br>~1.62 s / 8k tokens | 40–50% on prose | **Destructive on code/logs**; invalidates TypeScript syntax (`TS1005`). |
| **LLMLingua-2 (BERT-base)** | Apple MPS | ~0.10 s / 1k tokens<br>~0.70 s / 8k tokens | 40–50% on prose | Same semantic degradation on technical data. |
| **TinyBERT ONNX (JS)** | CPU | ~12–14 ms / 1.3k chars<br>~105 ms / 10k chars | 45–50% on prose | Fast local execution; requires strict fencing around identifiers. |
| **RTK Bash Output Pruning** | Native Rust | < 10 ms overhead | 60–80% on CLI tools | **Lossless for code**; strips non-essential bash context while preserving error lines. |
| **Session-Dedup** | Gateway | < 1 ms / request | ~9.3% across session | **100% Lossless**; deduplicates repeated file and log reads across turns. |

> [!NOTE]
> For complete taxonomy comparisons (including ICPC, ICAE, AutoCompressor, StreamingLLM, H2O, SnapKV, PyramidKV, and Headroom audits), see **[FINDINGS.md](./FINDINGS.md)**.

---

## Integration with OpenCode

### Gateway Configuration (`omniroute`)

When routing OpenCode through an OmniRoute proxy (`http://localhost:20128/v1`), safe lossless compression (`session-dedup`, `lite`, `headroom`) is active by default.

To enable lossy tool-output filtering (RTK) and SLM compression:
1. Provide the opt-in header in `~/.config/opencode/opencode.json`:
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
2. Disable `lite.compressToolResults` in OmniRoute settings to prevent silent 2,000-character truncation of historical file reads.

### OpenCode V2 Plugin Hook

Incorporate `src/policy.ts` inside a custom OpenCode plugin to filter context before model dispatch:

```typescript
import { Plugin } from "@opencode/plugin"
import { selectLlmlinguaCandidates } from "opencode-context-optimisations"

export default Plugin.define({
  id: "context-optimizer",
  setup(ctx) {
    ctx.session.hook("context", async (event) => {
      // 1. Select only stale, natural-language candidates
      const { candidates, selectedTokens } = selectLlmlinguaCandidates(event.messages, {
        protectedTurns: 2,
        minTokens: 400,
        budgetTokens: 2000
      })

      // 2. Dispatch candidates to warm worker (leaving code/JSON/recent turns untouched)
      // 3. Mutate event.messages in-place with compressed text
    })
  }
})
```

---

## Contributing & License

Contributions, bug reports, and benchmark reproductions are welcome. Please ensure all modifications pass unit tests and strict TypeScript checks.

Distributed under the **GNU General Public License v3.0** (`GPL-3.0-or-later`). See [LICENSE](./LICENSE) for the full license text.
