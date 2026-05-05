const baseUrl = process.env.GROK_NATIVE_PROBE_BASE_URL ?? 'http://127.0.0.1:11434';
const prompt = process.env.GROK_NATIVE_PROBE_PROMPT ?? 'Say one word.';
const timeoutMs = Math.max(1_000, Number(process.env.GROK_NATIVE_PROBE_TIMEOUT_MS ?? 180_000));
const pollMs = Math.max(250, Number(process.env.GROK_NATIVE_PROBE_POLL_MS ?? 1_000));

async function main() {
  const before = await nativeTimingCount();
  await assertReady();

  const response = await fetch(`${baseUrl}/bridge/native-probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) {
    throw new Error(`native probe request failed: HTTP ${response.status} ${await response.text()}`);
  }

  const body = await response.json() as { sent?: unknown };
  if (body.sent !== 1) {
    throw new Error(`native probe was not sent to exactly one worker: ${JSON.stringify(body)}`);
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await nativeTimings();
    const count = typeof payload.count === 'number' ? payload.count : 0;
    const p50 = nativeSummaryP50(payload.summary);
    if (count > before && p50 !== null) {
      console.log(`PASS native probe: count ${before} -> ${count}`);
      console.log(`summary=${JSON.stringify(payload.summary)}`);
      return;
    }
    await sleep(pollMs);
  }

  throw new Error(`native probe timed out after ${timeoutMs}ms waiting for native timing count to exceed ${before}`);
}

async function assertReady() {
  const response = await fetch(`${baseUrl}/health`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`health check failed: HTTP ${response.status}`);
  }
  const body = await response.json() as { bridge?: Record<string, unknown> };
  const bridge = body.bridge ?? {};
  if (bridge.requestReady !== true) {
    const loadedManifest = valueText(bridge.manifestVersion);
    const loadedBackground = valueText(bridge.backgroundCodeVersion);
    const requiredBackground = valueText(bridge.requiredBackgroundCodeVersion);
    const workers = Array.isArray(bridge.workers)
      ? bridge.workers.map((worker) => workerSummary(worker)).join(', ')
      : 'unknown';
    throw new Error(
      `bridge is not ready for native probe: manifest=${loadedManifest} background=${loadedBackground} required=${requiredBackground} workers=[${workers}]`,
    );
  }
}

async function nativeTimingCount(): Promise<number> {
  const payload = await nativeTimings();
  return typeof payload.count === 'number' ? payload.count : 0;
}

async function nativeTimings(): Promise<{ count?: unknown; summary?: unknown }> {
  const response = await fetch(`${baseUrl}/bridge/native-timings`, { cache: 'no-store' });
  if (!response.ok) {
    return {};
  }
  const body = await response.json();
  return body && typeof body === 'object' ? body as { count?: unknown; summary?: unknown } : {};
}

function nativeSummaryP50(summary: unknown): number | null {
  if (!summary || typeof summary !== 'object') {
    return null;
  }
  const p50 = (summary as Record<string, unknown>).p50;
  return typeof p50 === 'number' && Number.isFinite(p50) ? p50 : null;
}

function workerSummary(worker: unknown): string {
  if (!worker || typeof worker !== 'object') {
    return 'unknown';
  }
  const record = worker as Record<string, unknown>;
  return `${valueText(record.manifestVersion)}/${valueText(record.backgroundCodeVersion)}`;
}

function valueText(value: unknown): string {
  return typeof value === 'string' && value ? value : 'unknown';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
