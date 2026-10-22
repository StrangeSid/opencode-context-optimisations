# OpenCode V2 plugin hooks and LLMLingua integration notes

**Status:** research note for `opencode-context-optimisations`  
**Verified against:** OpenCode `v2.1.3`, `@opencode/plugin@2.1.3`, `@opencode/ai@2.1.3`, `@opencode/schema@2.1.3`, `@opencode/client@2.1.3`  
**Date:** 2026-10-22

This note is deliberately version-pinned. V2 plugin APIs are still moving, and some runtime semantics below are not spelled out in the public docs.

## Scope and method

- Exact TypeScript declarations were read from npm tarballs unpacked under `/tmp/oc-plugin-types` (not from the target repo):
  - `@opencode/plugin@2.1.3`: `dist/promise/*.d.ts`, `dist/effect/*.d.ts`
  - `@opencode/ai@2.1.3`: `dist/schema/messages.d.ts`
  - `@opencode/schema@2.1.3`: `config/compaction.d.ts`, `session-message.d.ts`, `session.d.ts`, `model.d.ts`, `tool.d.ts`, `prompt-input.d.ts`
  - `@opencode/client@2.1.3`: generated API types for `SessionApi`
- Runtime behavior was checked against the bundled JavaScript inside the installed binary:
  - `/opt/homebrew/Cellar/opencode-v2/2.1.3/bin/opencode`
- Public docs were fetched from `https://opencode.ai/v2/docs/...` on 2026-10-22.

Claims are marked where useful:

- **[types]** exact declaration
- **[docs]** explicitly documented
- **[runtime]** observed in the 2.1.3 bundled runtime
- **[open]** not fully verified; test before depending on it

## Short version

- A V2 plugin default-exports `Plugin.define({ id, setup(ctx) })`.
- Hooks are registered on domains, not returned as an object: `await ctx.session.hook("context", callback)`.
- The important LLMLingua hook is `ctx.session.hook("context", ...)`. It runs for each agent-loop model request, including tool-driven continuations.
- The `context` event exposes mutable `system`, `messages`, `tools`, and `options`. Changes affect only that outgoing model call. They are **not** persisted to session history or configuration. **[docs]**
- Because the history is rebuilt from persisted state on every model call, compression must be reapplied every time. Cache compressed strings, not mutated `Message` objects.
- Auto-compaction in 2.1.3 is decided **before** the `context` hook runs, using the context assembled for that step. Compression cannot change that step's decision. A prior compressed request can lower the measured usage OpenCode sees on later steps, so it may influence future thresholds indirectly; do not rely on it to prevent compaction. **[runtime]**
- V1 plugin implementations do not run in V2. They must be ported to the V2 entrypoint and hook API. **[docs]**

## 1. Plugin entrypoint and loading

### 1.1 Promise plugin type

**[types]** `@opencode/plugin/dist/promise/plugin.d.ts`:

```ts
export type Cleanup = () => Promise<void> | void

export interface Plugin {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}

export declare function define(plugin: Plugin): Plugin
```

Minimal entrypoint:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    // register hooks, transforms, tools, subscriptions
  },
})
```

`setup` runs when the plugin loads. It may return a cleanup function for resources the plugin owns (processes, sockets, timers). Hook and transform registrations are scoped to the plugin and are cleaned up automatically. **[docs]**

### 1.2 Plugin context

**[types]** The Promise `Context` contains these domains (abbreviated only where noted):

```ts
export interface Context {
  readonly app: App
  readonly location: Location.Info
  readonly options: PluginOptions

  readonly agent: AgentDomain
  readonly aisdk: AISDKDomain
  readonly command: CommandDomain
  readonly credential: Pick<CredentialApi, "activate">
  readonly event: EventDomain
  readonly experimental: {
    readonly terminal: Pick<OpenCodeClient["experimental"]["persistentPty"], "read">
  }
  readonly integration: IntegrationDomain
  readonly mcp: MCPDomain
  readonly model: ModelDomain
  readonly generate: GenerateApi
  readonly permission: PermissionDomain
  readonly plugin: Pick<PluginApi, "list">
  readonly provider: ProviderDomain
  readonly reference: ReferenceDomain
  readonly rpc: RpcDomain
  readonly session: SessionDomain
  readonly shell: ShellDomain
  readonly skill: SkillDomain
  readonly storage: StorageDomain
  readonly tool: ToolDomain
  readonly vcs: VcsDomain
  readonly websearch: WebSearchDomain
  readonly worktree: WorktreeDomain
}
```

There is no `ctx.client` property. The domains expose the client operations plus plugin-only methods such as `hook`, `transform`, `reload`, and `storage`. **[docs]**

`ctx.options` is a plain read-only record:

```ts
export type PluginOptions = Readonly<Record<string, any>>
```

Options are passed through the object form in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/llmlingua",
      "options": { "rate": 0.8 }
    }
  ]
}
```

### 1.3 Effect plugin type

**[types]** `@opencode/plugin/effect` is the Effect-native entrypoint:

```ts
import type { Effect, Scope } from "effect"

export interface Plugin<R = Scope.Scope> {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, R>
}

export declare function define<R = Scope.Scope>(plugin: Plugin<R>): Plugin<R>
```

The Promise API is simpler for a compression plugin that already needs an async sidecar call.

### 1.4 Where V2 loads plugins from

**[docs]**

Auto-discovery:

- direct `.ts` and `.js` files under `.opencode/plugins/`
- immediate plugin package directories under `.opencode/plugins/`
- the same layout under `~/.config/opencode/plugins/`

V2 discovers both `.opencode/plugin/` (the V1-era directory) and `.opencode/plugins/`, but use the plural directory for new V2 plugins. **[docs]**

Explicit configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-acme-plugin",
    "opencode-acme-plugin@1.2.0",
    "@acme/opencode-plugin",
    "./plugins/local",
    "../shared/plugin.ts",
    "/absolute/path/plugin.ts",
    "file:///home/me/plugins/local",
    { "package": "@acme/opencode-plugin", "options": { "strict": true } }
  ]
}
```

Rules that matter for local development:

- Relative paths resolve from the config file containing the entry, not from the process cwd. **[docs]**
- Plugin arrays from applicable config files are applied lowest-to-highest precedence instead of replacing one another. **[docs]**
- TypeScript is loaded directly; no build step is required for a local `.ts` plugin. **[docs]**
- A `plugins/` directory beside a project-root `opencode.json(c)` is **not** auto-discovered. Put it under `.opencode/plugins/` or configure it explicitly. **[docs]**
- The module loader requires a default export with `id` plus `setup` or `effect`. A module with only `server()` is rejected with: `Plugin must export a default definition with an id and an effect or setup function.` **[runtime]**
- `plugin` (singular) is the V1 config key; `plugins` (plural) is V2. **[docs]**

### 1.5 Local plugin skeleton layout

Simplest layout:

```text
my-project/
├── opencode.jsonc
├── package.json                 # depends on @opencode/plugin
└── .opencode/
    └── plugins/
        └── llmlingua.ts         # auto-discovered
```

If you prefer an explicit entry:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./.opencode/plugins/llmlingua.ts"]
}
```

For a publishable package, the docs' minimal manifest is:

```json
{
  "name": "opencode-acme-plugin",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@opencode/plugin": "latest" }
}
```

Use a version compatible with the OpenCode release you target. Test the installed package, not only a workspace-linked copy. **[docs]**

For this repo, pin `"@opencode/plugin": "2.1.3"` to match the installed OpenCode `v2.1.3`.

## 2. Hook registration and scheduling

### 2.1 Registration signatures

**[types]** `@opencode/plugin/dist/promise/registration.d.ts`:

```ts
export interface Registration {
  readonly dispose: () => Promise<void>
}

export interface ModelHookOptions {
  /** Limits the hook to one provider. Unscoped hooks apply to every provider. */
  readonly providerID?: string
}

export type Hooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
) => Promise<Registration>

export type ModelHooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
  options?: Spec[Name] extends { readonly model: unknown } ? ModelHookOptions : never,
) => Promise<Registration>
```

Consequences:

- Callbacks may be synchronous or asynchronous. The 2.1.3 session bridge wraps callbacks in `Promise.resolve(...)` and awaits them before continuing. **[runtime]** A slow LLMLingua sidecar therefore delays model dispatch.
- The third `{ providerID }` argument is accepted only for events that contain `model`. `prompt` does **not** contain `model`, so provider scoping is a type error there. **[types]**
- `await ctx.session.hook(...)` returns a `Registration`. You normally do not need to keep it: registrations are disposed when the plugin unloads. Retain it only to remove a hook earlier with `registration.dispose()`. **[docs]**

The Effect entrypoint has analogous types in `dist/effect/registration.d.ts`: callbacks return `Effect.Effect<void>`, `Registration.dispose` is an `Effect`, and registration runs in `Scope.Scope`.

### 2.2 Hook catalogue and timing

`SessionHooks` from `dist/promise/session.d.ts`:

```ts
export interface SessionHooks {
  readonly prompt: SessionPrompt
  readonly context: SessionContext
  readonly compaction: SessionCompaction
  readonly generate: SessionGenerate
  readonly title: SessionTitle
  readonly "model.request": SessionModelRequest
  readonly "http.request": SessionHttpRequest
  readonly "http.response": SessionHttpResponse
  readonly "experimental.ws.handshake": SessionWebSocketHandshake
  readonly "experimental.ws.send": SessionWebSocketSend
  readonly "experimental.ws.receive": SessionWebSocketReceive
  readonly retry: SessionRetry
}
```

| Hook | When it runs | Event exposes | Persistence of edits |
| --- | --- | --- | --- |
| `prompt` | Once, during user-prompt admission, before attachment/skill resolution and durable inbox admission | mutable prompt text/files/agents/skills, metadata, delivery | **Persisted.** Edits become canonical user input. |
| `context` | Each agent-loop model request, including tool continuations, immediately before dispatch | mutable system/messages/tools/options | **Transient.** Only the outgoing request changes. |
| `compaction` | When a checkpoint summary request is prepared | transcript being summarized, plus normal context fields; optional `result` | Summary result is persisted as a compaction message. |
| `generate` | `ctx.session.generate` calls | same shape as `context` | Transient to that auxiliary generation. |
| `title` | Title generation | request fields; optional string `result` | Title result is used for the session title. |
| `model.request` | Before model request settings are finalized | `sessionID`, `agent`, `model`, `kind`, `baseURL?`, `headers` | Transient. |
| `http.request` | Before a native provider HTTP request | `request: Request`, plus IDs/kind | Transient; body is a one-shot stream. |
| `http.response` | After a native provider HTTP response | `response: Response`, plus request/IDs/kind | Transient; body is a one-shot stream. |
| `experimental.ws.*` | WebSocket handshake/send/receive | URL/headers or frame string | Experimental; may change. |
| `retry` | After a failure is classified, before a retry is scheduled | error, attempt number, decision | Transient. |
| `tool.execute.before` | Before a tool executes | tool name, call ID, mutable `input` | Input change affects the call. |
| `tool.execute.after` | After a tool completes or fails | result or error, plus IDs | Result replacement is shown by docs; persistence is [open]. |

**[docs]** Hook ordering:

> Multiple plugins can register the same hook. OpenCode runs them in plugin order, so later hooks see changes made by earlier hooks.

For a compression plugin, this means another plugin that already rewrites `messages` changes what you see. Register deliberately and make your transformations idempotent.

### 2.3 The `context` hook is not once per user turn

The docs are explicit:

> `context` runs for the agent loop, including tool-driven continuations.

A single user turn can produce many model calls: initial answer, tool call, tool result continuation, another tool call, and so on. `context` fires for each. This is the right place to compress the growing prompt, but it also means naïve compression will run many times per turn.

### 2.4 Transient edits are the key constraint

**[docs]**

> Changes affect only the outgoing model call, not persisted history or configuration.

Implications:

- `ctx.session.context({ sessionID })` returns persisted message info, not the mutated outgoing copy.
- The UI/history continues to show the original text.
- The next model call reconstructs messages from persisted state, so the original text comes back. You must reapply compression every call.
- Do not rely on markers you wrote into message parts; they disappear with the transient copy.

## 3. Exact session hook types

### 3.1 Shared request and context

**[types]** `dist/promise/session.d.ts`:

```ts
export type SessionRequestOptions =
  Types.DeepMutable<GenerationOptionsFields> & Record<string, unknown>

export interface SessionRequest {
  readonly sessionID: Session.ID
  readonly model: Model.Ref
  system: Array<SystemPart>
  messages: Array<Message>
  options: SessionRequestOptions
}

export interface SessionContext extends SessionRequest {
  readonly agent: Agent.ID
  tools: Record<string, {
    description: string
    input: JsonSchema.JsonSchema
  }>
}
```

Important details:

- `sessionID`, `model`, and `agent` are readonly. `system`, `messages`, `options`, and `tools` are mutable.
- `model` is only a `Model.Ref` (`{ id, providerID, variant? }`). It does **not** contain context limits. Use `ctx.model.list()` for limits (see §6).
- `tools` is a name → `{ description, input }` record. You can delete a tool to hide it from this request. **[docs]**
- `options` starts empty for each model call. It does not contain resolved model settings. Typed keys are generation settings; unknown keys are provider options. Deleting a key or setting it to `undefined` falls back to configured defaults. **[docs]**
- Provider option objects merge recursively; arrays and scalar values replace earlier values. **[docs]**

The docs show IDs as plain strings; the actual declarations use branded types such as `Session.ID`, `Agent.ID`, `Model.Ref`, and `Tool.CallID`. At runtime they are strings, but TypeScript will require the branded types in strict code.

Documented mutation example:

```ts
await ctx.session.hook("context", (event) => {
  event.system.push({ type: "text", text: "Keep the review focused on correctness." })
  delete event.tools.write
  event.options.temperature = 0.2
  event.options.maxTokens = 8_000
})
```

### 3.2 Prompt admission

**[types]**

```ts
export interface SessionPrompt {
  readonly sessionID: Session.ID
  readonly messageID: SessionMessage.ID
  prompt: Types.DeepMutable<PromptInput.Prompt>
  metadata?: Record<string, unknown>
  delivery: SessionInbox.Delivery // "steer" | "queue"
}
```

`PromptInput.Prompt` is:

```ts
{
  text: string
  files?: FileAttachment[]
  agents?: { name: string; mention?: { start: number; end: number; text: string } }[]
  skills?: { id: Skill.ID; mention?: { start: number; end: number; text: string } }[]
}
```

**[docs]** Prompt hook rules:

- Runs once during admission, not before every model call.
- `delivery` defaults to `"steer"` and can be changed to `"queue"`. **[docs]**
- Runs before attachment and skill resolution; added files/skills go through normal resolution and validation.
- Runs for commands that submit through `session.prompt`.
- Does **not** run for synthetic messages, shell messages, compaction controls, or move controls.
- Edits become the canonical persisted user input.
- No typed rejection API. Throwing is not a supported way to reject a prompt.
- Retry-safe but not exactly-once: retrying an already pending/delivered ID returns the original admission without rerunning hooks; concurrent submissions can run hooks more than once, but only the first successful admission wins.
- If you rewrite text, update or remove attachment `mention` offsets.

For LLMLingua, this is the wrong hook unless you explicitly want durable, lossy compression of user input.

### 3.3 Compaction

**[types]**

```ts
export interface SessionCompactionResult {
  summary: string
  /** `native.messages`, when set, must be a provider replacement window; it replays instead of `summary`. */
  native?: SessionMessage.Native
  metadata?: Record<string, unknown>
  tokens?: TokenUsage.Info
}

export interface SessionCompaction extends SessionContext {
  /** Set to use this compaction and skip the model request. */
  result?: SessionCompactionResult
}
```

**[docs]**

- `messages` is the transcript being summarized.
- OpenCode appends its summary prompt **after** the hook runs.
- Set `event.result` to record the compaction yourself and skip the model call. It takes the same fields as a completed compaction message.
- `result.native.messages`, when set, must be a provider replacement window; it replays instead of `result.summary`.
- `result.tokens` is optional token usage metadata.

Example:

```ts
await ctx.session.hook("compaction", async (event) => {
  event.result = { summary: await summarize(event.messages) }
})
```

### 3.4 Title and generate

**[types]**

```ts
export interface SessionGenerate extends SessionContext {}

export interface SessionTitle extends SessionRequest {
  /** Set to use this title and skip the model request. */
  result?: string
}
```

- `title` has no `agent` or `tools`. Set `event.result` to supply the title yourself. **[docs]**
- `generate` is a separate hook for `ctx.session.generate` calls. Use it to opt out of compression for auxiliary generation.

### 3.5 Model request, native HTTP, WebSocket, retry

**[types]**

```ts
export type SessionRequestKind = "primary" | "compaction" | "title" | "generate"

export interface SessionModelRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  baseURL?: string
  headers: Record<string, string>
}

export interface SessionHttpRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  request: Request
}

export interface SessionHttpResponse {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  readonly request: Request
  response: Response
}
```

- `model.request` is for model-level settings and headers, not message rewriting. **[docs]**
- `http.request` / `http.response` are the native provider exchange. Bodies are one-shot streams; clone or replace a body before reading it. **[docs]**
- Both HTTP hooks carry `kind`, which distinguishes `primary`, `compaction`, `title`, and `generate`. This is the only place a request kind is explicitly exposed. **[types][docs]**
- `experimental.ws.*` are experimental and may change. `handshake` runs once per model call before the session socket is selected; changing URL/headers reopens the socket. **[docs]**
- `retry` runs after failure classification and before scheduling. `attempt` is 1-based for the initial request; the first retry is attempt 2. **[docs]**

```ts
export type SessionRetryDecision =
  | { retry: false }
  | { retry: true; delay: number }

export interface SessionRetry {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly error: SessionError.Error
  readonly attempt: number
  decision: SessionRetryDecision
}
```

The built-in maximum attempt count remains a hard limit. **[docs]**

### 3.6 Session domain

**[types]**

```ts
export type SessionDomain = Pick<
  SessionApi,
  | "list" | "create" | "get" | "remove"
  | "switchAgent" | "switchModel" | "prompt"
  | "generate" | "command" | "compact" | "synthetic"
  | "interrupt" | "update" | "move" | "wait" | "context"
> & {
  readonly hook: ModelHooks<SessionHooks>
}
```

Relevant method shapes:

```ts
ctx.session.context({ sessionID })   // Promise<SessionMessageInfo[]>
ctx.session.compact({ sessionID })   // Promise<SessionInboxCompaction>
ctx.session.synthetic({ sessionID, text }) // Promise<SessionInboxSynthetic>
ctx.session.generate({ sessionID, prompt }) // Promise<{ text: string }>
ctx.session.get({ sessionID })       // Promise<SessionInfo>
```

## 4. Messages, system parts, and tool hooks

### 4.1 AI `Message` is a class, not a `parts` object

**[types]** `@opencode/ai/dist/schema/messages.d.ts`:

```ts
export declare class Message {
  readonly id?: string
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content: ContentPart[]
  readonly metadata?: Record<string, unknown>
  readonly providerMetadata?: Record<string, Record<string, unknown>>
  readonly native?: Record<string, unknown>
}
```

This is a common API trap: the docs often say `Message[]`, but the actual field is `content`, not `parts`. There is no `message.parts`.

If you replace a message rather than mutating it, preserve `id`, `native`, `providerMetadata`, and all tool-call/tool-result IDs. Those fields carry provider replay state; dropping them can break provider-specific continuation.

Helpers exist:

```ts
Message.user(content)
Message.assistant(content)
Message.system(content)   // operator-authored instruction at this chronological point
Message.tool(result)
Message.make(input)
```

### 4.2 `ContentPart`

**[types]** The tagged union includes:

```ts
type ContentPart =
  | {
      type: "text"
      text: string
      cache?: CacheHint
      metadata?: Record<string, unknown>
      providerMetadata?: Record<string, Record<string, unknown>>
    }
  | {
      type: "media"
      media: Media.Asset
      filename?: string
      cache?: CacheHint
      metadata?: Record<string, unknown>
      providerMetadata?: Record<string, Record<string, unknown>>
    }
  | {
      type: "tool-call"
      id: string
      name: string
      namespace?: string
      input: unknown
      providerExecuted?: boolean
      cache?: CacheHint
      metadata?: Record<string, unknown>
      providerMetadata?: Record<string, Record<string, unknown>>
    }
  | {
      type: "tool-result"
      id: string
      name: string
      namespace?: string
      result: ToolResultValue
      providerExecuted?: boolean
      cache?: CacheHint
      metadata?: Record<string, unknown>
      providerMetadata?: Record<string, Record<string, unknown>>
    }
  | {
      type: "reasoning"
      text: string
      encrypted?: string
      cache?: CacheHint
      metadata?: Record<string, unknown>
      providerMetadata?: Record<string, Record<string, unknown>>
    }
  | {
      type: "compaction"
      provider: string
      id?: string
      encrypted?: string
      text?: string | null
    }
  | {
      type: "effort"
      effort?: ReasoningEffort
      previous?: ReasoningEffort
    }
```

`ToolResultValue` is itself tagged:

```ts
type ToolResultValue =
  | { type: "json"; value: unknown }
  | { type: "text"; value: unknown }
  | { type: "error"; value: unknown }
  | {
      type: "content"
      value: readonly (
        | { type: "text"; text: string }
        | { type: "file"; uri: string; mime: string; name?: string }
      )[]
    }
```

For LLMLingua, this matters: a tool result is not a plain string. You must descend into `result` and handle the `json` / `text` / `error` / `content` variants without breaking the `id`/`name` linkage.

### 4.3 `SystemPart`

**[types]**

```ts
export type SystemPart = {
  type: "text"
  text: string
  cache?: CacheHint
  metadata?: Record<string, unknown>
}
```

`CacheHint` is:

```ts
{
  type: "ephemeral" | "persistent"
  ttlSeconds?: number
}
```

`event.system.push({ type: "text", text: "..." })` is the documented way to add an instruction. **[docs]**

### 4.4 Tool hooks

**[types]** `dist/promise/tool.d.ts`:

```ts
interface ToolHooks {
  readonly "execute.before": {
    tool: string
    readonly sessionID: Session.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly id: Tool.CallID
    input: unknown
  }
  readonly "execute.after": {
    readonly tool: string
    readonly sessionID: Session.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly id: Tool.CallID
    readonly input: unknown
  } & (
    | { readonly status: "completed"; result: Tool.Result }
    | { readonly status: "error"; error: Tool.Error }
  )
}
```

`Tool.Result`:

```ts
interface Result {
  readonly output?: unknown
  readonly content?: string | ReadonlyArray<Content>
  readonly metadata?: Readonly<Record<string, any>>
}
```

`Tool.Content` is `{ type: "text"; text } | { type: "file"; uri; mime; name? }`.

Docs show replacing a completed result:

```ts
await ctx.tool.hook("execute.after", (event) => {
  if (event.status === "completed") {
    event.result = { ...event.result, metadata: { observed: true } }
  }
})
```

Whether that replacement is written to persisted history or only returned to the caller is **[open]** (see §10). If it persists, compressing tool output here could avoid recompression in `context`; if it does not, it provides no lasting benefit.

## 5. Compaction configuration and behavior

### 5.1 Config knobs

**[docs]** `/v2/docs/compaction`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": {
    "auto": true,
    "keep": { "tokens": 15000 },
    "buffer": 16000
  }
}
```

| Field | Default | Behavior |
| --- | ---: | --- |
| `auto` | `true` | Compact automatically near the context limit; recover once when a provider rejects a request as too long. Manual compaction always works. |
| `keep.tokens` | `15000` | Approximate recent conversation kept beside the summary. Larger values preserve more detail but leave less room for new work. |
| `buffer` | 15% of the limit, at least 16k | Tokens to keep free below the model's limit. Larger values start automatic compaction earlier. |

`keep.tokens` and `buffer` accept non-negative integers.

### 5.2 Summary flow

**[docs]**

- When a session approaches the model's context limit, OpenCode summarizes the entire current conversation.
- It keeps the most recent conversation, about `keep.tokens` by default, beside the summary so recent details remain exact.
- Sending the full conversation lets the summary request reuse the normal request's prompt cache where supported.
- Later compactions update the existing summary using the conversation since the checkpoint.
- The summary is structured for handoff: objective/requirements, decisions, completed/active work, blockers/next moves, relevant files.
- In the recent window, long tool output is shortened and attachment data is replaced by a short description.
- Earlier messages remain stored even when they are no longer sent to the model.

### 5.3 Native vs summary compaction

**[docs]**

```jsonc
{
  "providers": {
    "openai": {
      "settings": { "compaction": { "type": "native" } },
      "models": {
        "gpt-4.1": { "settings": { "compaction": { "type": "summary" } } }
      }
    }
  }
}
```

- `native` uses the provider's compaction endpoint; `summary` uses OpenCode's own summary.
- A model setting overrides the provider setting.
- Native support is currently OpenAI Responses models; support varies by deployment/model.
- An encrypted native checkpoint only works with the same provider and model. Switching models continues from the original conversation.
- If the provider rejects a native compaction as too long, OpenCode retries with a smaller request; it does not switch to summary.
- Compaction uses the session's model; there is no separate compaction model.

### 5.4 Manual compaction

**[docs]**

```ts
const item = await ctx.session.compact({ sessionID })
```

- Runs at the next safe point, before prompts that are still waiting.
- Requests made while one is pending merge into it.
- Works when `compaction.auto` is `false`.
- Passing an `id` makes an exact retry idempotent; reusing that ID for a different request returns a conflict.
- The response confirms acceptance, not completion. Follow `session.compaction.*` events for completion.

### 5.5 The compaction hook and auto-compaction ordering

This is the most important runtime detail for the "continuous compression instead of compaction" goal.

The 2.1.3 bundled runtime's `SessionRunner.runStep` does, in order: **[runtime]**

```ts
const context = load()                       // assembled conversation for this step
const compaction = await compact({
  reason: "auto",
  context,
})
if (compaction.status === "completed") continue

const request = await request.primary({
  session, agent, model, tools,
  system: context.system,
  messages: context.messages,
  // ...
})
```

`SessionCompaction.compact` gates auto-compaction on the context passed for that step (`context.model` here is the full runtime model info, not the hook's `Model.Ref`):

```ts
if (reason !== "manual" && !config.auto) return { status: "skipped" }
if (reason === "auto" && !aboveThreshold(context.model.limit, config.buffer)) {
  return { status: "skipped" }
}
```

The threshold uses OpenCode's internal token accounting: measured usage from the last matching assistant message when available, plus an estimate of the remaining `system + tools + messages`, compared against the model's input/context limit minus `buffer` (`limit.input ?? limit.context`). That estimator is not exposed to plugins.

The `context` hook is triggered later, inside `request.primary`. Therefore:

> **Compression in the `context` hook does not change the auto-compaction decision for that step.** The decision was already made against the context assembled for that step.

There is an indirect effect across steps: the next step's measured component comes from the previous assistant message's provider token usage, which reflects the compressed request. A compressed request can therefore lower measured usage and influence later thresholds. It does not make the current step's raw context disappear, and it is not a reliable way to prevent compaction.

This does not make compression useless: it lowers tokens sent per call, provider cost, and the chance of an overflow rejection. But it does **not** replace compaction, and it will not reliably delay the automatic threshold.

Options if the goal is to avoid compaction entirely:

1. Accept compaction and use LLMLingua to reduce cost between compactions.
2. Set `compaction.auto: false` and rely on compression. This is risky: a provider overflow can still trigger one compaction/retry. **[docs]**
3. Make some compression durable so the raw history itself is smaller:
   - `prompt` hook compresses user input permanently (lossy, visible, only user text).
   - `tool.execute.after` may persist compressed tool output if result replacement is persisted (unverified).
4. Use the `compaction` hook to compress the transcript before the summarizer, or to supply your own summary. This changes summary cost/quality, not the auto threshold.

Native compaction appears to bypass the `compaction` hook because it calls the provider's compaction endpoint instead of building OpenCode's summary request. This is a code-reading inference; see §10.

## 6. Token and context visibility

### 6.1 What the `context` event gives you

`event.model` is only:

```ts
{ id: Model.ID; providerID: Provider.ID; variant?: Model.VariantID }
```

It has no `limit`, no token counts, and no full model info. **[types]**

`event.options` starts empty and does not contain resolved settings. **[docs]**

There is **no token-usage field** on the `context` event. You must estimate or fetch it.

### 6.2 Model limits

`ctx.model.list()` returns a `ModelListOutput`, not a bare array:

```ts
const { data: models } = await ctx.model.list()
const info = models.find(
  (m) => m.providerID === event.model.providerID && m.id === event.model.id,
)
const contextLimit = info?.limit.context
const outputLimit = info?.limit.output
```

`Model.Info.limit` is:

```ts
{
  context: number
  input?: number
  output: number
}
```

Cache this lookup by provider/model; it is not something to fetch on every hook if you can avoid it.

### 6.3 Persisted token usage

`ctx.session.get({ sessionID })` returns `SessionInfo`, which has a session-level `tokens` object:

```ts
{
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}
```

`ctx.session.context({ sessionID })` returns `SessionMessageInfo[]` (persisted messages). Assistant messages have optional step-level `tokens` of the same shape. `SessionMessageInfo` is a union; narrow on `type === "assistant"`.

Uses:

- `SessionInfo.tokens` is a session-level total, not a per-step value; do not treat it as the current context size.
- The latest assistant step's `tokens` can indicate actual provider usage after a compressed request.
- `ctx.session.context()` returns the **raw persisted history**, not the outgoing compressed copy. It is useful for measuring savings and for debug, not for reading back your transient edits.

### 6.4 Practical estimation

Since the event has no token count and `Model.Ref` has no limit:

1. Fetch `limit.context` once via `ctx.model.list()`.
2. Estimate the outgoing prompt from `event.system`, `event.tools`, and `event.messages` using a tokenizer, or a cheap character heuristic.
3. Keep a safety buffer for output and provider overhead.
4. Optionally refresh actual usage from the latest assistant `tokens` after each response.

OpenCode's own internal estimator is not exported. Do not assume a plugin-side character heuristic matches it exactly.

## 7. V1 plugins in V2

**[docs]** `/v2/docs/build/plugins/migrate-v1` is unambiguous:

> V1 plugin implementations do not run in V2. Moving a file or renaming its config entry is not enough.

### 7.1 Config migration

V1:

```jsonc
{
  "plugin": [
    "opencode-example-plugin",
    ["./plugin/local.ts", { "enabled": true }]
  ]
}
```

V2:

```jsonc
{
  "plugins": [
    "opencode-example-plugin",
    {
      "package": "./plugin/local.ts",
      "options": { "enabled": true }
    }
  ]
}
```

### 7.2 Entrypoint migration

V1 returned one object containing tools and hooks:

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const ExamplePlugin: Plugin = async ({ directory, project, client }) => {
  return {
    // V1 tools and hooks
  }
}
```

V2 default-exports a definition and registers in `setup`:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: "Focus on correctness." })
    })
  },
})
```

### 7.3 Hook mapping

| V1 extension point | V2 API |
| --- | --- |
| `event` | `ctx.event.subscribe()` |
| `dispose` | cleanup function returned by `setup` |
| `config` | transforms on the affected domain |
| `tool` map | `ctx.tool.transform(...)` |
| `auth` | `ctx.integration.transform(...)` and integration APIs |
| `provider` | `ctx.provider.transform(...)` and `ctx.model.transform(...)` |
| `chat.message` | `ctx.session.hook("prompt", ...)` |
| `chat.params` | `ctx.session.hook("context", ...)` and edit `event.options` |
| `chat.headers` | `ctx.session.hook("model.request", ...)` or `"http.request"` |
| `permission.ask` | `ctx.permission.hook("evaluate", ...)` |
| `command.execute.before` | command transforms or the prompt hook, depending on intent |
| `tool.execute.before` | `ctx.tool.hook("execute.before", ...)` |
| `tool.execute.after` | `ctx.tool.hook("execute.after", ...)` |
| `shell.env` | `ctx.shell.hook("create.before", ...)` |
| `tool.definition` | `ctx.tool.transform(...)` |
| `experimental.chat.system.transform` | `ctx.session.hook("context", ...)` and edit `event.system` |
| `experimental.chat.messages.transform` | `ctx.session.hook("context", ...)` and edit `event.messages` |
| `experimental.session.compacting` | `ctx.session.hook("compaction", ...)` |

These are migration destinations, not always exact renames. In particular, V1 `chat.message` ran before durable admission; V2 `prompt` does too, while `context` runs immediately before an agent model request. **[docs]**

### 7.4 Dual V1/V2 package

A package can temporarily export both:

```ts
import { Plugin } from "@opencode/plugin"

export default {
  ...Plugin.define({
    id: "example",
    async setup(ctx) {
      // V2
    },
  }),
  async server() {
    return {
      // V1
    }
  },
}
```

V2 reads the default export's `id` and `setup()` (or `effect()`), ignoring `server()`. V1 reads `server()`. V1 object entrypoints are supported in OpenCode `1.18.29` and newer. **[docs]**

## 8. Minimal local-development plugin

### 8.1 Hook-only skeleton

This is intentionally small: it shows the correct hook, a cache, and a failure fallback. It does not implement LLMLingua itself.

```ts
// .opencode/plugins/llmlingua.ts
import { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"

const VERSION = "llmlingua-v1"
const RATE = 0.8
const MIN_CHARS = 2_000
const KEEP_RECENT_MESSAGES = 4

function cacheKey(text: string): string {
  const digest = createHash("sha256").update(text).digest("hex")
  return `${VERSION}:${RATE}:${digest}`
}

async function compress(text: string): Promise<string> {
  const response = await fetch("http://127.0.0.1:8765/compress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, rate: RATE }),
    signal: AbortSignal.timeout(2_000),
  })

  if (!response.ok) throw new Error(`LLMLingua HTTP ${response.status}`)
  const body = (await response.json()) as { text?: string }
  if (typeof body.text !== "string") throw new Error("LLMLingua response missing text")
  return body.text
}

export default Plugin.define({
  id: "llmlingua-context",
  async setup(ctx) {
    const cache = new Map<string, string>()

    await ctx.session.hook("context", async (event) => {
      // Keep the newest exchange verbatim; compress the stable older prefix.
      const compressUntil = Math.max(0, event.messages.length - KEEP_RECENT_MESSAGES)

      for (let index = 0; index < compressUntil; index++) {
        const message = event.messages[index]

        for (const part of message.content) {
          if (part.type !== "text" || part.text.length < MIN_CHARS) continue

          const key = cacheKey(part.text)
          let compressed = cache.get(key)

          if (compressed === undefined) {
            try {
              compressed = await compress(part.text)
              cache.set(key, compressed)
            } catch {
              // Compression is best-effort; never fail the model request.
              // Do not cache the fallback, so a later call can retry.
              compressed = part.text
            }
          }

          // TypeScript marks Message.content readonly; the runtime event is mutable.
          // The docs' mutable `context` event is the intended API here.
          ;(part as { text: string }).text = compressed
        }
      }
    })
  },
})
```

Notes on the skeleton:

- This only compresses `text` parts. In production, extend it to `tool-result` content, where most long context usually lives.
- The cache is unbounded. Add an LRU or size cap before using it on long sessions.
- The sidecar call is per cache miss. Batch multiple candidates in one request to reduce overhead.
- The hook catches compression failures and uses the original text. Do not let a sidecar outage break model requests.
- `KEEP_RECENT_MESSAGES = 4` is a placeholder. A token-budgeted recent window is better than a fixed message count.

### 8.2 Sidecar contract

A persistent Python process avoids paying model-load cost on every hook:

```text
POST http://127.0.0.1:8765/compress
{"text": "...", "rate": 0.8}

200 OK
{"text": "..."}
```

Production additions:

- batch endpoint for multiple texts
- health check at `setup`
- explicit request timeout
- concurrency limit
- graceful fallback to original text
- cleanup on plugin unload (kill child process, or leave an externally managed service alone)

### 8.3 Config

If the file lives under `.opencode/plugins/`, it is auto-discovered and no config entry is needed. If you put it elsewhere:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./.opencode/plugins/llmlingua.ts"]
}
```

If you use object options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./.opencode/plugins/llmlingua.ts",
      "options": { "rate": 0.8 }
    }
  ]
}
```

Read them with `ctx.options.rate`. **[docs]**

## 9. Implications for LLMLingua compression

### 9.1 Hook point: `context`, not `prompt` or `http.request`

Use `ctx.session.hook("context", ...)`.

Why:

- It is semantic and provider-agnostic: `system`, `messages`, `tools`, `options`.
- It runs on every agent-loop model request, including tool continuations, which is where context grows.
- Edits are transient, so the user's history and UI remain intact.
- It is late enough to see the final assembled context, but early enough to change what the model receives.

Do not use `prompt` for LLMLingua unless you want durable, lossy compression of user input. It runs once at admission, persists edits, and cannot see tool output or later history. Do not use `http.request` unless you deliberately want provider-specific body surgery; it is brittle and bypasses the semantic `Message` model.

### 9.2 Per-call, not per-turn

`context` fires once per model call, not once per user turn. A tool-heavy turn may trigger 5-20 calls. That is both the opportunity (compress the growing prompt) and the risk (recompress the same old text repeatedly).

The practical model is:

```text
user turn
  model call 1: history + user prompt
  model call 2: history + user prompt + assistant tool call + tool result
  model call 3: ... more tool results ...
  ...
```

Only the tail changes. The old prefix is stable and should be compressed once, then served from cache.

### 9.3 Persistence: cache the output, not the message

Because `context` mutations are transient:

- The next call's `event.messages` contains the original text again.
- A cache keyed by original content is the only way to avoid recomputation.
- Do not store a reference to a mutated `Message` and expect it to survive; messages are rebuilt.

Recommended cache key:

```text
plugin-version : compression-settings : model-scope? : sha256(original text)
```

Include:

- LLMLingua model/version
- rate / target ratio
- any prompt template or language setting
- optionally provider/model if the target rate depends on context limit

If the key changes, old entries are simply unused; an LRU will evict them.

### 9.4 Avoiding recompression every step

Concrete strategy:

1. **Content-hash cache.** Compute `sha256(original text)`; store compressed text in an in-memory `Map` or LRU. Cache hits are synchronous and cheap. If `Message.id` proves stable across calls, use it as a fast lookup; still include a content hash so an edited/reused ID cannot return stale output. For structured tool results, hash a canonical serialization, not an object whose key order may change.
2. **Stable prefix only.** Walk messages from newest to oldest and preserve a recent token/character budget verbatim. Compress only messages before that boundary. The prefix is stable across tool continuations.
3. **Per-message or fixed-chunk compression.** Compressing one giant rolling window invalidates the cache whenever the window shifts. Compress individual messages, or fixed chunks of messages, so appends do not change old keys.
4. **Batch cache misses.** One sidecar request with all new texts per model call, not one request per part.
5. **Deduplicate in-flight work.** Keep `Map<key, Promise<string>>` so concurrent hooks for the same text share one compression.
6. **Deterministic output.** Use deterministic decoding/settings where possible. If LLMLingua is stochastic, the cache still makes repeated calls stable, but cold starts and evictions will change the prompt and can break provider prompt caching.
7. **Optional durable cache.** `ctx.storage` is plugin-scoped JSON KV:
   ```ts
   await ctx.storage.set(`llmlingua:${key}`, compressed)
   const hit = await ctx.storage.get(`llmlingua:${key}`)
   ```
   Use it for cold-start persistence, but do not block every hook on disk I/O. In-memory LRU first; persist asynchronously.
8. **Prune after compaction.** When history is replaced by a summary, old cache entries are dead weight. Listen for `session.compaction.*` events or evict by LRU.

Do **not** rely on writing a marker into `part.metadata` to detect "already compressed". The mutation is transient, so the marker disappears on the next call.

### 9.5 Compaction still happens

This is the main design constraint, repeated because it is easy to miss:

- In 2.1.3, `runStep` calls auto-compaction before `request.primary` (which triggers the `context` hook).
- The auto gate compares the context assembled for that step to the model's input/context limit minus `buffer`.
- Therefore, `context`-hook compression cannot change that step's automatic decision.
- A compressed request can lower the previous assistant message's measured token usage, which feeds the next step's token accounting. That can influence future thresholds indirectly, but it is not a reliable way to prevent compaction.
- `compaction.auto: false` disables the automatic threshold, but overflow recovery can still compact once and retry.
- Native compaction uses a provider endpoint and likely bypasses the `compaction` hook.

If the product goal is "continuous LLMLingua compression instead of compaction", the design needs an explicit answer:

| Approach | Effect | Trade-off |
| --- | --- | --- |
| Compress only in `context` | Lower per-call tokens/cost; compaction still triggers at that step's threshold | Safe, transient, but does not replace compaction |
| Disable `compaction.auto` | No automatic threshold; relies on compression to stay under limit | Overflow still compacts once; risk of provider rejection/latency |
| Compress durable user input in `prompt` | Reduces raw history for user text | Lossy, visible, permanent; only user text |
| Compress durable tool output in `execute.after` | Reduces raw history for tool results | Persistence unverified; lossy; breaks raw history |
| Use `compaction` hook | Cheaper/better summaries; optional custom summary | Does not change threshold; native path may bypass |

A realistic design is probably: transient LLMLingua compression in `context` for cost, plus normal compaction for hard context limits. Do not promise "no compaction" unless you also change durable history or disable auto and accept overflow behavior.

### 9.6 Selective compression policy

LLMLingua drops tokens. That is dangerous for exact identifiers. Suggested policy:

| Content | Compress? | Reason |
| --- | --- | --- |
| System prompt / instructions (`event.system`, or a `Message` with role `system`) | No by default; if compressed, do it once and cache | Instructions are critical; changing them breaks prefix caching and can change behavior |
| Tool descriptions / JSON schemas (`event.tools`) | No by default; protect property names if you do | Tool calls and validation depend on exact schema |
| Latest user message | No | Preserve intent and exact wording |
| Older user prose | Yes | Usually high-volume, low exactness |
| Assistant prose | Maybe | Preserve decisions, plans, code, and exact names |
| Assistant reasoning | No | Often provider-specific/encrypted; may be required for replay |
| Tool-call `input` | No | Exact arguments, IDs, and paths matter |
| Tool-result `text` / `content` text | Yes, carefully | Usually the bulk of long context |
| Tool-result `json` / structured data | No or field-selective | Schema and exact values matter |
| Code, diffs, logs, stack traces | No or conservative rate | Identifiers, line numbers, and punctuation matter |
| Errors | No | Exact diagnostics matter |
| Media/file parts | No | Not text; dropping breaks attachments |
| `compaction` parts | No | Provider checkpoint; opaque/encrypted |
| Recent window | No | Preserve exact recent details, mirroring `keep.tokens` |

Also:

- Preserve `tool-call` / `tool-result` pairing. If you drop a result, do not leave an orphan call; if you drop a call, remove its result.
- Do not change `id` or `name` on tool parts.
- Use a conservative rate (less compression) for code-heavy sessions; evaluate on real transcripts.
- Protect negations, numbers, file paths, URLs, and quoted strings if your compressor supports token protection.

### 9.7 Latency and failure isolation

The hook blocks model dispatch. A sidecar call is on the critical path.

Recommendations:

- Keep the Python process warm; start it at `setup` or manage it externally.
- Batch all cache misses into one request per model call.
- Set an explicit timeout (the skeleton uses 2 s; tune it).
- On timeout/error, use the original text and continue. Never throw from the hook.
- Log cache hit rate and compression latency; a slow sidecar can dominate turn latency.
- Handle concurrent sessions: the sidecar must process parallel requests or the plugin must serialize with a queue.
- Clean up child processes/sockets in the cleanup function returned from `setup`.

### 9.8 Token budget and prompt caching

- Use `ctx.model.list()` once per model to get `limit.context`, `limit.input`, and `limit.output`.
- Budget roughly `(limit.input ?? limit.context) - limit.output - safetyBuffer` for input. The plugin cannot know the exact token count; leave headroom.
- `compaction.buffer` is OpenCode's safety margin for auto-compaction; your own compression budget should be at least as conservative.
- Keep the compressed prefix stable. Provider prompt caching rewards identical prefixes; recompressing the same text differently on every call can turn cache hits into cache misses.
- Cache key should include compression settings so a config change does not silently reuse old output.

### 9.9 What not to do

- Do not compress in `prompt` and call it "transient"; it persists.
- Do not mutate persisted history or assume `context` edits are saved.
- Do not recompress the entire history on every model call without a cache.
- Do not assume compression prevents auto-compaction.
- Do not compress tool-call IDs, structured JSON, code, paths, or errors without a protection policy.
- Do not let the sidecar failure fail the model request.
- Do not depend on V1 hooks; they do not run in V2.

### 9.10 Recommended spike

For the first implementation, keep the scope narrow and measurable:

1. Register only `context`.
2. Compress only `text` parts in messages older than a recent window; leave `event.system`, tools, tool calls, code, and structured data alone.
3. Use a content-hash LRU and a persistent Python sidecar with a hard timeout.
4. Batch cache misses; fall back to the original text on any error.
5. Leave `compaction.auto` at its default. Measure token savings, cache hit rate, latency, and compaction frequency.
6. Only after those numbers are in, decide whether durable compression (`prompt` / `tool.execute.after`) or custom compaction is worth the lossiness.

This sequence validates the hook mechanics and the economics before committing to a policy that permanently discards context.

## 10. Open questions and verification checklist

These are the things that were not fully settled by types/docs and should be tested against the target OpenCode build.

| # | Question | Current evidence | How to settle |
| ---: | --- | --- | --- |
| 1 | Is `Message.id` populated on outgoing messages, and is it stable across calls? | Type is optional; docs do not say. | Log `event.messages.map(m => ({ id: m.id, role: m.role }))` across three calls. If absent, use content hash. |
| 2 | Can nested `content[].text` be mutated in place? | Docs say edit `event.messages`; Plan plugin mutates the messages array, not a nested part. | Mutate a text part; inspect the outgoing body via `http.request` or provider logs. |
| 3 | Are async `context` hooks awaited before dispatch? | Types allow `Promise`; 2.1.3 runtime wraps in `Promise.resolve` and awaits; docs silent. | Add a 2 s delay; measure request start time. |
| 4 | What happens if a `context` hook throws? | Not documented. | Throw once; observe whether the request fails, retries, or falls back. |
| 5 | Does mutating `tool.execute.after` `event.result` persist to history? | Docs show replacement; persistence not stated. | Replace result with a marker; read `session.context` afterward. |
| 6 | Is `ctx.session.context()` safe inside a `context` hook? | API exists; no docs. | Call it; check for deadlock, recursion, or extra latency. |
| 7 | Does auto-compaction use raw or compressed token counts? | Current step: the context assembled for that step, before the `context` hook. Later steps can use measured usage from the previous (possibly compressed) assistant message. | Compress heavily; log thresholds across several steps with and without compression. |
| 8 | Does native compaction run the `compaction` hook? | Code suggests the provider path bypasses the summary request; docs silent. | Configure `type: "native"`; log hook invocations. |
| 9 | Do `context` hooks run for subagent sessions? | Hook is session-wide; likely yes. | Spawn a subagent; log `sessionID`/`agent` from the hook. |
| 10 | What is `ctx.storage` scope: plugin, location, or session? | Docs say plugin-scoped JSON KV; location scope unclear. | Write in one project; read in another; inspect keys. |
| 11 | Does `ctx.model.list()` include disabled/unavailable models? | Type returns `Model.Info[]`; semantics not documented. | Compare with `opencode models` output. |
| 12 | Does heavy compression reduce `maxTokens` because of pre-hook input accounting? | 2.1.3 passes a pre-hook `inputTokens` estimate into `request.primary`; exact clamp order not traced. | Log outgoing `max_tokens` with and without compression. |

Two quick instrumentation ideas:

```ts
await ctx.session.hook("context", (event) => {
  console.log("context", {
    sessionID: event.sessionID,
    agent: event.agent,
    model: event.model,
    messages: event.messages.length,
    system: event.system.length,
    tools: Object.keys(event.tools).length,
  })
})
```

```ts
await ctx.session.hook("http.request", async (event) => {
  // If you need to inspect the native body, clone it first:
  const clone = event.request.clone()
  console.log(await clone.text())
})
```

The second snippet is only for debugging; `http.request` bodies are one-shot streams, and `http.request` is not the right layer for normal compression.

## 11. Sources

### Docs

- Plugins overview: <https://opencode.ai/v2/docs/build/plugins>
- Plugin loading/config: <https://opencode.ai/v2/docs/plugins>
- V1 → V2 migration: <https://opencode.ai/v2/docs/build/plugins/migrate-v1>
- Compaction: <https://opencode.ai/v2/docs/compaction>
- Configuration: <https://opencode.ai/v2/docs/config>
- API reference: <https://opencode.ai/v2/docs/api>
- Effect plugins: <https://opencode.ai/v2/docs/build/plugins/effect>

### Packages

- `@opencode/plugin@2.1.3`: <https://www.npmjs.com/package/@opencode/plugin/v/2.1.3>
- `@opencode/ai@2.1.3`: <https://www.npmjs.com/package/@opencode/ai/v/2.1.3>
- `@opencode/schema@2.1.3`: <https://www.npmjs.com/package/@opencode/schema/v/2.1.3>
- `@opencode/client@2.1.3`: <https://www.npmjs.com/package/@opencode/client/v/2.1.3>

### Exact declaration files

From `@opencode/plugin@2.1.3`:

- `dist/promise/plugin.d.ts` — `Plugin`, `Context`, `define`
- `dist/promise/registration.d.ts` — `Hooks`, `ModelHooks`, `Registration`, `ModelHookOptions`
- `dist/promise/session.d.ts` — `SessionHooks`, `SessionContext`, `SessionCompaction`, `SessionPrompt`, `SessionDomain`
- `dist/promise/tool.d.ts` — `ToolHooks`, `ToolDomain`
- `dist/promise/storage.d.ts` — `StorageDomain`
- `dist/effect/plugin.d.ts` — Effect `Plugin`

From `@opencode/ai@2.1.3`:

- `dist/schema/messages.d.ts` — `Message`, `ContentPart`, `SystemPart`, `ToolResultValue`

From `@opencode/schema@2.1.3`:

- `dist/config/compaction.d.ts` — `ConfigCompaction.Info`
- `dist/session-message.d.ts` — `SessionMessage.Native`, assistant `tokens`
- `dist/session.d.ts` — `Session.Info.tokens`
- `dist/model.d.ts` — `Model.Ref`, `Model.Info.limit`
- `dist/tool.d.ts` — `Tool.Result`, `Tool.Content`, `Tool.Error`
- `dist/prompt-input.d.ts` — `PromptInput.Prompt`

From `@opencode/client@2.1.3`:

- `dist/promise/client.d.ts` — `SessionApi.context/compact/generate/get/...`, `ModelApi.list`
- `dist/promise/generated/types.d.ts` — generated input/output shapes

Runtime evidence:

- `/opt/homebrew/Cellar/opencode-v2/2.1.3/bin/opencode` — bundled JavaScript used to inspect hook dispatch, message mutation, and auto-compaction ordering.
