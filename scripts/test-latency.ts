import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

type TimingValue = {
  at: number;
  ms: number;
};

type TimingSnapshot = {
  jobId?: string;
  timings?: Record<string, TimingValue>;
};

type Sample = {
  index: number;
  ok: boolean;
  jobId: string | null;
  ttftMs: number | null;
  contentTtftMs: number | null;
  totalMs: number | null;
  dispatchMs: number | null;
  upstreamToSseMs: number | null;
  bridgeVisibleOverheadMs: number | null;
  phases: Record<string, number>;
  error?: string;
};

type MetricSummary = {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  min: number | null;
  max: number | null;
};

type LatencyReport = {
  generatedAt: string;
  url: string;
  model: string;
  samplesRequested: number;
  attempts: number;
  successfulSamples: number;
  failedSamples: number;
  samples: Sample[];
  summary: {
    ttftMs: MetricSummary;
    contentTtftMs: MetricSummary;
    dispatchMs: MetricSummary;
    upstreamToSseMs: MetricSummary;
    bridgeVisibleOverheadMs: MetricSummary;
  };
  comparison?: Record<string, unknown>;
};

const url = process.env.GROK_LATENCY_URL ?? 'http://127.0.0.1:11434/v1/chat/completions';
const model = process.env.GROK_LATENCY_MODEL ?? 'grok-latest';
const samples = Math.max(1, Number(process.env.GROK_LATENCY_SAMPLES ?? 30));
const maxAttempts = Math.max(samples, Number(process.env.GROK_LATENCY_MAX_ATTEMPTS ?? samples * 3));
const delayMs = Math.max(0, Number(process.env.GROK_LATENCY_DELAY_MS ?? 0));
const rateLimitBackoffMs = Math.max(0, Number(process.env.GROK_LATENCY_429_BACKOFF_MS ?? 60_000));
const stopAfterConsecutive429 = Math.max(0, Number(process.env.GROK_LATENCY_STOP_AFTER_CONSECUTIVE_429 ?? 0));
const prompt = process.env.GROK_LATENCY_PROMPT ?? 'Say one word.';
const outputPath = process.env.GROK_LATENCY_OUTPUT ?? path.join('artifacts', `m4-latency-${Date.now()}.json`);
const baselinePath = process.env.GROK_LATENCY_BASELINE ?? '';
const nativePath = process.env.GROK_LATENCY_NATIVE_REPORT ?? '';
const nativeEndpointUrl =
  process.env.GROK_LATENCY_NATIVE_URL === '0'
    ? ''
    : (process.env.GROK_LATENCY_NATIVE_URL ?? new URL('/bridge/native-timings', url).toString());
const preflightUrl =
  process.env.GROK_LATENCY_PREFLIGHT_URL === '0'
    ? ''
    : (process.env.GROK_LATENCY_PREFLIGHT_URL ?? new URL('/health', url).toString());
const nativeTtftMs = process.env.GROK_NATIVE_TTFT_MS ? Number(process.env.GROK_NATIVE_TTFT_MS) : null;
const allowPartial = process.env.GROK_LATENCY_ALLOW_PARTIAL === '1';
const requireNative = process.env.GROK_LATENCY_REQUIRE_NATIVE === '1';
const requireWarm = process.env.GROK_LATENCY_REQUIRE_WARM !== '0';
const resume = process.env.GROK_LATENCY_RESUME === '1';

async function main() {
  const completed: Sample[] = resume ? readResumeSamples(outputPath) : [];

  console.log('Grok Bridge M4 Latency Benchmark');
  console.log(`url=${url}`);
  console.log(`model=${model}`);
  console.log(`samples=${samples}`);
  console.log(`maxAttempts=${maxAttempts}`);
  console.log(`delayMs=${delayMs}`);
  console.log(`stopAfterConsecutive429=${stopAfterConsecutive429}`);
  console.log(`resume=${resume ? 'on' : 'off'} resumedSamples=${completed.length}`);
  await preflight();

  let attempt = completed.reduce((highest, sample) => Math.max(highest, sample.index), 0);
  let consecutive429s = 0;
  while (completed.filter((sample) => sample.ok).length < samples && attempt < maxAttempts) {
    attempt++;
    const sample = await runSample(attempt);
    completed.push(sample);
    if (sample.ok) {
      consecutive429s = 0;
    } else if (sample.error?.includes('HTTP 429')) {
      consecutive429s++;
    } else {
      consecutive429s = 0;
    }
    persistCheckpoint(completed);
    const status = sample.ok ? 'ok' : 'fail';
    console.log(
      [
        `sample=${sample.index}`,
        `status=${status}`,
        `ttft=${format(sample.ttftMs)}`,
        `dispatch=${format(sample.dispatchMs)}`,
        `upstreamToSse=${format(sample.upstreamToSseMs)}`,
        sample.error ? `error=${JSON.stringify(sample.error)}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );

    const needsMoreSamples = completed.filter((item) => item.ok).length < samples && attempt < maxAttempts;
    if (!sample.ok && stopAfterConsecutive429 > 0 && consecutive429s >= stopAfterConsecutive429) {
      console.log(`stopAfterConsecutive429 reached after ${consecutive429s} consecutive HTTP 429 responses`);
      break;
    }
    if (!sample.ok && sample.error?.includes('HTTP 429') && rateLimitBackoffMs > 0 && needsMoreSamples) {
      console.log(`rateLimitBackoff=${rateLimitBackoffMs}ms`);
      await sleep(rateLimitBackoffMs);
    } else if (delayMs > 0 && needsMoreSamples) {
      await sleep(delayMs);
    }
  }

  const report = buildReport(completed);
  report.comparison = await buildComparison(report);
  persistReport(report);
  printSummary(report);
  validateReport(report);
}

function buildReport(completed: Sample[]): LatencyReport {
  return {
    generatedAt: new Date().toISOString(),
    url,
    model,
    samplesRequested: samples,
    attempts: completed.length,
    successfulSamples: completed.filter((sample) => sample.ok).length,
    failedSamples: completed.filter((sample) => !sample.ok).length,
    samples: completed,
    summary: summarize(completed),
  };
}

async function preflight(): Promise<void> {
  if (!preflightUrl || !requireWarm) {
    return;
  }

  let response: Response;
  try {
    response = await fetch(preflightUrl, { cache: 'no-store' });
  } catch (error) {
    throw new Error(
      `Latency preflight failed: could not fetch ${preflightUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new Error(`Latency preflight failed: GET ${preflightUrl} returned HTTP ${response.status}`);
  }

  const body = await response.json();
  const bridge = body && typeof body === 'object' ? (body as { bridge?: Record<string, unknown> }).bridge : null;
  const failures: string[] = [];

  if (!bridge) {
    failures.push('missing bridge health payload');
  } else {
    const loadedBackground =
      typeof bridge.backgroundCodeVersion === 'string' && bridge.backgroundCodeVersion
        ? bridge.backgroundCodeVersion
        : 'unknown';
    const requiredBackground =
      typeof bridge.requiredBackgroundCodeVersion === 'string' && bridge.requiredBackgroundCodeVersion
        ? bridge.requiredBackgroundCodeVersion
        : '';
    const loadedManifest =
      typeof bridge.manifestVersion === 'string' && bridge.manifestVersion
        ? bridge.manifestVersion
        : '';

    if (requiredBackground && loadedBackground !== requiredBackground) {
      failures.push(
        `loaded extension${loadedManifest ? ` manifest ${loadedManifest}` : ''} background ${loadedBackground}; required background ${requiredBackground}`,
      );
    }
    if (bridge.warmReady !== true) {
      failures.push('bridge.warmReady is not true');
    }
    const fastPath = bridge.fastPath as Record<string, unknown> | undefined;
    const fastPathEnabled = fastPath?.enabled === true;
    if (fastPathEnabled) {
      if (bridge.controlChannelConnected !== true) {
        failures.push('bridge.controlChannelConnected is not true');
      }
      if (!Array.isArray(bridge.readyWorkerIds) || bridge.readyWorkerIds.length === 0) {
        failures.push('bridge.readyWorkerIds is empty');
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Latency preflight failed: ${failures.join('; ')}`);
  }

  if (requireNative && nativeTtftMs === null && !nativePath) {
    const nativeEndpoint = await readNativeEndpoint(nativeEndpointUrl);
    const nativeCount = typeof nativeEndpoint?.count === 'number' ? nativeEndpoint.count : 0;
    if (nativeCount <= 0) {
      throw new Error(
        'Latency preflight failed: native comparison is required but no native timing samples are available. Send a normal grok.com message with the extension loaded, or set GROK_LATENCY_NATIVE_REPORT or GROK_NATIVE_TTFT_MS.',
      );
    }
  }

  console.log(`preflight=ok url=${preflightUrl}`);
}

async function runSample(index: number): Promise<Sample> {
  const requestStarted = performance.now();
  const requestStartedWall = Date.now();
  let firstSseChunkReceivedAt: number | null = null;
  let firstOutputTokenAt: number | null = null;
  let firstContentTokenAt: number | null = null;
  let doneAt: number | null = null;
  let jobId: string | null = null;
  let serverMarks: Record<string, number> = {};
  let text = '';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Grok-Debug-Timing': '1',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
    });

    jobId = response.headers.get('X-Grok-Job-Id');
    if (!response.ok) {
      return failedSample(index, jobId, requestStarted, `HTTP ${response.status}: ${await response.text()}`);
    }
    if (!response.body) {
      return failedSample(index, jobId, requestStarted, 'Response body was empty');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const read = await reader.read();
      if (read.done) {
        break;
      }

      if (firstSseChunkReceivedAt === null) {
        firstSseChunkReceivedAt = performance.now();
      }

      buffer += decoder.decode(read.value, { stream: true });
      const processed = processSseBuffer(buffer, false, serverMarks, (token, kind) => {
        if (firstOutputTokenAt === null && token) {
          firstOutputTokenAt = performance.now();
        }
        if (kind === 'content') {
          if (firstContentTokenAt === null && token) {
            firstContentTokenAt = performance.now();
          }
          text += token;
        }
      });
      buffer = processed.remainder;
      serverMarks = processed.serverMarks;
    }

    buffer += decoder.decode();
    const processed = processSseBuffer(buffer, true, serverMarks, (token, kind) => {
      if (firstOutputTokenAt === null && token) {
        firstOutputTokenAt = performance.now();
      }
      if (kind === 'content') {
        if (firstContentTokenAt === null && token) {
          firstContentTokenAt = performance.now();
        }
        text += token;
      }
    });
    serverMarks = processed.serverMarks;
    doneAt = performance.now();

    if (!text) {
      return failedSample(index, jobId, requestStarted, 'No content token received');
    }

    return buildSample(
      index,
      true,
      jobId,
      requestStarted,
      requestStartedWall,
      firstOutputTokenAt,
      firstContentTokenAt,
      doneAt,
      serverMarks,
    );
  } catch (error) {
    return failedSample(index, jobId, requestStarted, error instanceof Error ? error.message : String(error));
  }
}

function failedSample(index: number, jobId: string | null, requestStarted: number, error: string): Sample {
  const now = performance.now();
  return {
    index,
    ok: false,
    jobId,
    ttftMs: null,
    contentTtftMs: null,
    totalMs: now - requestStarted,
    dispatchMs: null,
    upstreamToSseMs: null,
    bridgeVisibleOverheadMs: null,
    phases: {},
    error,
  };
}

function buildSample(
  index: number,
  ok: boolean,
  jobId: string | null,
  requestStarted: number,
  requestStartedWall: number,
  firstOutputTokenAt: number | null,
  firstContentTokenAt: number | null,
  doneAt: number | null,
  serverMarks: Record<string, number>,
): Sample {
  const phases: Record<string, number> = {};
  for (const [name, at] of Object.entries(serverMarks)) {
    phases[name] = at - requestStartedWall;
  }

  const dispatchMs =
    typeof serverMarks.jobQueuedAt === 'number' && typeof serverMarks.workerAcceptedAt === 'number'
      ? serverMarks.workerAcceptedAt - serverMarks.jobQueuedAt
      : null;
  const upstreamToSseMs =
    typeof serverMarks.firstRawUpstreamChunkAt === 'number' && typeof serverMarks.firstSseChunkAt === 'number'
      ? serverMarks.firstSseChunkAt - serverMarks.firstRawUpstreamChunkAt
      : null;
  const bridgeVisibleOverheadMs =
    typeof serverMarks.firstSseChunkAt === 'number' && firstOutputTokenAt !== null
      ? Math.round(requestStartedWall + (firstOutputTokenAt - requestStarted) - serverMarks.firstSseChunkAt)
      : null;

  return {
    index,
    ok,
    jobId,
    ttftMs: firstOutputTokenAt === null ? null : firstOutputTokenAt - requestStarted,
    contentTtftMs: firstContentTokenAt === null ? null : firstContentTokenAt - requestStarted,
    totalMs: doneAt === null ? null : doneAt - requestStarted,
    dispatchMs,
    upstreamToSseMs,
    bridgeVisibleOverheadMs,
    phases,
  };
}

function processSseBuffer(
  buffer: string,
  flush: boolean,
  serverMarks: Record<string, number>,
  onToken: (token: string, kind: 'content' | 'reasoning') => void,
): { remainder: string; serverMarks: Record<string, number> } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = flush ? '' : parts.pop() || '';

  for (const part of parts) {
    handleSseFrame(part, serverMarks, onToken);
  }

  if (flush && parts.length === 0 && buffer.trim()) {
    handleSseFrame(buffer, serverMarks, onToken);
  }

  return { remainder, serverMarks };
}

function handleSseFrame(
  frame: string,
  serverMarks: Record<string, number>,
  onToken: (token: string, kind: 'content' | 'reasoning') => void,
): void {
  const lines = frame.split('\n').map((line) => line.replace(/\r$/, ''));
  let eventName = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return;
  }

  const data = dataLines.join('\n');
  if (eventName === 'grok-timing') {
    mergeTimingSnapshot(data, serverMarks);
    return;
  }
  if (eventName === 'error') {
    const payload = JSON.parse(data);
    throw new Error(payload.error?.message || data);
  }
  if (eventName !== 'message' || data === '[DONE]') {
    return;
  }

  const payload = JSON.parse(data);
  const delta = payload.choices?.[0]?.delta;
  const token = delta?.content;
  if (typeof token === 'string' && token) {
    onToken(token, 'content');
    return;
  }
  const reasoningToken = delta?.reasoning_content ?? delta?.reasoning;
  if (typeof reasoningToken === 'string' && reasoningToken) {
    onToken(reasoningToken, 'reasoning');
  }
}

function mergeTimingSnapshot(data: string, serverMarks: Record<string, number>): void {
  const snapshot = JSON.parse(data) as TimingSnapshot;
  const timings = snapshot.timings && typeof snapshot.timings === 'object' ? snapshot.timings : {};

  for (const [name, value] of Object.entries(timings)) {
    if (value && typeof value.at === 'number' && serverMarks[name] === undefined) {
      serverMarks[name] = value.at;
    }
  }
}

function summarize(samples: Sample[]): LatencyReport['summary'] {
  return {
    ttftMs: metric(samples.map((sample) => sample.ttftMs)),
    contentTtftMs: metric(samples.map((sample) => sample.contentTtftMs)),
    dispatchMs: metric(samples.map((sample) => sample.dispatchMs)),
    upstreamToSseMs: metric(samples.map((sample) => sample.upstreamToSseMs)),
    bridgeVisibleOverheadMs: metric(samples.map((sample) => sample.bridgeVisibleOverheadMs)),
  };
}

function metric(values: Array<number | null>): MetricSummary {
  const clean = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  clean.sort((left, right) => left - right);

  return {
    count: clean.length,
    p50: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    p99: percentile(clean, 0.99),
    min: clean.length > 0 ? clean[0] : null,
    max: clean.length > 0 ? clean[clean.length - 1] : null,
  };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index];
}

async function buildComparison(report: LatencyReport): Promise<Record<string, unknown>> {
  const comparison: Record<string, unknown> = {};
  const baseline = readReport(baselinePath);
  const nativeReport = readReport(nativePath);
  const nativeEndpoint = await readNativeEndpoint(nativeEndpointUrl);

  if (baseline) {
    comparison.baseline = compareSummaries(report.summary, baseline.summary);
  }
  if (nativeReport) {
    comparison.nativeReport = compareSummaries(report.summary, nativeReport.summary);
  }
  if (nativeTtftMs !== null && Number.isFinite(nativeTtftMs)) {
    comparison.nativeTtftMs = {
      value: nativeTtftMs,
      deltaP50Ms: nullableDelta(report.summary.ttftMs.p50, nativeTtftMs),
    };
  }
  if (nativeEndpoint) {
    const nativeP50 = typeof nativeEndpoint.summary?.p50 === 'number' ? nativeEndpoint.summary.p50 : null;
    comparison.nativeEndpoint = {
      url: nativeEndpointUrl,
      count: nativeEndpoint.count,
      summary: nativeEndpoint.summary,
      deltaP50Ms: nullableDelta(report.summary.ttftMs.p50, nativeP50),
    };
  }
  if (!baseline && !nativeReport && nativeTtftMs === null && !nativeEndpoint) {
    comparison.note =
      'Send a normal grok.com message with the extension loaded, or set GROK_LATENCY_BASELINE, GROK_LATENCY_NATIVE_REPORT, or GROK_NATIVE_TTFT_MS for comparison.';
  }

  return comparison;
}

async function readNativeEndpoint(endpointUrl: string): Promise<any | null> {
  if (!endpointUrl) {
    return null;
  }

  try {
    const response = await fetch(endpointUrl, { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

function readReport(filePath: string): LatencyReport | null {
  if (!filePath) {
    return null;
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as LatencyReport;
  return parsed && parsed.summary ? parsed : null;
}

function readResumeSamples(filePath: string): Sample[] {
  const report = readReport(filePath);
  if (!report) {
    return [];
  }
  if (report.url !== url) {
    throw new Error(`Cannot resume ${filePath}: report url ${report.url} does not match ${url}`);
  }
  if (report.model !== model) {
    throw new Error(`Cannot resume ${filePath}: report model ${report.model} does not match ${model}`);
  }
  if (!Array.isArray(report.samples)) {
    return [];
  }
  return report.samples.filter(isSample);
}

function isSample(value: unknown): value is Sample {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const sample = value as Partial<Sample>;
  return (
    typeof sample.index === 'number' &&
    typeof sample.ok === 'boolean' &&
    typeof sample.phases === 'object' &&
    sample.phases !== null
  );
}

function compareSummaries(current: LatencyReport['summary'], previous: LatencyReport['summary']) {
  return {
    ttftP50DeltaMs: nullableDelta(current.ttftMs.p50, previous.ttftMs.p50),
    ttftP95DeltaMs: nullableDelta(current.ttftMs.p95, previous.ttftMs.p95),
    ttftP99DeltaMs: nullableDelta(current.ttftMs.p99, previous.ttftMs.p99),
    dispatchP50DeltaMs: nullableDelta(current.dispatchMs.p50, previous.dispatchMs.p50),
    dispatchP95DeltaMs: nullableDelta(current.dispatchMs.p95, previous.dispatchMs.p95),
    ttftP50ReductionPct: reductionPct(current.ttftMs.p50, previous.ttftMs.p50),
    ttftP95ReductionPct: reductionPct(current.ttftMs.p95, previous.ttftMs.p95),
    ttftP99ReductionPct: reductionPct(current.ttftMs.p99, previous.ttftMs.p99),
    dispatchP50ReductionPct: reductionPct(current.dispatchMs.p50, previous.dispatchMs.p50),
    dispatchP95ReductionPct: reductionPct(current.dispatchMs.p95, previous.dispatchMs.p95),
  };
}

function nullableDelta(current: number | null, previous: number | null): number | null {
  return current === null || previous === null ? null : current - previous;
}

function reductionPct(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) {
    return null;
  }
  return ((previous - current) / previous) * 100;
}

function persistReport(report: LatencyReport): void {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

function persistCheckpoint(completed: Sample[]): void {
  const report = buildReport(completed);
  report.comparison = {
    checkpoint: true,
    note: 'Intermediate checkpoint written after each sample. Final comparison is rebuilt when the benchmark exits normally.',
  };
  persistReport(report);
}

function printSummary(report: LatencyReport): void {
  console.log('');
  console.log('Summary');
  console.log(`successful=${report.successfulSamples}/${report.samplesRequested} attempts=${report.attempts} failed=${report.failedSamples}`);
  console.log(`ttft.p50=${format(report.summary.ttftMs.p50)} ttft.p95=${format(report.summary.ttftMs.p95)} ttft.p99=${format(report.summary.ttftMs.p99)}`);
  console.log(`contentTtft.p50=${format(report.summary.contentTtftMs.p50)} contentTtft.p95=${format(report.summary.contentTtftMs.p95)}`);
  console.log(`dispatch.p50=${format(report.summary.dispatchMs.p50)} dispatch.p95=${format(report.summary.dispatchMs.p95)} dispatch.p99=${format(report.summary.dispatchMs.p99)}`);
  console.log(`upstreamToSse.p50=${format(report.summary.upstreamToSseMs.p50)} upstreamToSse.p95=${format(report.summary.upstreamToSseMs.p95)}`);
  console.log(`bridgeVisibleOverhead.p50=${format(report.summary.bridgeVisibleOverheadMs.p50)} bridgeVisibleOverhead.p95=${format(report.summary.bridgeVisibleOverheadMs.p95)}`);
  console.log(`report=${path.resolve(outputPath)}`);
  console.log(`comparison=${JSON.stringify(report.comparison)}`);
}

function validateReport(report: LatencyReport): void {
  const failures: string[] = [];

  if (report.successfulSamples < report.samplesRequested) {
    failures.push(`only ${report.successfulSamples}/${report.samplesRequested} requested samples succeeded`);
  }

  if (requireNative && !hasNativeComparison(report)) {
    failures.push('native comparison is required but missing');
  }

  if (failures.length > 0 && !allowPartial) {
    throw new Error(`Latency benchmark did not meet evidence gate: ${failures.join('; ')}`);
  }

  if (failures.length > 0) {
    console.warn(`Partial latency report: ${failures.join('; ')}`);
  }
}

function hasNativeComparison(report: LatencyReport): boolean {
  const comparison = report.comparison;
  if (!comparison || typeof comparison !== 'object') {
    return false;
  }

  const nativeEndpoint = comparison.nativeEndpoint as { count?: unknown } | undefined;
  if (nativeEndpoint && typeof nativeEndpoint.count === 'number' && nativeEndpoint.count > 0) {
    return true;
  }

  if ('nativeReport' in comparison || 'nativeTtftMs' in comparison) {
    return true;
  }

  return false;
}

function format(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(2)}ms`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
