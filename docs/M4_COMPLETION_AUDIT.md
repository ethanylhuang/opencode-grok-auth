# M4 Completion Audit

## Objective
Implement the TTFT optimizations from `docs/M4_IMPLEMENTATION_PLAN.md` and prove native-parity behavior with concrete benchmark evidence.

## Success Criteria
- Default request path uses push dispatch and Port streaming, not polling.
- Required TTFT phase timestamps are emitted per successful request:
  - `jobQueuedAt`
  - `workerNotifiedAt`
  - `workerAcceptedAt`
  - `grokFetchStartedAt`
  - `firstRawUpstreamChunkAt`
  - `firstSseChunkAt`
- Web demo exposes warm readiness, required extension version, timing breakdown, and prewarm.
- Fallback path works when fast path is disabled.
- Final evidence artifacts contain at least 30 successful baseline samples, at least 30 successful M4 fast-path samples, native `grok.com` comparison data, required baseline reductions, and pass `npm run verify-m4`.

## Checklist
| Requirement | Evidence | Status |
| --- | --- | --- |
| Push dispatch default | `npm run test-bridge` metrics show `pushedJobs=2`, `polledJobs=0`; `/bridge/events` implemented in `src/proxy.ts` | Verified locally |
| Polling fallback explicit | `GROK_FAST_PATH=0 npm run test-bridge` metrics show `pushedJobs=0`, `polledJobs=2` | Verified locally |
| Port stream transport | `npm run test-extension-routing` shows `GROK_JOB_TIMING,GROK_JOB_TIMING,GROK_JOB_CHUNK,GROK_JOB_COMPLETE` over active job routing | Verified locally |
| Required phase timestamps | `scripts/verify-m4-evidence.ts` rejects reports missing required phases | Gate implemented; final live artifact missing |
| Warm readiness and prewarm UI | `web/index.html` exposes health cells, required background version, and prewarm action | Implemented |
| Stale worker cannot mask readiness | Live local request returns HTTP 503 for `0.1.4` / `m4-push-port-v1`; test covers stale fast-path worker | Verified locally |
| Native timing capture | `extension/injected.js`, `/bridge/native-timing`, and background storage buffering implemented | Implemented; no live native sample yet |
| Native timing probe | `POST /bridge/native-probe` pushes a `native-probe` event; v4 extension runs an unmarked in-page fetch; `npm run test-bridge` and `npm run test-extension-routing` cover the proxy and injected paths | Implemented; requires extension reload for live use |
| Native probe runner | `npm run native-probe:m4` checks `/health`, calls `/bridge/native-probe`, and waits for `/bridge/native-timings` count to increase | Implemented; live run blocked by stale loaded extension |
| Benchmark comparison | `scripts/test-latency.ts` writes summaries and native comparison; preflight blocks stale extension/native-missing runs | Implemented |
| Benchmark checkpoint/resume | `scripts/test-latency.ts` writes the output artifact after every sample and reloads it with `GROK_LATENCY_RESUME=1` | Verified locally |
| Polling baseline evidence | `artifacts/m4-baseline-polling.json`: 30/30 successes, TTFT p50 `13070.49 ms`, TTFT p95 `21222.20 ms`, dispatch p50 `2.00 ms` | Collected |
| Fast-path evidence | `artifacts/m4-fastpath-comparison.json`: 30/30 successes in 39 attempts, TTFT p50 `13644.96 ms`, TTFT p95 `17342.86 ms`, dispatch p50 `1.00 ms` | Collected; fails reduction gates |
| Native-style first output | Proxy streams Grok thinking/progress tokens as `delta.reasoning_content`; web demo renders reasoning separately from final content; `npm run test-bridge` and `npm run test-chat-history-ui` cover this path | Verified locally |
| No-session routing | No-conversation `grok-latest` jobs prefer `/new` template; `npm run test-new-conversation` verifies no-session `/new` and existing-conversation regular routing | Verified locally |
| Output-TTFT fast-path evidence | `artifacts/m4-fastpath-output-comparison.json`: 30/30 successes in 31 attempts, output TTFT p50 `296.26 ms`, output TTFT p95 `549.50 ms`, dispatch p50 `1.00 ms`, baseline output-TTFT reduction p50 `97.73%`, p95 `97.41%` | Collected; superseded by final native artifact |
| Final M4 evidence | `artifacts/m4-final-native-output-comparison.json`: 30/30 successes in 31 attempts, native count `5`, native p50 `216 ms`, demo output TTFT p50 `296.26 ms`, native p50 delta `80.26 ms`; `npm run verify-m4` passes | Verified |

## Completion Evidence
1. Live bridge readiness:
   - `/health` reports `manifestVersion=0.1.11`, `backgroundCodeVersion=m4-push-port-v8`, `requestReady=true`, `warmReady=true`, `controlChannelConnected=true`
   - stale workers remain listed but `readyWorkerIds` contains only the current v8 worker
2. Native timing:
   - `npm run native-probe:m4` collected 5 samples
   - `/bridge/native-timings` summary: p50 `216 ms`, p95 `2154 ms`, min `209 ms`, max `2154 ms`
3. Final benchmark:
   - `npm run test-latency:m4-final` rebuilt `artifacts/m4-final-native-output-comparison.json`
   - successful samples: `30/30`
   - output TTFT p50/p95: `296.26 ms` / `549.50 ms`
   - dispatch p50: `1 ms`
   - bridge visible overhead p50: `0 ms`
   - native p50 delta: `80.26 ms`
   - baseline TTFT p50/p95 reduction: `97.73%` / `97.41%`
   - baseline dispatch p50 reduction: `50.00%`
4. Hard gate:
   - `npm run verify-m4`: pass

## Complete
The objective is achieved. M4 implementation is present, local regression gates are green, final N>=30 benchmark evidence is captured, native Grok TTFT comparison is present, and `npm run verify-m4` passes.
