# M3 Architect Artifact -- Chat History & New Chat Context Isolation

## Problem Restatement
Add chat session management to the web demo so users can:
1. Create new chats with clean Grok context (no polluted system prompt carryover)
2. Switch between independent chat sessions, each maintaining their own Grok conversation thread
3. See chat history persisted in browser localStorage

The current implementation uses a checkbox that toggles `model: 'grok-latest-new'`, but unchecking it reverts to the old polluted conversation. This milestone replaces that model with proper session management.

---

## ASSUMPTIONS
1. Grok.com maintains the actual message history server-side; we only need to store ID metadata locally.
2. `conversationId` identifies a Grok conversation thread; `parentResponseId` chains individual messages within that thread.
3. First message in a Grok conversation: POST to `/new`, Grok returns `{conversationId, responseId}`.
4. Subsequent messages: POST to `/conversations/{conversationId}/responses` with `parentResponseId: <lastResponseId>`.
5. We store `{id, title, conversationId, parentResponseId, createdAt}` per chat entry in localStorage.
6. New Chat button creates a local entry with no `conversationId`/`parentResponseId`, sends to `/new`, then stores the returned IDs.
7. Selecting an existing chat loads its `parentResponseId` and continues that thread.
8. Chat title can be auto-generated from first user message (truncated to 30 chars) or extracted from Grok's response.

---

## IN_SCOPE
- `web/index.html` -- Replace "New Chat" checkbox with a "New Chat" button; add sidebar with chat history list; add chat session state management
- `web/index.html` -- localStorage persistence for chat entries (read on load, write on create/update)
- `web/index.html` -- Extract `responseId` from SSE timing events (currently not captured); use it as `parentResponseId` for next message
- `src/proxy.ts` -- Extract `responseId` from Grok's streaming response chunks (stored in `result.response.responseId`); pass it back via job completion or SSE header
- `src/proxy.ts` -- When request body contains `parentResponseId`, attach it to the job and use it in the extension's request replay
- `src/proxy.ts` -- Add `parentResponseId` field to `BridgeJob` type; store it during job creation
- `extension/injected.js` -- Modify `buildPayload` to inject `parentResponseId` from job if present (not currently passed through)

---

## OUT_OF_SCOPE
- Grok Web API integration for fetching chat history from xai servers
- Cross-device sync
- Chat deletion/renaming UI (just one "New Chat" button initially)
- OpenCode plugin SDK changes (web demo only for now)
- Multiple concurrent streaming chats (single chat at a time)
- Chat search or filtering

---

## ARCHITECTURE & DESIGN

### Data Model
```typescript
interface ChatSession {
  id: string;           // local UUID
  title: string;       // auto-generated from first user message
  conversationId: string | null;  // from /new response, null until first message completes
  parentResponseId: string | null; // chains messages within a conversation
  createdAt: number;
  updatedAt: number;
}
```

### localStorage Key
- Key: `grok-chat-sessions`
- Value: `ChatSession[]` (JSON array, newest first)

### Flow: New Chat
1. User clicks "New Chat" button
2. Frontend creates `ChatSession` with `id: uuid()`, `conversationId: null`, `parentResponseId: null`
3. Request sent with `model: 'grok-latest-new'`
4. Proxy forwards to extension, extension POSTs to `/new`
5. Grok responds with streaming chunks containing `conversationId` and `responseId`
6. Proxy extracts these IDs, includes them in SSE `event: grok-response-metadata` or response headers
7. Frontend receives IDs, updates `chat.conversationId` and `chat.parentResponseId` in localStorage
8. Next message uses `model: 'grok-latest'` with `parentResponseId` from storage

### Flow: Continue Chat
1. User clicks existing chat in sidebar
2. Frontend loads `parentResponseId` from that chat's session
3. Request sent with `model: 'grok-latest'` + `parentResponseId` in request body
4. Proxy detects `parentResponseId` exists, stores on job
5. Extension's `buildPayload` injects `parentResponseId` into the Grok request body
6. Grok continues the conversation, returns new `responseId`
7. Frontend updates `parentResponseId` for next message

### Proxy Changes
- Add `parentResponseId` to `OpenAIChatRequest` interface (custom field in request body)
- Add `parentResponseId` and `responseId` fields to `BridgeJob`
- In `handleChat`, extract `parentResponseId` from `openAIRequest.parentResponseId` if present
- In streaming response, emit an `event: grok-response-metadata` SSE frame with `responseId` before completion
- In job completion, include `responseId` in the job state for polling

### Extension Changes
- Pass `job.parentResponseId` through to `runGrokJob` → `directGrokFetch`
- In `buildPayload`, merge `parentResponseId` into the payload body if job has one
- No URL change needed - the captured template URL already contains `conversationId`; `parentResponseId` goes in the body

---

## VERIFICATION / SUCCESS CRITERIA
1. Create New Chat, send message, verify it appears in Grok's chat history as a NEW conversation (separate from previous polluted chats)
2. Send a second message in the same New Chat - verify it's threaded as a continuation
3. Select a different existing chat from sidebar, send message - verify it goes to THAT conversation, not the current one
4. Refresh the web demo page - verify chat history persists and can be continued
5. Without any captured template, sending with "New Chat" correctly fails with helpful error
6. Existing non-chat functionality (`grok-latest` without parentResponseId) continues to work as before
7. `npm run test-new-conversation` still passes