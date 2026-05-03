# M2 Architect Artifact -- Chrome Extension Backed OpenCode Bridge

## Problem Restatement
Move from direct Node-side cookie replay to a Chrome-extension-backed bridge. The extension runs inside the user's real logged-in Chrome/Grok browser context and performs or captures the authenticated Grok web request path. A local OpenCode-compatible proxy remains responsible for translating OpenAI chat requests and streamed responses.

This replaces the previous `provider.fetch` plugin-hook assumption and removes headless automation from the primary architecture.

---

## DECISION
Use a **Chrome extension as the only primary reliability layer**.

Do not build both extension and headless automation paths. Headless/stealth browser tooling is too brittle for the core flow and should not be part of M2.

---

## ASSUMPTIONS
1. The user is logged into `https://grok.com` in normal Chrome with an active X Premium account.
2. The extension can run on `grok.com` pages with explicit user-installed permissions.
3. The extension can either:
   - issue authenticated `fetch` calls from the browser context, or
   - observe enough live Grok request details to keep the local bridge synchronized.
4. OpenCode can be pointed at a local OpenAI-compatible endpoint, avoiding reliance on unsupported OpenCode provider fetch overrides.

---

## IN_SCOPE
- Chrome extension that operates only on `grok.com`.
- Local OpenAI-compatible proxy endpoint, e.g. `POST /v1/chat/completions`.
- Request translation from OpenAI `messages[]` to Grok web request format.
- Stream translation from Grok's chunked JSON format to OpenAI-compatible SSE.
- Local-only communication between proxy and extension.
- Clear failures for auth/session/challenge problems.

---

## OUT_OF_SCOPE
- Headless Puppeteer/Playwright as the main auth strategy.
- Cookie scraping from browser databases.
- Shipping or publishing the extension.
- Multi-user hosting.
- Production-grade guarantees against Grok/Cloudflare changes.
- Direct OpenCode Plugin SDK provider fetch override unless the SDK exposes a verified stable hook.

---

## ARCHITECTURE & DESIGN

### Components
1. **OpenCode**
   - Configured to use a local OpenAI-compatible base URL.
   - Sends normal chat completion requests.

2. **Local Proxy**
   - Listens on localhost.
   - Accepts OpenAI-compatible chat requests.
   - Flattens or maps `messages[]` into the Grok request body.
   - Talks to the extension over a local-only channel.
   - Converts Grok response chunks into OpenAI SSE chunks.

3. **Chrome Extension**
   - Runs in the real Chrome profile where Grok already works.
   - Has host permissions scoped to `https://grok.com/*`.
   - Maintains access to live browser session state.
   - Executes the authenticated Grok web request, or supplies current request metadata needed by the proxy.

### Preferred Data Flow
1. OpenCode sends `POST /v1/chat/completions` to the local proxy.
2. Proxy sends a local request to the extension bridge.
3. Extension performs the Grok request from the browser-authenticated context.
4. Extension streams raw Grok chunks back to the proxy.
5. Proxy emits OpenAI-compatible SSE to OpenCode.

### Failure Handling
- Missing extension: proxy returns a clear local setup error.
- Grok tab/session unavailable: proxy returns an auth/session error.
- Cloudflare/challenge page: user must open Grok normally and complete the browser flow.
- Grok stream parse failure: proxy returns a structured upstream-format error.

---

## VERIFICATION / SUCCESS CRITERIA
1. User can open `grok.com` normally in Chrome and confirm chat works.
2. Extension confirms it can access the active Grok browser context.
3. Local proxy receives an OpenAI-compatible test request.
4. Extension sends the request through Grok using the real browser session.
5. Proxy streams valid OpenAI-style SSE back to the test client.
6. No raw cookies are logged, printed, or written by the M2 flow.
