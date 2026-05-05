# M5 Architect Artifact -- OpenCode-Compatible Grok Responses and Tool Calls

## Problem Restatement
M4 made the browser bridge fast enough and fixed the current new-chat routing model: first turns prefer the captured `/new` Grok template, later turns continue with `conversationId` and `parentResponseId`, and reasoning/progress text can stream separately as `delta.reasoning_content`.

M5 must make the local proxy itself produce responses that OpenCode can consume without special plugin-side response handling. The milestone owns OpenAI/OpenCode-compatible chat completion semantics at the proxy boundary, including streaming chunks, non-streaming responses, reasoning separation, metadata, structured errors, and tool calls. M5 is still verified from the web UI and local scripts, not by implementing the OpenCode plugin.

---

## ASSUMPTIONS
1. The authenticated transport remains the Chrome extension and Grok web backend introduced in M2-M4.
2. The proxy endpoint remains `http://127.0.0.1:11434/v1/chat/completions`.
3. OpenCode will access this endpoint later through an OpenAI-compatible provider, so M5 must match OpenAI chat completion shapes closely enough for `@ai-sdk/openai-compatible`.
4. M5 does not implement OpenCode plugin loading, provider registration, TUI model selection, or OpenCode session headers. Those are M6.
5. Web UI chat sessions remain the verification surface for live manual behavior. They already store `conversationId` and `parentResponseId`; M5 may extend them with tool-call state.
6. `grok-latest-new` is an internal demo/proxy routing value. It may remain usable in the web UI, but it must not be required for OpenCode-facing behavior.
7. Grok web does not expose a verified native OpenAI function-calling API. Tool calls are implemented through a deterministic text envelope that the proxy converts into OpenAI-compatible `tool_calls`.
8. New code must not persist cookies, auth headers, raw request templates, raw prompts, or tool outputs outside explicit sanitized test artifacts.

---

## IN_SCOPE
- `src/proxy.ts` -- Implement OpenCode-compatible chat protocol behavior:
  - Normalize OpenAI chat messages into the existing Grok prompt path while preserving current M4 new-chat and continuation routing.
  - Support streaming and non-streaming chat completions.
  - Emit OpenAI-compatible fields: `id`, `object`, `created`, `model`, `choices`, `delta`, `message`, `finish_reason`, and final `[DONE]` in streaming mode.
  - Preserve `delta.reasoning_content` for Grok thinking/progress text without mixing it into final assistant content.
  - Parse `tools`, `tool_choice`, `parallel_tool_calls`, assistant `tool_calls`, and `tool` role messages.
  - Convert Grok tool envelopes into OpenAI-compatible `tool_calls`.
  - Convert tool result messages into a Grok continuation prompt.
  - Keep `/v1/models` aligned with the OpenCode-facing model set and do not expose `grok-latest-new`.
  - Return structured OpenAI-style errors for invalid payloads and malformed tool envelopes.
- `web/index.html` -- Extend the demo UI into a protocol verification surface:
  - Keep current chat history/new-chat behavior.
  - Add a compact "Protocol" or "Tools" panel that can send `tools[]`, `tool_choice`, `parallel_tool_calls`, and stream/non-stream toggles.
  - Render assistant content, reasoning, tool-call deltas, final tool-call objects, finish reasons, and raw protocol diagnostics separately.
  - Add browser-local mock tool execution for at least one harmless tool so the UI can demonstrate tool-result continuation without OpenCode.
  - Keep visible readiness/prewarm and timing diagnostics from M4.
- `scripts/test-openai-response-format.ts` -- Validate protocol shape with a fake extension worker:
  - Streaming text response.
  - Streaming reasoning plus text response.
  - Non-streaming text response.
  - Structured error response.
  - `/v1/models` output.
- `scripts/test-tool-calls.ts` -- Validate tool-call behavior with fake Grok chunks:
  - Streaming tool-call envelope conversion.
  - Non-streaming tool-call conversion.
  - Multiple tool calls when `parallel_tool_calls !== false`.
  - Rejection or clear handling when multiple calls are disabled.
  - Unknown tool, malformed JSON, invalid arguments, and oversized envelope failures.
  - Tool-result continuation prompt shape.
- `scripts/test-web-ui-protocol.ts` -- Verify the web UI request/parse logic without requiring live Grok:
  - Existing chat history still stores and reuses `conversationId` / `parentResponseId`.
  - Tool lab sends valid `tools[]`.
  - UI renders `delta.tool_calls`, `finish_reason: "tool_calls"`, reasoning, and `[DONE]`.
- `package.json` -- Add M5 scripts:
  - `test-openai-response-format`
  - `test-tool-calls`
  - `test-web-ui-protocol`
  - `verify-m5`
- `docs/M5_COMPLETION_AUDIT.md` -- Record final M5 evidence after implementation.
- `artifacts/` -- Store sanitized M5 evidence:
  - `m5-streaming-text.sse`
  - `m5-streaming-tool-call.sse`
  - `m5-nonstreaming-tool-call.json`
  - `m5-tool-result-continuation.json`
  - `m5-web-ui-protocol.json`

---

## OUT_OF_SCOPE
- Implementing or validating the OpenCode plugin.
- Editing user-level OpenCode config.
- Running `opencode run` as an acceptance gate.
- TUI model selector integration.
- Headless browser automation, cookie database scraping, or raw cookie replay.
- Publishing the Chrome extension or npm package.
- Remote, LAN, or multi-user proxy hosting.
- Attachment, image, audio, PDF, or file upload support.
- Claims of native Grok function calling. M5 only implements a deterministic bridge envelope.
- Optimizing TTFT beyond preserving M4 fast path behavior.

---

## ARCHITECTURE & DESIGN

### Boundary Contract
M5 establishes this contract:

```text
OpenAI/OpenCode-compatible request
  -> local proxy protocol normalizer
  -> existing M4 bridge job
  -> Chrome extension authenticated Grok request
  -> Grok stream parser
  -> OpenAI/OpenCode-compatible response
```

M6 may later attach OpenCode to this endpoint. M6 must not need to patch response conversion logic to make ordinary text, reasoning, or tool calls usable.

### Model Contract
`/v1/models` must expose:

```json
{
  "object": "list",
  "data": [
    {
      "id": "grok-latest",
      "object": "model",
      "owned_by": "grok.com-browser-session"
    }
  ]
}
```

Rules:
1. `grok-latest` is the only OpenCode-facing model.
2. `grok-latest-new` remains hidden from `/v1/models`.
3. Direct web UI requests may still use internal routing fields or model aliases if tests prove no leakage into `/v1/models`.

### Message Normalization
Support these message roles:

```typescript
type ChatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';
```

Rules:
1. Reject missing or non-array `messages` with HTTP 400.
2. Text-only messages keep existing prompt flattening.
3. Content arrays may include text parts only in M5. Non-text content is rejected with a clear 400.
4. Assistant messages with `tool_calls` are protocol state and must not be flattened as assistant prose.
5. Final `tool` messages are converted into the tool-result continuation prompt.
6. Direct continuation still uses the current M3/M4 fields when present:
   - `conversationId`
   - `parentResponseId`
7. First turns without explicit continuation metadata must use the `/new` template when available, matching the post-M4 new-chat behavior.

### Streaming Text and Reasoning
Streaming response chunks must follow OpenAI chat completion chunk shape:

```json
{
  "id": "chatcmpl_<job>",
  "object": "chat.completion.chunk",
  "created": 123,
  "model": "grok-latest",
  "choices": [
    {
      "index": 0,
      "delta": { "content": "hello" },
      "finish_reason": null
    }
  ]
}
```

Reasoning/progress output may use:

```json
{ "delta": { "reasoning_content": "thinking..." } }
```

Rules:
1. Reasoning chunks must not be appended to final assistant `content`.
2. The final content chunk must end with `finish_reason: "stop"` and then `data: [DONE]`.
3. Metadata can remain in `event: grok-timing` frames for the web UI, but it must not corrupt OpenAI-compatible `message` frames.

### Non-Streaming Responses
When `stream !== true`, return:

```json
{
  "id": "chatcmpl_<job>",
  "object": "chat.completion",
  "created": 123,
  "model": "grok-latest",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "text"
      },
      "finish_reason": "stop"
    }
  ]
}
```

Non-streaming mode may internally consume the same bridge job events as streaming mode. It must not use a separate Grok transport path.

### Tool-Call Envelope Protocol
When `tools[]` is present, append a concise hidden instruction to the Grok prompt that defines a deterministic envelope:

```text
<grok_bridge_tool_calls>{"tool_calls":[{"name":"TOOL_NAME","arguments":{}}]}</grok_bridge_tool_calls>
```

Rules:
1. Tool names come from `tools[].function.name`.
2. Tool descriptions and JSON schemas are included in the hidden instruction.
3. If no tool is needed, Grok may respond with normal assistant text.
4. If a tool is needed, the envelope must be parsed and suppressed from assistant content.
5. `arguments` must be an object.
6. Tool names must match one provided tool exactly.
7. Duplicate tool names in the request are rejected.
8. `tool_choice: "none"` disables tool envelope prompting.
9. `tool_choice: "auto"` and omitted `tool_choice` allow normal text or tool calls.
10. `tool_choice: { "type": "function", "function": { "name": "..." } }` forces that tool instruction.
11. `parallel_tool_calls === false` allows only one tool call. If Grok emits more, return a structured bridge error.
12. `parallel_tool_calls !== false` should support multiple tool calls.
13. Envelopes larger than `GROK_TOOL_ENVELOPE_MAX_BYTES` fail closed.

### Streaming Tool Calls
For a parsed tool envelope, emit one complete OpenAI-compatible `tool_calls` delta:

```json
{
  "object": "chat.completion.chunk",
  "choices": [
    {
      "index": 0,
      "delta": {
        "tool_calls": [
          {
            "index": 0,
            "id": "call_<job>_0",
            "type": "function",
            "function": {
              "name": "tool_name",
              "arguments": "{\"path\":\"package.json\"}"
            }
          }
        ]
      },
      "finish_reason": null
    }
  ]
}
```

Then emit a final chunk with `finish_reason: "tool_calls"` and `data: [DONE]`.

### Non-Streaming Tool Calls
Return:

```json
{
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": []
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

### Tool Result Continuation
When final request messages contain contiguous `tool` role messages, convert only that suffix into:

```text
Tool result for call <tool_call_id>:
<grok_bridge_tool_result>
<tool result text or JSON string>
</grok_bridge_tool_result>

Continue the answer using this result.
```

Rules:
1. Tool result content is forwarded only for the current request.
2. Tool outputs are not stored in proxy session state.
3. Default logs must not include tool outputs.
4. The web UI may use small browser-local mock tool outputs for verification and may store them in local UI state.

### Web UI Protocol Lab
The web UI must prove M5 behavior without OpenCode:
1. A toggle for streaming vs non-streaming.
2. A toggle for tool mode.
3. At least one harmless mock tool definition, for example `get_current_time` or `echo_json`.
4. Display of raw request summary with prompt redaction option.
5. Display of parsed assistant text, reasoning, `tool_calls`, finish reason, timing, and continuation metadata.
6. A button or flow to send mock tool results back as `tool` messages in the same chat.

---

## EXACT REQUIREMENTS

### Functional Requirements
1. Streaming text responses are valid OpenAI-compatible SSE and end with `[DONE]`.
2. Streaming reasoning uses `delta.reasoning_content` and does not contaminate final assistant content.
3. Non-streaming text responses are valid OpenAI-compatible JSON.
4. Streaming tool calls emit `delta.tool_calls`, then `finish_reason: "tool_calls"`, then `[DONE]`.
5. Non-streaming tool calls return `message.tool_calls` and `finish_reason: "tool_calls"`.
6. Tool result messages produce a Grok continuation prompt and preserve current chat routing metadata.
7. Invalid request bodies fail with OpenAI-style JSON errors.
8. Malformed, oversized, unknown-tool, or schema-invalid tool envelopes fail with actionable errors.
9. `/v1/models` exposes `grok-latest` and does not expose `grok-latest-new`.
10. First chat turns continue to use the post-M4 `/new` template behavior.
11. Existing web UI chat history and continuation behavior keep working.
12. Existing M4 TTFT verifier keeps passing or fails only for known external live Grok conditions, not protocol regressions.

### Non-Functional Requirements
1. No new default logs include cookies, auth headers, request templates, prompt bodies, or tool outputs.
2. Tool parsing is bounded by byte limits and deterministic sentinels.
3. Protocol conversion code is covered by pure or fake-worker tests, not only live manual use.
4. Web UI additions must be compact and operational, not a marketing page.
5. M5 must not add plugin complexity or OpenCode config side effects.

---

## IMPLEMENTATION STEPS

### Step 0 -- Baseline Inspection
Run and record:

```bash
pwd
git status --short
npm run build
npm run test-bridge
npm run test-new-conversation
npm run test-extension-routing
npm run test-chat-history-ui
npm run verify-m4
```

If `verify-m4` cannot run because live native samples are unavailable, do not block M5 implementation. Record that limitation in the M5 audit and keep protocol tests deterministic.

### Step 1 -- Define Protocol Types
Add typed request/response helpers in `src/proxy.ts` or a small local module if that reduces risk:

```typescript
type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
};

type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};
```

Keep the implementation close to existing proxy code unless extraction clearly improves testability.

### Step 2 -- Normalize Requests
1. Validate `messages`.
2. Validate `tools`.
3. Normalize `tool_choice`.
4. Normalize `parallel_tool_calls`.
5. Produce a prompt for Grok.
6. Preserve `conversationId` and `parentResponseId` routing.
7. Add hidden tool instructions only when tools are active.

### Step 3 -- Implement Non-Streaming Mode
1. Use the same bridge job path.
2. Collect assistant content, reasoning separately if needed, metadata, and tool calls.
3. Return valid JSON response.
4. Add fake-worker tests.

### Step 4 -- Implement Tool Envelope Parser
1. Detect start sentinel.
2. Buffer until end sentinel or byte limit.
3. Parse JSON.
4. Validate tool calls against request definitions.
5. Generate stable `call_<job>_<index>` ids.
6. Suppress envelope text from assistant output.
7. Fail closed on malformed data.

### Step 5 -- Implement Streaming Tool Call Emission
1. Emit normal text while no tool envelope appears.
2. If a valid tool envelope appears, emit `delta.tool_calls`.
3. Emit `finish_reason: "tool_calls"`.
4. Emit `[DONE]`.
5. Ensure `event: grok-timing` frames remain parseable by the web UI.

### Step 6 -- Add Web UI Protocol Lab
1. Add controls for stream/non-stream and tool mode.
2. Add at least one mock tool definition.
3. Parse and render tool-call chunks.
4. Allow sending mock tool results as a continuation in the current chat.
5. Keep current chat list, new chat, health, prewarm, and timing UI intact.

### Step 7 -- Add Verification Scripts
1. Add `scripts/test-openai-response-format.ts`.
2. Add `scripts/test-tool-calls.ts`.
3. Add `scripts/test-web-ui-protocol.ts`.
4. Add `npm run verify-m5` that runs all M5 deterministic tests plus preserved M4 regression tests.

### Step 8 -- Live Web UI Verification
1. Start the proxy.
2. Confirm `/health` has `requestReady: true`.
3. Open `web/index.html` through a local static server or the established demo path.
4. Send a normal prompt and verify streamed text.
5. Send a tool-mode prompt and verify tool call display.
6. Send a mock tool result continuation and verify final answer routing.
7. Capture sanitized evidence in `artifacts/m5-web-ui-protocol.json`.

### Step 9 -- Audit
Create `docs/M5_COMPLETION_AUDIT.md` mapping every requirement to:
1. File evidence.
2. Script evidence.
3. Artifact evidence.
4. Manual web UI evidence.

---

## VERIFICATION / SUCCESS CRITERIA
1. `npm run build` passes.
2. `npm run test-bridge` passes.
3. `GROK_FAST_PATH=0 npm run test-bridge` passes.
4. `npm run test-new-conversation` passes.
5. `npm run test-extension-routing` passes.
6. `npm run test-chat-history-ui` passes.
7. `npm run test-openai-response-format` passes.
8. `npm run test-tool-calls` passes.
9. `npm run test-web-ui-protocol` passes.
10. `npm run verify-m5` passes.
11. `/v1/models` returns `grok-latest` only.
12. Web UI live test proves normal text, reasoning display, tool-call display, mock tool execution, and tool-result continuation.
13. Sanitized M5 artifacts exist and contain no cookies, auth headers, raw request templates, prompt bodies from outside controlled tests, or non-test tool outputs.
