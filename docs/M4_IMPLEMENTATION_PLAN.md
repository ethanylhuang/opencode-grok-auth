# M4 Architect Artifact -- Native-Parity TTFT Reduction

## Problem Restatement
Reduce web-demo Time To First Token (TTFT) so perceived latency approaches native `grok.com` chat experience. The target is to remove avoidable local bridge overhead so dominant latency comes from Grok upstream infrastructure, not this project's proxy/extension pipeline.

---

## OBJECTIVE FUNCTION
- Primary KPI: `TTFT_delta = TTFT_demo - TTFT_native_grok`.
- Goal: Drive `TTFT_delta` toward near-zero at p50 and materially reduce p95/p99 jitter.
- Hard requirement: Keep response correctness and stream continuity unchanged.

---

## ASSUMPTIONS
1. Native `grok.com` TTFT remains the lower bound; we can only remove local additive latency.
2. Current largest additive delays are bridge dispatch/wakeup and extension message-hop overhead.
3. Web demo optimization can prioritize latency over deep observability in hot path.
4. Running in a warm browser context (active Grok tab/session) is allowed for this milestone.
5. A fallback path must exist for reliability if fast path is temporarily unavailable.

---

## IN_SCOPE
- `src/proxy.ts`
  - Add push-based worker dispatch channel (WebSocket/SSE-downstream equivalent) to eliminate polling pickup delay.
  - Add TTFT phase timestamps and lightweight metrics emission for: enqueue, worker notified, worker accepted, upstream fetch start, first upstream chunk, first SSE chunk.
  - Add fast-path SSE emission safeguards to flush earliest user-visible token immediately once available.
- `extension/background.js`
  - Replace long-poll job acquisition loop with persistent push control channel.
  - Migrate stream transport to long-lived Port-based messaging for active jobs.
  - Add warm-state liveness maintenance (demo mode): ensure Grok tab/session readiness and channel health.
- `extension/content.js`
  - Use persistent Port transport for chunk/timing/completion messages.
  - Add micro-batching window for ultra-small chunk bursts only when it lowers end-to-end latency jitter.
- `extension/injected.js`
  - Preserve direct authenticated fetch path, but optimize immediate forwarding of first upstream bytes to content layer.
- `web/index.html`
  - Add preflight readiness indicator and optional explicit "Prewarm" control.
  - Show TTFT timing breakdown for diagnostics in demo mode.
- `scripts/test-latency.ts`
  - Extend benchmark output to compare p50/p95/p99 TTFT before/after with phase attribution.

---

## OUT_OF_SCOPE
- Any headless browser automation (Playwright/Puppeteer/Selenium click simulation).
- OpenCode SDK/provider API contract redesign.
- Multi-user distributed deployment optimizations.
- Grok upstream/backend acceleration attempts.
- Full protocol replacement beyond required control/data-plane optimizations.
- Non-web-demo clients.

---

## EXACT REQUIREMENTS

### Functional Requirements
1. **Push Dispatch Required**
   - Job delivery to extension workers must be event-driven via persistent connection.
   - Polling path may remain only as explicit fallback and must not be default.
2. **Persistent Messaging Required**
   - Active stream messages must use Port-based long-lived channels across extension layers.
   - One-shot message APIs allowed only for bootstrap/fallback control.
3. **Warm-State Required (Demo Mode)**
   - System must expose whether Grok tab/session/channel are warm-ready before send.
4. **TTFT Phase Telemetry Required**
   - Must emit machine-readable timings for critical milestones:
     - `jobQueuedAt`
     - `workerNotifiedAt`
     - `workerAcceptedAt`
     - `grokFetchStartedAt`
     - `firstRawUpstreamChunkAt`
     - `firstSseChunkAt`
5. **Compatibility Required**
   - Existing chat completion behavior and output format remain OpenAI-compatible.
   - Fallback path must continue functioning when fast path is unavailable.

### Non-Functional Requirements
1. **Latency**
   - Reduce median `jobQueuedAt -> workerAcceptedAt` by >= 50% from baseline.
   - Reduce median end-to-end TTFT by >= 30% from baseline.
   - Reduce p95 TTFT jitter materially (target >= 30% reduction).
2. **Correctness**
   - No regression in chunk ordering, completion signaling, or error propagation.
3. **Safety**
   - No logging of raw auth secrets/cookies.
4. **Operability**
   - Fast-path on/off toggle for controlled rollout and A/B verification.

---

## IMPLEMENTATION STEPS

### Step 0 -- Baseline & Instrumentation Lock
1. Add/verify consistent TTFT timing points across proxy/extension pipeline.
2. Run baseline latency script (N>=30 samples) under warm and cold conditions.
3. Persist baseline report artifact for M4 comparison.

### Step 1 -- Push Control Plane
1. Implement persistent proxy->worker dispatch channel.
2. Register worker identity/capabilities on connect; track liveness.
3. Route queued jobs immediately to ready worker.
4. Keep polling endpoint as fallback-only path gated by feature flag.

### Step 2 -- Port-Based Stream Data Plane
1. Establish long-lived Port between background and content for active Grok tab.
2. Route chunk/timing/completion over Port.
3. Retain strict per-job ordering guarantees.
4. Add bounded micro-batch window only if it improves measured TTFT jitter.

### Step 3 -- First-Byte Fast Path
1. Ensure immediate propagation of first upstream bytes from injected fetch to proxy stream.
2. Minimize synchronous, non-critical work before first SSE chunk emit.
3. Verify first-token rendering path in web demo is not blocked by ancillary UI/logging work.

### Step 4 -- Warm-Readiness UX
1. Add readiness state endpoint/fields to proxy health output.
2. Expose readiness + prewarm action in web demo UI.
3. Gate send action with explicit warning when system is cold (user may continue).

### Step 5 -- Verification & Rollout
1. Run latency benchmarks before/after with same environment.
2. Compare p50/p95/p99 TTFT and per-phase deltas.
3. Validate fallback path by forcing fast-path disable.
4. Document measured gains and remaining bottlenecks.

---

## ACCEPTANCE CRITERIA (DONE DEFINITION)
1. Default path uses push dispatch + Port streaming (polling not default).
2. Telemetry captures all required timestamps per request.
3. Web demo exposes warm readiness and prewarm capability.
4. Benchmarks demonstrate required median TTFT reduction and dispatch-delay reduction.
5. No regressions in streaming correctness, error handling, or compatibility behavior.

---

## RISKS & MITIGATIONS
- Risk: Service worker/channel lifecycle instability.
  - Mitigation: heartbeat + reconnect logic, explicit fallback path.
- Risk: Lower observability in fast path hides failures.
  - Mitigation: minimal structured telemetry retained; deep logging behind debug flag.
- Risk: Micro-batching can increase first token delay if misconfigured.
  - Mitigation: keep disabled by default; enable only with benchmark proof.

---

## VERIFICATION / SUCCESS CRITERIA
1. `npm run test-latency` reports baseline vs M4 comparison with p50/p95/p99.
2. Measured `jobQueuedAt -> workerAcceptedAt` median improves by >= 50%.
3. Measured end-to-end TTFT median improves by >= 30%.
4. Fallback mode remains functional when fast path disabled.
5. Manual web demo test confirms first token appears closer to native Grok perception under warm state.
