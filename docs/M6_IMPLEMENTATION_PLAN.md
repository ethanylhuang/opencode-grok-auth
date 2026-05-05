# M6 Architect Artifact -- OpenCode Plugin and Provider Integration

## Problem Restatement
M6 starts after M5 has made the local proxy response protocol correct for OpenCode. The proxy must already emit OpenAI/OpenCode-compatible text, reasoning, non-streaming responses, streaming tool calls, non-streaming tool calls, structured errors, and tool-result continuations. M6 must not reimplement that protocol layer.

M6 integrates the already-correct endpoint into OpenCode as a first-class local provider and plugin. The user experience after M6 is: start the local Grok bridge, ensure Chrome/Grok is warm, run OpenCode, select `grok/grok-latest`, and use Grok through OpenCode with correct session identity and tool-call loops.

---

## STARTING CONTRACT
Before editing M6, the implementing agent must verify the M5 baseline using terminal output:

1. `docs/M5_IMPLEMENTATION_PLAN.md` exists and matches the protocol/tool-call scope.
2. `docs/M5_COMPLETION_AUDIT.md` exists and says M5 is complete.
3. `npm run verify-m5` passes.
4. `npm run build` passes.
5. `/v1/models` exposes `grok-latest` and does not expose `grok-latest-new`.
6. The proxy already supports:
   - streaming assistant text
   - non-streaming assistant text
   - `delta.reasoning_content`
   - streaming `delta.tool_calls`
   - non-streaming `message.tool_calls`
   - tool-result continuation
   - OpenAI-style errors
7. The Chrome extension remains the authenticated transport. M6 must not revive cookie scraping, headless automation, or raw cookie replay.

If any M5 item is missing, stop M6 and finish M5 first.

---

## ASSUMPTIONS
1. Local OpenCode and `@opencode-ai/plugin` versions must be verified from terminal output before implementation.
2. The local installed type definitions are authoritative:
   - `node_modules/@opencode-ai/plugin/dist/index.d.ts`
   - any installed OpenCode SDK type files actually referenced by the plugin.
3. Provider id is `grok`.
4. Model id is `grok-latest`.
5. Model selector id is `grok/grok-latest`.
6. Provider display name is `Grok Browser Bridge`.
7. Model display name is `Grok Latest (Browser Bridge)`.
8. `grok-latest-new` remains internal and must not appear in OpenCode model selection.
9. OpenCode uses an OpenAI-compatible provider transport pointed at `http://127.0.0.1:11434/v1`.
10. The plugin's job is identity propagation and optional local setup convenience. It must not proxy requests or parse responses.
11. Real OpenCode CLI commands may touch user-level state. If user state is broken or locked, use an isolated `HOME` under `/private/tmp` for automated evidence.

---

## IN_SCOPE
- `src/index.ts` -- Replace placeholder plugin code with a typed minimal OpenCode plugin:
  - Use only verified local `@opencode-ai/plugin` hooks.
  - Add bridge headers only for provider `grok` and model `grok-latest`.
  - Add `X-Grok-Bridge-Id: opencode-plugin`.
  - Add `X-Grok-OpenCode-Session-Id` when OpenCode exposes a stable session id.
  - Add `X-Grok-OpenCode-Message-Id` when OpenCode exposes a stable message id.
  - Do not register a mismatched fake provider such as `grok-bridge`.
  - Do not parse or transform response content.
- `src/proxy.ts` -- Add only the proxy support required by plugin identity:
  - Read OpenCode session/message headers.
  - Map OpenCode session ids to Grok `conversationId` and `parentResponseId` state.
  - Use `/new` routing for first request in a new OpenCode session.
  - Continue stored Grok conversations for later requests in the same OpenCode session.
  - Expose session count and freshness in `/health` without prompt or secret leakage.
  - Preserve direct web UI/body-based continuation from M3-M5.
- `opencode.json` -- Canonical provider/model config:
  - Provider id `grok`.
  - Provider name `Grok Browser Bridge`.
  - Base URL `http://127.0.0.1:11434/v1`.
  - Dummy local API key only if required by OpenAI-compatible transport.
  - Model id `grok-latest`.
  - Model name `Grok Latest (Browser Bridge)`.
  - Tool capability enabled only because M5 already proved tool-call protocol correctness.
  - No exposed `grok-latest-new`.
- `.opencode/opencode.json` or setup support -- Provide a local plugin registration path:
  - Prefer a script that writes local ignored config with an absolute `file://` plugin path.
  - Do not overwrite unrelated user config silently.
- `scripts/setup-opencode-local.ts` -- Optional but preferred local setup helper:
  - Writes or prints the minimal config needed to load this repo plugin.
  - Supports dry-run.
  - Avoids modifying global user config by default.
- `scripts/test-opencode-config.ts` -- Validate config and model metadata.
- `scripts/test-opencode-plugin-load.ts` -- Unit-test plugin hook behavior against verified hook shapes.
- `scripts/test-opencode-capture.ts` -- Run real `opencode run` against a local capture server and prove headers/config are resolved.
- `scripts/test-opencode-session.ts` -- Fake-worker test proving OpenCode session headers isolate Grok conversations.
- `scripts/test-opencode-e2e.ts` -- Real OpenCode CLI plus fake worker proving plain chat and tool-call loop reach the proxy.
- `docs/OPENCODE_SETUP.md` -- Operator instructions for the final workflow.
- `docs/M6_COMPLETION_AUDIT.md` -- Final evidence mapping.
- `artifacts/` -- Sanitized M6 evidence files.

---

## OUT_OF_SCOPE
- Rewriting M5 response protocol, tool-call parsing, or web UI protocol lab behavior.
- Adding new Grok tool-call semantics beyond the M5 envelope protocol.
- OpenCode core changes.
- Publishing packages or extensions.
- Global OpenCode install automation.
- Headless browser automation, cookie database scraping, or raw cookie replay.
- Remote, LAN, or multi-user hosting.
- Attachment/image/audio/PDF support.
- Persisting prompt bodies, tool outputs, request templates, cookies, or auth headers by default.

---

## ARCHITECTURE & DESIGN

### Final Component Contract
1. OpenCode resolves provider `grok` and model `grok-latest` from config.
2. OpenCode sends OpenAI-compatible chat requests to `http://127.0.0.1:11434/v1/chat/completions`.
3. The plugin adds local identity headers for `grok/grok-latest` only.
4. The proxy maps the OpenCode session id to Grok conversation routing.
5. The already-M5-compliant proxy response streams back to OpenCode.
6. OpenCode handles plain text and tool calls using the response protocol implemented in M5.

### Provider / Model Contract
The final config must resolve to:

```text
provider id: grok
provider name: Grok Browser Bridge
model id: grok-latest
selector id: grok/grok-latest
model display name: Grok Latest (Browser Bridge)
base URL: http://127.0.0.1:11434/v1
tool calls: true
attachments: false
reasoning: false unless OpenCode-specific reasoning UI is verified
```

Rules:
1. `grok-latest-new` must not be in OpenCode config.
2. `/v1/models` must expose every OpenCode-configured model and no internal routing model.
3. Provider ids in `src/index.ts`, `opencode.json`, tests, and docs must match exactly.

### Plugin Header Contract
For `grok/grok-latest`, add:

```text
X-Grok-Bridge-Id: opencode-plugin
X-Grok-OpenCode-Session-Id: <OpenCode session id>
X-Grok-OpenCode-Message-Id: <OpenCode message id when available>
```

Rules:
1. Add headers only when provider id is `grok` and model id is `grok-latest`.
2. Do not add headers for OpenAI, Anthropic, Groq, local models, or unrelated providers.
3. Do not log message content.
4. Do not add cookies or auth secrets.
5. If OpenCode does not expose a message id, omit that header rather than guessing.
6. If OpenCode does not expose a session id, M6 must fail the plugin acceptance gate or use a verified stable fallback from OpenCode context. Do not invent unstable ids.

### OpenCode Session Store
M6 extends proxy routing with OpenCode headers:

```typescript
type OpenCodeSessionState = {
  sessionId: string;
  conversationId: string | null;
  parentResponseId: string | null;
  model: string;
  createdAt: number;
  updatedAt: number;
  lastOpenCodeMessageId: string | null;
};
```

Rules:
1. Store routing metadata only.
2. Do not store prompts, tool outputs, cookies, auth headers, or request templates.
3. First request in a new OpenCode session uses the `/new` template path.
4. Later requests in the same OpenCode session use stored `conversationId` and `parentResponseId`.
5. If a continuation request has no stored Grok metadata, fail clearly instead of falling back to a stale captured conversation.
6. TTL is controlled by `GROK_OPENCODE_SESSION_TTL_MS`, default 24 hours.
7. `/health` may expose session count, TTL, and last update age, not content.

### Relationship to M5 Tool Calls
M6 does not parse tool envelopes. It proves OpenCode can consume M5 tool calls:
1. OpenCode sends `tools[]` to the local provider.
2. Proxy/M5 emits `tool_calls`.
3. OpenCode executes a harmless tool in an isolated temp project.
4. OpenCode sends tool results back.
5. Proxy/M5 converts tool results to Grok continuation.
6. Session mapping from M6 keeps the tool loop in the same Grok conversation.

If tool-call chunks are malformed, fix M5, not the plugin.

---

## EXACT REQUIREMENTS

### Functional Requirements
1. `opencode models grok --verbose` lists `grok/grok-latest`.
2. The listed provider name is `Grok Browser Bridge`.
3. The listed model name is `Grok Latest (Browser Bridge)`.
4. OpenCode TUI can select `grok/grok-latest`.
5. `opencode run -m grok/grok-latest --format json "Reply with OK only."` sends a request to the local proxy or capture server.
6. Plugin headers are present for `grok/grok-latest`.
7. Plugin headers are absent for unrelated providers/models.
8. OpenCode session A and session B map to distinct Grok conversations.
9. Repeated turns in session A continue session A's Grok conversation.
10. OpenCode tool-call loop reaches the proxy and returns a final answer using M5 protocol.
11. Direct web UI requests without OpenCode headers still work.
12. Missing extension, cold bridge, missing `/new` template, plugin not loaded, provider mismatch, and OpenCode state errors fail with actionable messages.

### Non-Functional Requirements
1. Plugin code is small, typed, and tied to verified local SDK hooks.
2. No raw cookies, auth headers, request templates, prompt bodies, or tool outputs are persisted by default.
3. User-level OpenCode config is not overwritten silently.
4. Automated E2E uses isolated temp home/project when modifying OpenCode state.
5. M2-M5 tests remain green.
6. Evidence artifacts are sanitized and reproducible.

---

## IMPLEMENTATION STEPS

### Step 0 -- Runtime Preflight
Run before editing:

```bash
pwd
git status --short
opencode --version
opencode debug paths
sed -n '1,220p' node_modules/@opencode-ai/plugin/dist/index.d.ts
npm run build
npm run verify-m5
```

If OpenCode user state fails with readonly database, WAL, checkpoint, or lock errors, use:

```bash
mkdir -p /private/tmp/opencode-grok-m6-home
env HOME=/private/tmp/opencode-grok-m6-home opencode debug paths
env HOME=/private/tmp/opencode-grok-m6-home opencode debug config
```

Record preflight evidence in `artifacts/m6-preflight.json`.

### Step 1 -- Canonicalize Config
1. Read existing `opencode.json`.
2. Set provider id/name/base URL exactly.
3. Set model id/name exactly.
4. Enable tool capability only if M5 verifier passes.
5. Hide `grok-latest-new`.
6. Add or update config validation script.
7. Prove `opencode debug config` resolves expected provider/model.

### Step 2 -- Implement Minimal Plugin
1. Remove unused imports and fake provider declarations from `src/index.ts`.
2. Implement only verified hooks.
3. Add scoped headers for `grok/grok-latest`.
4. Add tests for positive and negative header gating.
5. Do not parse request body or response body in the plugin.

### Step 3 -- Add OpenCode Session Routing
1. Parse plugin session/message headers in `src/proxy.ts`.
2. Add in-memory session store and TTL pruning.
3. Route first OpenCode session turn through `/new`.
4. Route continuation turns through stored metadata.
5. Update session metadata from Grok response metadata.
6. Preserve existing body-based web UI continuation behavior.
7. Add health summary fields.

### Step 4 -- Local Setup Helper
1. Add `scripts/setup-opencode-local.ts` if needed.
2. Support dry-run by default.
3. Write only project-local `.opencode/opencode.json` unless explicitly told otherwise.
4. Print exact file path and diff before writing.
5. Document manual equivalent in `docs/OPENCODE_SETUP.md`.

### Step 5 -- Capture and E2E Tests
1. `test-opencode-config` validates config and `/v1/models`.
2. `test-opencode-plugin-load` validates hook behavior directly.
3. `test-opencode-capture` starts a capture server and runs real `opencode run`.
4. `test-opencode-session` uses fake worker responses to prove header-based session isolation.
5. `test-opencode-e2e` runs real OpenCode against a fake-worker proxy for:
   - plain chat
   - tool-call loop
   - isolated sessions

### Step 6 -- Live Smoke
After automated tests:
1. Start proxy.
2. Ensure Chrome extension is loaded and `/health` has `requestReady: true`.
3. Run:

```bash
opencode run -m grok/grok-latest --format json "Reply with exactly: M6 live smoke OK"
```

4. Save sanitized output to `artifacts/m6-live-opencode-smoke.jsonl`.
5. Save health to `artifacts/m6-live-health.json`.

### Step 7 -- Operator Docs
Update `docs/OPENCODE_SETUP.md` with:
1. Build command.
2. Local plugin setup.
3. Proxy start command.
4. Chrome extension load/warm-up instructions.
5. Expected `/health` values.
6. `opencode models grok --verbose` expected output.
7. TUI model selector steps.
8. CLI smoke command.
9. Tool-call expectations.
10. Common failures and fixes.

### Step 8 -- Completion Audit
Create `docs/M6_COMPLETION_AUDIT.md` mapping every exact requirement to:
1. Source file evidence.
2. Command output.
3. Artifact path.
4. Any residual risk.

---

## VERIFICATION / SUCCESS CRITERIA

### Mandatory Commands
Run from repo root:

```bash
npm run build
npm run test-bridge
GROK_FAST_PATH=0 npm run test-bridge
npm run test-new-conversation
npm run test-extension-routing
npm run test-chat-history-ui
npm run verify-m5
npm run test-opencode-config
npm run test-opencode-plugin-load
npm run test-opencode-capture
npm run test-opencode-session
npm run test-opencode-e2e
```

### Manual / Live Evidence
1. `opencode models grok --verbose` shows `grok/grok-latest`.
2. OpenCode TUI can select `grok/grok-latest`.
3. Live `opencode run -m grok/grok-latest --format json "Reply with exactly: M6 live smoke OK"` succeeds.
4. `/health` shows current extension readiness and non-secret OpenCode session summary.
5. Two OpenCode sessions have distinct Grok `conversationId` values.
6. One OpenCode tool-call loop completes against the M5 response protocol.

### Required Artifacts
- `artifacts/m6-preflight.json`
- `artifacts/m6-opencode-debug-config.json`
- `artifacts/m6-opencode-models-grok.txt`
- `artifacts/m6-opencode-capture-request.json`
- `artifacts/m6-opencode-session-isolation.json`
- `artifacts/m6-opencode-run-basic.jsonl`
- `artifacts/m6-opencode-run-tool-loop.jsonl`
- `artifacts/m6-live-opencode-smoke.jsonl`
- `artifacts/m6-live-health.json`
- `docs/M6_COMPLETION_AUDIT.md`

### Acceptance Gate
M6 is complete only when:
1. M5 verifier remains green.
2. OpenCode discovers `grok/grok-latest`.
3. The plugin is loaded by real OpenCode and adds scoped headers.
4. The proxy maps OpenCode sessions to isolated Grok conversations.
5. OpenCode receives valid M5-format text and tool-call responses without plugin-side response fixes.
6. Live smoke passes through the actual Chrome/Grok bridge.
7. No new committed source, logs, docs, or artifacts leak auth secrets, request templates, prompt bodies, or non-test tool outputs.
