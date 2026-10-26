# opencode-context-optimisations

Selective, cache-aware context compression and token optimization for OpenCode V2 coding agents.

> [!NOTE]
> **Implementation status (2026-10-25):** the classifier, selection policy, V2 transcript adapter, watermark gate, optimizer/LRU, compaction lane, optional tool-output lane, reversible `context_expand` tool, literal-preservation check, HTTP worker, and OpenCode Go quality harness are implemented and tested. The tool-output lane is off by default because V2 tool-result persistence is unverified. See [docs/architecture.md](./docs/architecture.md). The plugin is inert until a compression endpoint is configured.

> [!IMPORTANT]
> **LLMLingua token-dropping models destroy code syntax, flatten multi-line logs, and drop negative assertions.** This project implements a strict, content-classified pipeline that reserves SLM compression exclusively for stale natural-language prose while keeping code, JSON schemas, diffs, errors, and recent dialogue byte-identical.

**Docs:** [Architecture](./docs/architecture.md) · [API reference](./docs/api-reference.md) · [Roadmap](./ROADMAP.md) · [ADR 0001](./docs/adr/0001-selective-prose-compression.md) · [Quality harness](./research/eval_quality.mjs) · [Research](./research/README.md)

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
  - System-role messages are rejected by the policy.
  - The latest *N* user turns (default 2; 1 is an explicit advanced override) remain byte-identical.
  - Only old assistant responses and tool prose are eligible for compression.
  - Generates deterministic SHA-256 cache keys; the plugin memoizes successful outputs in an LRU.
  - Enforces strict token budgets and chunk minimums, with safe fallbacks for non-finite options.
- **V2 Transcript Adapter (`src/v2.ts`)**: Understands OpenCode V2 `Message.content` parts, including the `tool-result` tagged union. It extracts textual tool output without touching IDs, tool-call pairing, reasoning parts, JSON, or errors.
- **Watermark Gate (`src/watermark.ts`)**: Estimates the outgoing request (system, tool schemas, messages, tool-call inputs) and only pays compression latency when estimated usage crosses the model's usable-context threshold (default 70%).
- **Four-Lane Plugin (`src/plugin.ts`)**:
  - `context`: watermark-gated, transient request compression.
  - `compaction`: pre-compresses the transcript before the summarizer; never sets `event.result`.
  - `execute.after`: optional, default-off incremental tool-output compression.
  - `context_expand`: reversible retrieval tool for compressed spans.
- **Reversible Compression (`src/expand.ts`)**: Stores originals in a bounded in-memory store and appends a compact `[ctx_expand:ctx_...]` marker. The model can retrieve the original or search its lines.
- **Literal Preservation (`src/literals.ts`)**: Rejects compressed output that drops file paths, URLs, numbers, line references, or error codes.
- **Optional Warm Worker (`python/llmlingua_worker.py`)**: A small HTTP sidecar that keeps LLMLingua-2 resident and serializes inference. The plugin remains inert unless `endpoint` is configured.
- **Quality Harness (`research/eval_quality.mjs`)**: A/B fact-retention test using the OpenCode Go API (default `deepseek-v4.1-flash`), reported with token and cost metrics.
- **Gateway Interoperability (OmniRoute 3.8+)**: Documented configuration for external gateway engines (RTK, Session-Dedup, Headroom); those engines are not bundled in this repository.

## Roadmap

The prioritized plan — live V2 validation, a broader quality gate, deterministic
pruning, durable state, packaging, and advanced lanes — is in
[ROADMAP.md](./ROADMAP.md). It includes issue-sized tasks and explicit
decision gates for default-on behavior.

---

## Project Structure

```
opencode-context-optimisations/
├── LICENSE                   # GNU General Public License v3.0
├── FINDINGS.md               # Research spike, gateway audit & taxonomy matrix
├── ROADMAP.md                # Prioritized future work and decision gates
├── package.json              # Exports, test scripts, dependencies
├── tsconfig.json             # TypeScript strict configuration
├── docs/
│   ├── architecture.md       # System architecture, invariants, lifecycle
│   ├── api-reference.md      # Public API reference
│   └── adr/                  # Architecture decision records
├── .env.example              # OpenCode Go / worker env template (never the key)
├── src/
│   ├── index.ts              # Pure package entry point
│   ├── constants.ts          # Shared plugin identifier
│   ├── classify.ts           # Content-kind heuristic classifier
│   ├── policy.ts             # Selection policy & candidate selection engine
│   ├── v2.ts                 # V2 Message/ContentPart/ToolResult adapter
│   ├── optimizer.ts          # LRU, timeout, literals, replacement orchestration
│   ├── compressor.ts         # HTTP sidecar client
│   ├── watermark.ts          # Context-pressure estimation & gate
│   ├── expand.ts             # Reversible original-text store & markers
│   ├── literals.ts           # Path/number/URL/error preservation check
│   ├── tool-result.ts        # Tool payload extraction & protection
│   └── plugin.ts             # Context, compaction, tool, expand wiring
├── tests/
│   ├── classify.test.ts      # Classifier suite
│   ├── policy.test.ts        # Policy suite
│   ├── v2.test.ts            # Adapter & replacement suite
│   ├── optimizer.test.ts     # Cache, timeout, literals, fail-open suite
│   ├── compressor.test.ts    # Sidecar protocol suite
│   ├── expand.test.ts        # Original store & marker suite
│   ├── literals.test.ts      # Literal extraction/preservation suite
│   ├── tool-result.test.ts   # Tool payload extraction suite
│   ├── watermark.test.ts     # Context-pressure suite
│   └── plugin.test.ts        # Hook registration & lane suite
├── python/
│   ├── llmlingua_worker.py   # Optional warm HTTP sidecar
│   ├── requirements.txt      # Sidecar-only Python dependencies
│   └── README.md             # Install/run/limits for the worker
└── research/
    ├── README.md             # Research directory overview & benchmark scripts
    ├── bench.md              # M3 Pro CPU/MPS execution benchmarks
    ├── bench.json            # Raw benchmark data & output samples
    ├── bench_llmlingua.py    # Python benchmark harness
    ├── bench_llmlingua_js.mjs# JS/ONNX TinyBERT benchmark harness
    ├── eval_quality.mjs      # A/B fact-retention harness (OpenCode Go)
    ├── opencode-v2-hooks.md  # OpenCode V2 hook specifications
    └── reference-repo.md     # Reference audit of context-optimizer
```

---

## Quick Start

### Prerequisites

- Node.js >= 22 with built-in TypeScript type stripping (recent 22.x or newer)
- Npm >= 10

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

### Plugin + Optional Sidecar

The package now ships a real V2 context hook in [`src/plugin.ts`](./src/plugin.ts) and an optional warm worker in [`python/llmlingua_worker.py`](./python/llmlingua_worker.py).

1. Start the sidecar (see [`python/README.md`](./python/README.md)):

   ```bash
   uv venv .venv-worker --python 3.12
   uv pip install --python .venv-worker/bin/python -r python/requirements.txt
   .venv-worker/bin/python python/llmlingua_worker.py --port 8765
   ```

2. Point OpenCode at the worker. The plugin is inert without `endpoint`:

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
           "watermarkEnabled": true,
           "watermarkRatio": 0.7,
           "compactionEnabled": true,
           "compactionBudgetTokens": 8000,
           "compactionTimeoutMs": 12000,
           "toolOutputEnabled": false,
           "expandToolEnabled": true,
           "validateLiterals": true,
           "debug": false
         }
       }
     ]
   }
   ```

   When installed as a package, the entry point is
   `"opencode-context-optimisations/plugin"`. Relative plugin paths resolve
   from the config file, so use an absolute path if this config lives outside
   the repository.

3. The lanes:
   - **context**: runs before each model call, but only when the estimated
     request crosses `watermarkRatio` of the model's usable context. It adapts
     `event.messages`, selects stale prose, consults the LRU, and replaces only
     approved text/tool-result spans.
   - **compaction**: pre-compresses the transcript before OpenCode's summarizer
     runs. It does not set `event.result`; it preserves chronology and leaves
     JSON, errors, code, and the recent window intact.
   - **execute.after**: optional, default off. It compresses only completed
     textual tool output whose class is prose. The research has not verified
     whether replacement is persisted by every V2 build, so enable it only after
     testing your version.
   - **context_expand**: registered by default. Compressed spans get a compact
     `[ctx_expand:ctx_...]` marker; the model can retrieve the original text or
     search its lines. Disable with `expandToolEnabled: false`.

   The plugin never persists request/compaction edits. Because V2 `context`
   edits are transient, it recomputes against each outgoing request and relies
   on the content-hash cache to avoid repeat sidecar work.

> [!WARNING]
> This is still a lossy compressor. The request lane fails open on every
> backend error, but quality is only as good as the policy and literal gates.
> Run the quality harness before enabling compression for code-adjacent prose,
> and leave `toolOutputEnabled` off unless you have verified persistence in
> your OpenCode build.

### Quality Evaluation (OpenCode Go)

`research/eval_quality.mjs` compresses a synthetic coding transcript with the
real worker, asks the same fact questions over the original and compressed
contexts, and reports per-fact retention, token estimates, and API cost.

```bash
cp .env.example .env       # add OC_GO_KEY
.venv-worker/bin/python python/llmlingua_worker.py --port 8765 &
npm run eval:quality -- --runs 2
```

The default judge is `deepseek-v4.1-flash` through
`https://opencode.ai/inference/go/v1`. Override with `OC_GO_MODEL` /
`OC_GO_BASE_URL` or `--model`. The harness disables literal validation so it
measures raw LLMLingua retention; the plugin enables that check by default.
The harness refuses to run without `OC_GO_KEY`; `.env` is gitignored.

The included fixture measured **6/6 fact checks retained** on both the original
and compressed transcripts, with an estimated **32.5% reduction** and about
**$0.0013** of API usage for two runs (2026-10-25). That is a smoke test, not a
broad task-success benchmark.

---

## Contributing & License

Contributions, bug reports, and benchmark reproductions are welcome. Please ensure all modifications pass unit tests and strict TypeScript checks.

Distributed under the **GNU General Public License v3.0** (`GPL-3.0-or-later`). See [LICENSE](./LICENSE) for the full license text.
