# LLMLingua-2 on an Apple M3 Pro: CPU benchmark

**Date:** 2026-10-22 (JST)
**Question:** is per-turn LLMLingua-2 compression viable on this laptop with a
< 500 ms per-turn budget?

## Verdict

**Not viable as a general per-turn compressor. Viable only as a warm daemon for
small prose/tool-output chunks, and only with an uncompressed fallback.**

- Warm in-process compression of ~1k tokens of prose or TypeScript takes
  **~200 ms**; ~2k tokens of build log takes **~490 ms**; 8k tokens of prose
  takes **~1.6 s**. The 500 ms budget is met for 1k-token inputs, barely met for
  2k-token logs, and missed for 8k inputs.
- A **fresh process** costs **2.6 s end-to-end** with HF offline; online startup
  alone takes **3.3–4.2 s**. A daemon that keeps the model resident is therefore
  mandatory: it is **12–19× faster per call** than spawning Python.
- **Quality is the bigger blocker.** The default LLMLingua-2 output joins words
  with spaces, inserts spaces around punctuation, and drops many separators
  (newlines, braces). TypeScript samples become syntactically invalid (`tsc`
  immediately reports `TS1005`), and build logs collapse to one unreadable
  line. Prose remains telegraphically readable but loses negations (3 → 2 at
  1k; 23 → 15 at 8k in the sampled input).
- Recommendation: do **not** use this model as-is on code or logs. If it is used
  at all, restrict it to old prose/tool narration, cap chunks at ~1–2k tokens,
  keep code/recent messages uncompressed, cache stable prefixes, and post-process
  or fall back when the output is malformed.

Raw measurements: `research/bench.json`. Full console log: `research/bench_run.log`.
Benchmark source: `research/bench_llmlingua.py`.

## Environment

| Item | Value |
|---|---|
| Machine | Apple M3 Pro, 18 GB unified memory, 11 CPUs |
| OS | macOS 27.0.1 (arm64) |
| Python | 3.12.9 (`.venv-bench`) |
| PyTorch | 2.14.1 (CPU, 5 threads by default) |
| Transformers | 5.20.2 |
| LLMLingua | 0.2.2 |
| Tokenizers | 0.23.3 |
| Model | `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` |
| Tokenizer | `BertTokenizer` (slow tokenizer, not `BertTokenizerFast`) |

The benchmark sets `HF_HOME` to `.venv-bench/hf-cache`, so the model cache lives
inside the isolated venv rather than the user's normal Hugging Face cache.

## Install footprint and startup

`uv pip install llmlingua` took **5m43s** wall time, mostly downloading and
unpacking the PyTorch wheel. The first model download/load took **358.7 s**
(~6 min) because the 709 MB model was fetched from the Hugging Face Hub; that
number is a download-inclusive load from the initial run and isn't
representative of a cached start. The retained `bench.json` is the subsequent
cached rerun; its 2.87 s `load_s` covers Hub metadata checks, not the download.

| Artifact | Size |
|---|---:|
| `.venv-bench` total | 1.41 GiB (1,483,488 KiB) |
| site-packages | 768 MiB (786,584 KiB) |
| HF cache (model) | 680 MiB (696,752 KiB, 27 files) |

Startup breakdown (cached model):

| Stage | Time |
|---|---:|
| Import `torch` + `transformers` + `llmlingua` | 1.73–2.45 s (median 1.78 s) |
| Load model, HF offline (warm disk) | **0.24–0.27 s** (median 0.25 s) |
| Load model, HF online (Hub metadata checks) | 1.56–2.87 s |
| Fresh process: spawn → import → load → compress 1k prose | **2.59 s** (offline; 2.587–2.598 s) |
| Fresh-process probes, online: import → load (no compress) | 3.3–4.2 s |
| Warm in-process compress, 1k prose @ 0.6 | **0.216 s** |

The difference between offline and online model loads is HF Hub metadata
traffic, not model compute. A daemon that starts once and then serves turns pays
the 2.6–4.2 s startup once; each subsequent compression pays only the warm row.

## Latency and compression

Inputs are synthetic but representative and deterministic. Token counts use the
compressor's own tokenizer; `rate` is the requested keep fraction, and `keep` is
the measured output/input token ratio.

Each configuration was run three times: the first run is the "cold" call for
that input/rate (model already loaded), and the warm median is the median of
runs 2–3. All warm outputs were byte-identical across repeats (same 16-hex
SHA-256 prefix), so these aren't sampling-noise averages.

| Input | Input tokens | Rate | Cold (ms) | Warm median (ms) | Output tokens | Keep | Chars in → out |
|---|---:|---:|---:|---:|---:|---:|---:|
| prose | 1,011 | 0.80 | 228 | 203 | 813 | 0.804 | 4,717 → 4,010 |
| prose | 1,011 | 0.60 | 204 | 216 | 616 | 0.609 | 4,717 → 3,150 |
| prose | 1,011 | 0.35 | 201 | 201 | 378 | 0.374 | 4,717 → 1,928 |
| build log | 2,007 | 0.80 | 493 | 489 | 1,601 | 0.798 | 5,716 → 5,207 |
| build log | 2,007 | 0.60 | 492 | 492 | 1,214 | 0.605 | 5,716 → 4,176 |
| build log | 2,007 | 0.35 | 491 | 492 | 699 | 0.348 | 5,716 → 2,373 |
| TypeScript | 1,001 | 0.80 | 204 | 200 | 807 | 0.806 | 3,139 → 2,706 |
| TypeScript | 1,001 | 0.60 | 201 | 200 | 607 | 0.606 | 3,139 → 2,181 |
| TypeScript | 1,001 | 0.35 | 201 | 199 | 371 | 0.371 | 3,139 → 1,394 |
| long prose | 8,044 | 0.80 | 1,629 | 1,622 | 6,470 | 0.804 | 37,491 → 31,732 |
| long prose | 8,044 | 0.60 | 1,668 | 1,625 | 4,910 | 0.610 | 37,491 → 25,580 |
| long prose | 8,044 | 0.35 | 1,648 | 1,616 | 3,045 | 0.379 | 37,491 → 15,429 |

The measured keep ratio tracks the requested rate closely, within about 0.01.
Latency is **almost independent of the rate**: every token is scored regardless
of how many are kept, so chunk count and sequence length dominate. Dropping from
0.8 to 0.35 doesn't make the model faster. The library splits text at sentence
and newline boundaries (512-token max chunks, batch size 50), which is why the
2k log costs more than the 1k code sample despite a similar line count.

Latency scales roughly with token count/chunk count: 1k ≈ 0.20 s, 2k ≈ 0.49 s,
8k ≈ 1.62 s. The log is slower than code at similar line counts because it has
twice as many tokens.

## Fresh process vs warm daemon

The fresh-process experiment spawns the benchmark script as a child, imports the
stack, loads the model, and compresses the same 1k prose input at rate 0.6.

| Path | Median |
|---|---:|
| Spawn + import + load + compress (HF offline) | 2,592 ms |
| Import only (child) | 1,780 ms |
| Model load only (child, offline) | 249 ms |
| Model load only (parent, online; includes Hub checks) | 2,875 ms |
| Warm compress in parent (same input) | 216 ms |

The daemon saves about **2.38 s per turn** versus spawning a fresh offline
process. Online startup alone costs **3.1–4.0 s more** than a warm compression,
before the child does any compression at all. If a solution needs one compression
per turn, process-per-turn architecture isn't viable. The model must stay
resident.

## Quality spot-check

These are excerpts from the exact inputs in `bench.json`, compressed at rate
0.6. The input is synthetic TypeScript/log text. It is representative of code
and test output, not a real repository file.

### TypeScript, rate 0.6

Before (first lines):

```ts
import { createHash } from "node:crypto";
export type CompressionRate = 0.8 | 0.6 | 0.35;
export interface CompressionOptions {
  rate: CompressionRate;
  preserve?: readonly string[];
  maxTokens?: number;
}
export interface CompressionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  ratio: number;
  checksum: string;
}
```

After (first ~500 characters; the output is one line):

```text
import createHash node : crypto export CompressionRate = 0. 8 | 0. 6 | 0. 35 export interface CompressionOptions rate : CompressionRate preserve? string [ maxTokens? number CompressionResult text : string number ratio : number checksum string const DEFAULT _ PRESERVE = \ n TODO new Error const export function checksum text string return createHash ( sha256 " ) update text ) digest ( hex " ) slice ( 0, 16 ) export function assertNever ( value : never ) : never throw new Error value : String value export class ContextCompressor0 private cache = new Map < string CompressionResult > preserve string [ constructor options CompressionOptions preserve = options public async compress ( input : string ) : Promise CompressionResult > const cached = cache. get ( input return const inputTokens = countTokens input ) target = Math. floor ( inputTokens options rate ) const lines = input. split ( " \ n " ) kept : string [ ] = [ ] line lines ) if kept. length target ) break preserve. some token line. includes token kept. push ( line ) ; continue if line. trim ( ). length > 0 & & line. startsWith ( npm WARN " ) ) keptpush ( line ) const text = kept. join ( " \ n " ) const outputTokens = countTokens (
```

Measured on the full compressed sample: **0 newlines, 0 `{`, 0 `}`, 26 `(` vs
30 `)`, 1 semicolon**. The ~1k-token input is itself truncated mid-function
(the benchmark cuts whole lines at the token budget), so `tsc` on the original
reports one error at end-of-file. The compressed sample produces **73 errors**,
starting at the first line (the sample was written to a temporary file and
removed after the check):

```text
$ node_modules/.bin/tsc --noEmit --skipLibCheck --target es2022 research/.tmp_compressed.ts
research/.tmp_compressed.ts(1,19): error TS1005: '=' expected.
research/.tmp_compressed.ts(1,24): error TS1005: ';' expected.
research/.tmp_compressed.ts(1,26): error TS1434: Unexpected keyword or identifier.
...
```

This isn't a marginal degradation: the output can't be used as TypeScript.

### Build log, rate 0.6

Before:

```text
2026-10-22T09:12:00.000Z INFO  build    [01/64] compiling src/features/context/module_00.ts
2026-10-22T09:12:01.037Z DEBUG esbuild  resolve ../../packages/shared/src/tokens.ts -> packages/shared/dist/tokens.js
npm WARN deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it.
npm WARN config production Use `--omit=dev` instead of `--production`.
> opencode-context-optimisations@0.3.0 build
> tsc -p tsconfig.build.json && esbuild src/index.ts --bundle --platform=node --outfile=dist/index.js
src/context/compressor.ts(46,9): warning TS6133: 'options' is declared but its value is never read.
src/context/telemetry.ts(47,10): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
    at compressPrompt (/workspace/opencode-context-optimisations/src/context/compressor.ts:48:11)
```

After (first ~550 characters; the output is one line):

```text
2026 - 10 - 22T09 : 12 : 00. 000Z INFO build [ 01 / 64 ] compiling src features context module _ 00. ts 2026 - - 22T09 12 : 01. 037Z DEBUG esbuild resolve. packages shared src / tokens. ts packages dist tokens js npm WARN deprecated inflight @ 1. 0. 6 module not supported leaks memory use npm WARN config production Use omit = dev opencode - context - optimisations @ 0. 3. 0 build > tsc - p tsconfig. build. json esbuild src / index. ts bundle platform = node outfile = dist / index. js src context compressor ts 46, 9 ) warning TS6133 options ' declared value never read src context telemetry. ts 47, 10 ) error TS2345 Argument type string undefined ' not assignable parameter compressPrompt processTicksAndRejections async runTurn Error connect ECONNREFUSED 127. 0. 0. 1 : 11434
```

The key error strings happen to survive at 0.8/0.6 (`ECONNREFUSED`,
`error TS2345`, `AssertionError`, `tests 182`, `PASS`: 5/5), and at 0.35 four of
five survive (`tests 182` is lost). But timestamps and line structure don't:
the 5,716-character log becomes 4,176 characters on **one line**. A human can
still find the error; a line-oriented tool or test reporter can't use it
without reconstruction.

Prose is better: all four keyword markers survive at every rate, and the 1k
sample is still readable in a telegraphic way. Negation retention is imperfect:
3 negation markers in → 2 out at 1k, and 23 → 15 at 8k. Keyword-presence checks
are a weak proxy for downstream accuracy. They're included only as a sanity
check, not as evidence that meaning is preserved.

The whitespace/punctuation damage appears to be intrinsic to the LLMLingua-2
path: it rebuilds text by joining word-level pieces, which inserts spaces around
punctuation and drops separators such as newlines. This was observed consistently
in every code and log sample inspected (rates 0.6 and 0.35), not as an occasional
failure.

## Recommendation for per-turn compression

1. **Run it in a daemon, not per process.** 2.6 s offline / 3.3–4.2 s online
   startup versus 0.2 s warm compression makes process-per-turn a non-starter.
2. **Budget:** with a warm daemon, 1k prose ≈ 0.20 s and 2k logs ≈ 0.49 s fit
   under 500 ms; 8k prose ≈ 1.62 s doesn't. Compress only the new/incremental
   part of the transcript, not the whole context.
3. **Don't feed code through the default path.** The output isn't valid
   syntax (0 braces/newlines, tsc `TS1005`). Use an AST-aware reducer for code,
   or leave code uncompressed. Logs are also structurally destroyed; use log
   deduplication/error extraction rather than token classification.
4. **If using it for prose/tool narration:** cap chunks at ~1–2k tokens, keep
   recent messages and instructions intact, cache compression of stable
   prefixes, preserve an uncompressed fallback, and validate output before
   sending it to the model. Consider post-processing whitespace/newlines and
   testing `force_tokens` for critical identifiers; that will require additional
   work and validation, and it doesn't fix the word-join formatting by itself.
5. **Overall:** for a < 500 ms per-turn budget, LLMLingua-2 BERT-base is
   technically fast enough only in the narrow warm, ≤1–2k prose case. Its
   default output quality isn't good enough to make it a safe general-purpose
   compression layer for an agent transcript. The latency is workable; the
   fidelity isn't.

## Reproduction

```bash
cd /workspace/opencode-context-optimisations
uv venv .venv-bench --python 3.12
uv pip install --python .venv-bench/bin/python llmlingua
.venv-bench/bin/python research/bench_llmlingua.py --runs 3
```

The script sets `HF_HOME` to `.venv-bench/hf-cache` automatically. The first run
downloads the model (~6 min on this network); subsequent runs take ~36 s. Use
`--runs 2` for a shorter cold+warm check. Raw per-run timings, token counts,
checksums, marker retention, and process-startup measurements are in
`research/bench.json`.

## Caveats

- Single machine, single session. Warm medians use two samples per config;
  background work was light but not controlled. CPU thread count was PyTorch's
  default of 5.
- "Cold" in the latency table means the first call for that input/rate with the
  model already loaded. True process-cold startup is measured separately above.
- Quality was assessed with short spot checks, marker retention, and a TypeScript
  parse; this isn't a downstream task-accuracy evaluation.
- Inputs are passed as single strings, so the token-level path is exercised and
  the library's context-level filtering is bypassed. Multi-message/context-level
  compression may behave differently.
- Token counts use the model's BERT tokenizer, not GPT/Claude tokenizers, so
  dollar savings would differ from the library's reported GPT-4 estimates.
- The online Hugging Face metadata checks are network-dependent and varied by
  seconds between probes; offline load times are stable at ~0.25 s.
