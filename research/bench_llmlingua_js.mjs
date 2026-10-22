/**
 * Ad-hoc JS/ONNX probe for @atjsh/llmlingua-2.
 *
 * Run from a scratch directory that has the dependencies installed:
 *   mkdir -p /tmp/llm-js && cd /tmp/llm-js
 *   npm init -y
 *   npm install @huggingface/transformers@4.2.0 @atjsh/llmlingua-2@3.0.0 js-tiktoken
 *   node /path/to/research/bench_llmlingua_js.mjs
 *
 * Models download to the Hugging Face cache on first use. TinyBERT is 57 MB;
 * it is fast but visibly lossy. BERT-base ONNX is 710 MB and was not completed
 * during the spike (download stalled); treat its quality as unverified.
 */
import { LLMLingua2 } from "@atjsh/llmlingua-2"
import { Tiktoken } from "js-tiktoken/lite"
import o200k_base from "js-tiktoken/ranks/o200k_base"

const prose = `The build failed because the TypeScript compiler could not resolve the module "./utils.js". I checked tsconfig.json and moduleResolution was set to "bundler", which should work. The failure only happens in the test package, where the same import is resolved from a different root. I tried clearing node_modules and reinstalling, but the error persisted. Next I will inspect the package exports map and the compiled output.
`

const log = Array.from(
  { length: 40 },
  (_, i) =>
    `[${String(i).padStart(4, "0")}] INFO  worker-${i % 8} completed task ${i} in ${12 + (i % 7)}ms; queue=0; cache=${i % 3 === 0 ? "miss" : "hit"}`,
).join("\n") + `\nERROR parser: unexpected token at line 42: expected "]" but found "}"\n    at parseArray (src/parser.ts:118:23)\n    at parseDocument (src/parser.ts:64:9)\n`

const code = `import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadConfig(dir: string): Promise<Config> {
  const file = path.join(dir, "config.json");
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.version || parsed.version !== 2) {
    throw new Error(\`unsupported config version \${parsed.version}\`);
  }
  return { ...parsed, file };
}
`

const tests = {
  prose1k: prose.repeat(3),
  log2k: log,
  code1k: code.repeat(4),
  prose8k: prose.repeat(24),
}

const model = process.env.LLMLINGUA_JS_MODEL ?? "atjsh/llmlingua-2-js-tinybert-meetingbank"

const t0 = Date.now()
const { promptCompressor } = await LLMLingua2.WithBERTMultilingual(model, {
  transformerJSConfig: { device: "cpu", dtype: "fp32" },
  oaiTokenizer: new Tiktoken(o200k_base),
  modelSpecificOptions: { subfolder: "" },
})
console.log(`# ${model} load ${Date.now() - t0} ms`)

for (const [name, text] of Object.entries(tests)) {
  for (const rate of [0.8, 0.6]) {
    await promptCompressor.compress_prompt("warmup", { rate: 0.8 })
    const started = Date.now()
    const out = await promptCompressor.compress_prompt(text, { rate })
    console.log(
      `${name}\trate=${rate}\t${Date.now() - started} ms\t${text.length} -> ${out.length} chars`,
    )
    if (name === "code1k") console.log(`  sample: ${JSON.stringify(out.slice(0, 120))}`)
  }
}
