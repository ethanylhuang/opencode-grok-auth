# M4 Verification Status

## Objective
Reduce web-demo TTFT bridge overhead until demo TTFT can be compared against native `grok.com` TTFT with concrete evidence.

## Implemented
- Default push dispatch via `/bridge/events`; polling is fallback-only unless `GROK_FAST_PATH=0`.
- Per-worker heartbeat tracking plus a strict `m4-push-port-v8` readiness gate so stale/old Chrome workers cannot mask the M4 worker.
- Polling job acquisition also rejects stale workers so old extension service workers cannot contaminate polling-baseline measurements.
- Active job stream transport over long-lived Chrome `Port`.
- Required timing fields:
  - `jobQueuedAt`
  - `workerNotifiedAt`
  - `workerAcceptedAt`
  - `grokFetchStartedAt`
  - `firstRawUpstreamChunkAt`
  - `firstSseChunkAt`
- Warm readiness and prewarm UI in the demo.
- Web health UI shows the loaded background version and required background version.
- Native `grok.com` timing capture endpoint:
  - `POST /bridge/native-timing`
  - `GET /bridge/native-timings`
- Native timing samples are queued in extension storage when the proxy is unavailable and flushed after the next successful heartbeat.
- Native timing can be requested with `POST /bridge/native-probe`; the v4 extension performs an unmarked in-page Grok fetch so the normal native timing capture path records first-output TTFT.
- `npm run native-probe:m4` checks bridge readiness, triggers `POST /bridge/native-probe`, and waits for `/bridge/native-timings` to increase.
- Grok thinking/progress tokens stream as OpenAI-compatible `delta.reasoning_content`, so the web demo can show native-style first output without mixing reasoning into final assistant content.
- No-session `grok-latest` requests prefer the `/new` Grok template, avoiding stale continuation-template 403s.
- `npm run test-latency` benchmark with p50/p95/p99, phase attribution, native comparison, rate-limit backoff, warm-path preflight, and hard evidence gate.
- `npm run test-latency` preflight fails before sampling when the loaded extension is stale or when required native timing evidence is missing.
- `npm run test-latency` checkpoints the output artifact after every sample and can resume with `GROK_LATENCY_RESUME=1`.
- `npm run verify-m4` final report verifier for N>=30, required phases, bridge overhead, dispatch overhead, baseline reduction, and native comparison.

## Local Verification
- `npm run build`: pass
- `npm run test-bridge`: pass
  - verifies push dispatch path with `pushedJobs > 0` and `polledJobs = 0`
  - verifies stale fast-path workers return a version-specific 503 instead of masking readiness
- `GROK_FAST_PATH=0 npm run test-bridge`: pass
  - verifies explicit polling fallback
- `npm run test-new-conversation`: pass
- `npm run test-chat-history-ui`: pass
- `npm run test-extension-routing`: pass
  - includes native timing capture regression
- `node --check extension/background-v2.js extension/content.js extension/injected.js`: pass
- Native timing buffering:
  - `node --check extension/background-v2.js extension/content.js extension/injected.js`: pass
  - `npm run test-extension-routing`: pass
- Version gate after native buffering bump:
  - `npm run build`: pass
  - `npm run test-bridge`: pass
  - `GROK_FAST_PATH=0 npm run test-bridge`: pass
  - `npm run test-new-conversation`: pass
  - `npm run test-extension-routing`: pass
  - current repo now requires `0.1.10` / `m4-push-port-v7`; stale v5 workers are rejected until the unpacked extension is reloaded
  - live `/health` after the v6 bump reports `warmReady=false`, `requestReady=false`, loaded `0.1.8` / `m4-push-port-v5`, required `m4-push-port-v7`
- `GROK_LATENCY_SAMPLES=1 GROK_LATENCY_MAX_ATTEMPTS=1 GROK_LATENCY_REQUIRE_NATIVE=1 npm run test-latency`: expected fail before sampling while Chrome has stale extension loaded
  - reports `loaded extension manifest 0.1.4 background m4-push-port-v1; required background m4-push-port-v2`
  - superseded by the current `m4-push-port-v7` gate after native probe support was added
- `GROK_FAST_PATH=0 GROK_LATENCY_SAMPLES=1 GROK_LATENCY_MAX_ATTEMPTS=1 npm run test-latency`: expected fail before sampling while Chrome has stale extension loaded
  - verifies polling-baseline preflight does not require push readiness, but still rejects stale extension code
- `GROK_LATENCY_SAMPLES=1 GROK_LATENCY_MAX_ATTEMPTS=1 GROK_LATENCY_DELAY_MS=0 GROK_LATENCY_OUTPUT=artifacts/m4-baseline-probe-after-stale-poll-fix.json npm run test-latency`: expected fail after sampling
  - preflight passed with then-current `0.1.5` / `m4-push-port-v2` polling worker
  - Grok upstream returned HTTP 429
- `GROK_LATENCY_RESUME=1 GROK_LATENCY_PREFLIGHT_URL=0 GROK_LATENCY_SAMPLES=1 GROK_LATENCY_MAX_ATTEMPTS=1 GROK_LATENCY_OUTPUT=artifacts/m4-baseline-checkpoint-probe.json npm run test-latency`: expected fail without sampling
  - verifies existing samples are loaded from the output artifact before validation
- Final local regression sweep after preflight/verifier changes:
  - `npm run test-bridge`: pass
  - `GROK_FAST_PATH=0 npm run test-bridge`: pass
    - includes stale polling worker rejection with HTTP 409
  - `npm run test-extension-routing`: pass
  - `npm run test-new-conversation`: pass
  - `npm run test-chat-history-ui`: pass
  - `node --check extension/background-v2.js extension/content.js extension/injected.js`: pass
- Final local regression sweep after `0.1.10` / `m4-push-port-v7` and early native-timing post:
  - restarted `npm run proxy:dev`: pass
  - live `/health`: proxy requires `m4-push-port-v7`, but Chrome Beta still reports stale workers `0.1.9` / `m4-push-port-v6` and `0.1.5` / `m4-push-port-v2`
  - Chrome Beta profile `Secure Preferences` points the unpacked extension at `/Users/ethanhuang/opencode-grok-auth/extension`, but `service_worker_registration_info.version` is still `0.1.9`
  - `npm run build`: pass
  - `npm run test-extension-routing`: pass
  - `npm run test-chat-history-ui`: pass
  - `npm run test-new-conversation`: pass
  - `npm run test-bridge`: pass
  - `GROK_FAST_PATH=0 npm run test-bridge`: pass
  - `npm run native-probe:m4`: expected fail before probe dispatch
    - reports `bridge is not ready for native probe: manifest=0.1.5 background=m4-push-port-v2 required=m4-push-port-v7 workers=[0.1.5/m4-push-port-v2, 0.1.9/m4-push-port-v6]`
  - `GROK_M4_REPORT=artifacts/m4-fastpath-output-comparison.json npm run verify-m4`: expected fail
    - `native Grok comparison is missing`
- Native probe bug fix after live dashboard error:
  - live `npm run native-probe:m4` with `0.1.10` / `m4-push-port-v7`: timed out after the extension dashboard reported `ReferenceError: created is not defined`
  - fixed `runNativeTimingProbe` in `extension/background-v2.js` by defining the `created` flag before tab creation/update
  - bumped manifest/background/proxy gate to `0.1.11` / `m4-push-port-v8` so the broken v7 worker is stale
  - `npm run build`: pass
  - `node --check extension/background-v2.js extension/content.js extension/injected.js`: pass
  - `npm run test-extension-routing`: pass
  - `npm run test-chat-history-ui`: pass
  - `npm run test-new-conversation`: pass
  - `npm run test-bridge`: pass
  - `GROK_FAST_PATH=0 npm run test-bridge`: pass
  - live `/health` after proxy restart: requires `m4-push-port-v8`; loaded workers are still stale until Chrome Beta reloads the unpacked extension again
- `GROK_M4_REPORT=artifacts/m4-fastpath-warm.json npm run verify-m4`: expected fail
  - `successfulSamples field is missing`
  - `successful samples 14/30 did not meet requested count`
  - `native Grok comparison is missing`
  - `baseline comparison is missing`
- `npm run test-latency:m4-baseline`: pass
  - artifact: `artifacts/m4-baseline-polling.json`
  - successful: `30/30`
  - attempts: `30`
  - TTFT p50: `13070.49 ms`
  - TTFT p95: `21222.20 ms`
  - dispatch p50: `2.00 ms`
  - bridge visible overhead p50: `1.00 ms`
- `npm run test-latency:m4-fastpath`: pass as a benchmark run, but not as M4 acceptance evidence
  - artifact: `artifacts/m4-fastpath-comparison.json`
  - successful: `30/30`
  - attempts: `39`
  - failed attempts: `9`
  - TTFT p50: `13644.96 ms`
  - TTFT p95: `17342.86 ms`
  - dispatch p50: `1.00 ms`
  - bridge visible overhead p50: `1.00 ms`
  - native timing count: `0`
  - baseline comparison:
    - dispatch p50 reduction: `50.00%`
    - TTFT p50 reduction: `-4.40%`
    - TTFT p95 reduction: `18.28%`
- `GROK_M4_REPORT=artifacts/m4-fastpath-comparison.json npm run verify-m4`: expected fail
  - `native Grok comparison is missing`
  - `TTFT p50 reduction -4.40% is below 30%`
  - `TTFT p95 reduction 18.28% is below 30%`
- `GROK_LATENCY_RESUME=1 GROK_LATENCY_SAMPLES=30 GROK_LATENCY_DELAY_MS=30000 GROK_LATENCY_MAX_ATTEMPTS=60 GROK_LATENCY_STOP_AFTER_CONSECUTIVE_429=3 GROK_LATENCY_BASELINE=artifacts/m4-baseline-polling.json GROK_LATENCY_OUTPUT=artifacts/m4-fastpath-output-comparison.json npm run test-latency`: pass
  - artifact: `artifacts/m4-fastpath-output-comparison.json`
  - successful: `30/30`
  - attempts: `31`
  - failed attempts: `1`
  - output TTFT p50: `296.26 ms`
  - output TTFT p95: `549.50 ms`
  - final content TTFT p50: `16328.12 ms`
  - final content TTFT p95: `23764.92 ms`
  - dispatch p50: `1.00 ms`
  - bridge visible overhead p50: `0.00 ms`
  - native timing count: `0`
  - baseline comparison:
    - dispatch p50 reduction: `50.00%`
    - output TTFT p50 reduction: `97.73%`
    - output TTFT p95 reduction: `97.41%`
- `GROK_M4_REPORT=artifacts/m4-fastpath-output-comparison.json npm run verify-m4`: expected fail
  - `native Grok comparison is missing`
- `npm run native-probe:m4`: pass after Chrome Beta loaded `0.1.11` / `m4-push-port-v8`
  - collected 5 native timing samples
  - native p50: `216 ms`
  - native p95: `2154 ms`
- `npm run test-latency:m4-final`: pass
  - artifact: `artifacts/m4-final-native-output-comparison.json`
  - successful: `30/30`
  - attempts: `31`
  - failed attempts: `1`
  - output TTFT p50: `296.26 ms`
  - output TTFT p95: `549.50 ms`
  - dispatch p50: `1.00 ms`
  - bridge visible overhead p50: `0.00 ms`
  - native timing count: `5`
  - native p50 delta: `80.26 ms`
  - baseline output-TTFT reduction: p50 `97.73%`, p95 `97.41%`
- `npm run verify-m4`: pass
  - successful: `30/30`
  - dispatch p50: `1 ms`
  - bridge overhead p50: `0 ms`
  - native delta p50: `80.26 ms`
  - baseline TTFT p50 reduction: `97.73%`
  - baseline dispatch p50 reduction: `50.00%`

## Live Evidence Collected
- M4 fast path reached warm state with:
  - `warmReady=true`
  - `controlChannelConnected=true`
  - `pushedJobs > 0`
  - `polledJobs=0`
- Complete polling baseline artifact:
  - `artifacts/m4-baseline-polling.json`
  - 30 successful Grok samples
  - dispatch p50: `2 ms`
  - TTFT p50: `13070.49 ms`
  - TTFT p95: `21222.20 ms`
- Complete fast-path comparison artifact:
  - `artifacts/m4-fastpath-comparison.json`
  - 30 successful Grok samples in 39 attempts
  - dispatch p50: `1 ms`
  - bridge visible overhead p50: `1 ms`
  - TTFT p50: `13644.96 ms`
  - TTFT p95: `17342.86 ms`
- Complete output-TTFT fast-path comparison artifact:
  - `artifacts/m4-fastpath-output-comparison.json`
  - 30 successful Grok samples in 31 attempts
  - output TTFT p50: `296.26 ms`
  - output TTFT p95: `549.50 ms`
  - final content TTFT p50: `16328.12 ms`
  - final content TTFT p95: `23764.92 ms`
  - dispatch p50: `1 ms`
  - bridge visible overhead p50: `0 ms`
  - baseline output-TTFT reduction: p50 `97.73%`, p95 `97.41%`

## Current Blockers
None for M4 acceptance. Grok upstream can still return HTTP 429 or long-running responses, but the final benchmark completed with 30 successful samples and one failed attempt under the configured retry budget.

## Final Evidence Command
Current package scripts for evidence collection:

```sh
npm run test-latency:m4-baseline
npm run test-latency:m4-fastpath
npm run native-probe:m4
npm run test-latency:m4-final
```

Then verify the final artifact:

```sh
GROK_M4_REPORT=artifacts/m4-final-native-output-comparison.json npm run verify-m4
```

The final verifier passes and the report shows native comparison data plus the required TTFT reductions.
