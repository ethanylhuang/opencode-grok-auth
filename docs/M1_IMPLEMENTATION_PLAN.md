# M1 Architect Artifact -- Manual Endpoint Verification

## Problem Restatement
Prove that we can successfully communicate with the undocumented `grok.com/rest/app-chat/...` API outside of a browser environment using a manually extracted `Cookie` header.

---

## ASSUMPTIONS
1. The user has an active X Premium subscription and can access Grok web.
2. The user has manually extracted their raw `Cookie` header from browser Developer Tools and placed it in `~/.grok_cookie`.
3. The `grok.com` API endpoint expects a standard POST request with a specific JSON payload and responds with chunked, concatenated JSON streams (not standard SSE).
4. A static `User-Agent` and `Origin`/`Referer` headers are sufficient to bypass basic bot detection for this proof of concept.

---

## IN_SCOPE
- `scripts/test-grok-endpoint.ts` -- A standalone Node.js/TypeScript script that reads the cookie, constructs the Grok payload, sends a single prompt, and parses the chunked response stream.
- `package.json` -- Initialized for executing TS scripts (e.g., via `tsx`).
- `tsconfig.json` -- Standard NodeNext TS configuration.

---

## OUT_OF_SCOPE
- OpenCode plugin integration or overriding `fetch`.
- Automatic extraction of cookies from browser databases (e.g., reading Chrome's SQLite file).
- Full reverse translation to OpenAI SSE format (just extracting and printing the raw text tokens is sufficient).

---

## ARCHITECTURE & DESIGN
- **Execution**: The script takes a prompt as a CLI argument.
- **Payload Construction**: Generates a random UUID for the conversation ID and formats the required Grok GraphQL/REST payload structure.
- **Network**: Uses standard `fetch` with the `Cookie` header attached.
- **Stream Parsing**: Reads the `ReadableStream`, manually parses concatenated JSON blocks (e.g., `{"result":...}{"result":...}`), extracts the `token` field, and prints it to `stdout`.

---

## VERIFICATION / SUCCESS CRITERIA
1. `npm run test-endpoint "What is 2+2?"` completes without 401/403/400 errors.
2. The script prints the expected response text incrementally or fully to the terminal.
