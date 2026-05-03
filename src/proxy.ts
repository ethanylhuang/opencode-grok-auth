import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PORT = Number(process.env.GROK_PROXY_PORT ?? process.env.PORT ?? 11434);
const HOST = process.env.GROK_PROXY_HOST ?? '127.0.0.1';
const EXTENSION_TTL_MS = Number(process.env.GROK_EXTENSION_TTL_MS ?? 60_000);
const JOB_TIMEOUT_MS = Number(process.env.GROK_JOB_TIMEOUT_MS ?? 120_000);
const LONG_POLL_MS = Number(process.env.GROK_LONG_POLL_MS ?? 25_000);
const MAX_BODY_BYTES = Number(process.env.GROK_MAX_BODY_BYTES ?? 1_000_000);
const CHROME_PROFILE_DIR =
  process.env.GROK_CHROME_PROFILE_DIR ??
  path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default');
const CHROME_EXTENSION_ID = process.env.GROK_EXTENSION_ID ?? 'fodbpllijbgbjnhhimbojapinpdhfkae';
const TEMPLATE_RECOVERY_INTERVAL_MS = 5_000;

type ChatMessage = {
  role?: string;
  content?: unknown;
  name?: string;
};

type OpenAIChatRequest = {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
};

type BridgeHeartbeat = {
  workerId?: string;
  activeGrokTab?: boolean;
  hasRequestTemplate?: boolean;
  url?: string;
  manifestVersion?: string;
  backgroundCodeVersion?: string;
  templateInstallSource?: string;
  templateInstallError?: string;
};

type BridgeTemplate = {
  url?: unknown;
  body?: unknown;
  headers?: unknown;
  referer?: unknown;
  observedAt?: unknown;
};

type JobState = 'queued' | 'assigned' | 'streaming' | 'completed' | 'failed' | 'cancelled';
const TIMING_NAMES = [
  'requestReceivedAt',
  'jobQueuedAt',
  'jobAssignedAt',
  'streamHeadersFlushedAt',
  'contentScriptAcceptedAt',
  'grokFetchStartedAt',
  'grokResponseHeadersAt',
  'firstRawUpstreamChunkAt',
  'firstParsedNonThinkingTokenAt',
] as const;
type TimingName = (typeof TIMING_NAMES)[number];
type TimingMap = Partial<Record<TimingName, number>>;

const TIMING_NAME_SET = new Set<string>(TIMING_NAMES);

type BridgeJob = {
  id: string;
  createdAt: number;
  assignedAt: number | null;
  state: JobState;
  request: OpenAIChatRequest;
  prompt: string;
  model: string;
  text: string;
  parserBuffer: string;
  error: string | null;
  debugTiming: boolean;
  timings: TimingMap;
  timer: NodeJS.Timeout;
  events: EventEmitter;
};

type ParsedObjects = {
  objects: unknown[];
  remainder: string;
  error: string | null;
};

const jobs = new Map<string, BridgeJob>();
const queue: string[] = [];
const waiters: Array<() => void> = [];

const metrics = {
  createdJobs: 0,
  assignedJobs: 0,
  completedJobs: 0,
  failedJobs: 0,
  cancelledJobs: 0,
  rawChunks: 0,
  emittedTokens: 0,
  emittedBytes: 0,
};

let lastHeartbeat = {
  at: 0,
  workerId: '',
  activeGrokTab: false,
  hasRequestTemplate: false,
  url: '',
  manifestVersion: '',
  backgroundCodeVersion: '',
  templateInstallSource: '',
  templateInstallError: '',
};
let templateOverride: BridgeTemplate | null = null;
let lastTemplateRecoveryAt = 0;

function isLocalAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function setCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Grok-Bridge-Id, X-Grok-Debug-Timing',
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Grok-Job-Id');
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
  }
  res.end(JSON.stringify(value));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    error: {
      message,
      type: status >= 500 ? 'bridge_error' : 'invalid_request_error',
    },
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const body = await readBody(req);
  if (!body.trim()) {
    return {} as T;
  }
  return JSON.parse(body) as T;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object') {
          const item = part as { text?: unknown; type?: unknown };
          if (typeof item.text === 'string') {
            return item.text;
          }
          if (typeof item.type === 'string') {
            return `[${item.type}]`;
          }
        }
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }

  if (content == null) {
    return '';
  }

  return JSON.stringify(content);
}

function flattenMessages(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role ?? 'user';
      const text = contentToText(message.content).trim();
      return text ? `${role}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function conversationIdFromResponseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/rest\/app-chat\/conversations\/([^/]+)\/responses$/);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

function conversationIdFromReferer(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/c\/([^/?#]+)/);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

function isValidBridgeTemplate(value: unknown): value is BridgeTemplate {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const template = value as BridgeTemplate;
  if (typeof template.url !== 'string' || !template.body || typeof template.body !== 'object') {
    return false;
  }

  const urlConversationId = conversationIdFromResponseUrl(template.url);
  if (!urlConversationId) {
    return false;
  }

  const refererConversationId = conversationIdFromReferer(template.referer);
  if (refererConversationId && refererConversationId !== urlConversationId) {
    return false;
  }

  const body = template.body as Record<string, unknown>;
  if (typeof body.parentResponseId !== 'string' || body.parentResponseId.length === 0) {
    return false;
  }

  return body.disableMemory !== true && body.forceConcise !== true;
}

function sanitizeTemplateHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  const clean: Record<string, string> = {};
  const blocked = new Set([
    'authorization',
    'connection',
    'content-length',
    'cookie',
    'host',
    'origin',
    'proxy-authorization',
    'referer',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'set-cookie',
  ]);

  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    const normalized = name.toLowerCase();
    if (!blocked.has(normalized) && typeof value === 'string') {
      clean[normalized] = value;
    }
  }

  return clean;
}

function normalizeBridgeTemplate(template: BridgeTemplate): BridgeTemplate {
  return {
    url: template.url,
    body: template.body,
    headers: sanitizeTemplateHeaders(template.headers),
    referer: typeof template.referer === 'string' ? template.referer : '',
    observedAt: typeof template.observedAt === 'number' ? template.observedAt : Date.now(),
  };
}

function parseJsonObjectAt(text: string, start: number): unknown | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function recoverTemplateOverrideFromChromeStorage(): BridgeTemplate | null {
  const storageDir = path.join(CHROME_PROFILE_DIR, 'Local Extension Settings', CHROME_EXTENSION_ID);
  if (!fs.existsSync(storageDir)) {
    return null;
  }

  const candidates: BridgeTemplate[] = [];
  for (const fileName of fs.readdirSync(storageDir)) {
    if (!/\.(log|ldb)$/.test(fileName)) {
      continue;
    }

    const text = fs.readFileSync(path.join(storageDir, fileName), 'utf8');
    for (let start = text.indexOf('{"body":'); start !== -1; start = text.indexOf('{"body":', start + 1)) {
      const parsed = parseJsonObjectAt(text, start);
      if (isValidBridgeTemplate(parsed)) {
        candidates.push(normalizeBridgeTemplate(parsed));
      }
    }
  }

  candidates.sort((left, right) => Number(right.observedAt ?? 0) - Number(left.observedAt ?? 0));
  return candidates[0] ?? null;
}

function ensureTemplateOverrideRecovered(): void {
  if (templateOverride || Date.now() - lastTemplateRecoveryAt < TEMPLATE_RECOVERY_INTERVAL_MS) {
    return;
  }

  lastTemplateRecoveryAt = Date.now();
  try {
    const recovered = recoverTemplateOverrideFromChromeStorage();
    if (recovered) {
      templateOverride = recovered;
      console.log(`Recovered Grok request template from Chrome storage: ${String(recovered.url)}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not recover Grok request template from Chrome storage: ${message}`);
  }
}

function bridgeStatus() {
  ensureTemplateOverrideRecovered();

  const ageMs = lastHeartbeat.at === 0 ? null : Date.now() - lastHeartbeat.at;
  const connected = ageMs !== null && ageMs <= EXTENSION_TTL_MS;
  const proxyHasTemplateOverride = Boolean(templateOverride);

  return {
    connected,
    ageMs,
    workerId: lastHeartbeat.workerId || null,
    activeGrokTab: lastHeartbeat.activeGrokTab,
    hasRequestTemplate: lastHeartbeat.hasRequestTemplate || proxyHasTemplateOverride,
    extensionHasRequestTemplate: lastHeartbeat.hasRequestTemplate,
    proxyHasTemplateOverride,
    url: lastHeartbeat.url || null,
    manifestVersion: lastHeartbeat.manifestVersion || null,
    backgroundCodeVersion: lastHeartbeat.backgroundCodeVersion || null,
    templateInstallSource: lastHeartbeat.templateInstallSource || null,
    templateInstallError: lastHeartbeat.templateInstallError || null,
  };
}

function isBridgeReady(): boolean {
  const status = bridgeStatus();
  return status.connected && status.activeGrokTab && status.hasRequestTemplate;
}

function wantsDebugTiming(req: http.IncomingMessage): boolean {
  const value = req.headers['x-grok-debug-timing'];
  if (Array.isArray(value)) {
    return value.some((item) => item === '1' || item.toLowerCase() === 'true');
  }
  return value === '1' || value?.toLowerCase() === 'true';
}

function createJob(
  request: OpenAIChatRequest,
  prompt: string,
  options: { requestReceivedAt: number; debugTiming: boolean },
): BridgeJob {
  const queuedAt = Date.now();
  const job: BridgeJob = {
    id: randomUUID(),
    createdAt: queuedAt,
    assignedAt: null,
    state: 'queued',
    request,
    prompt,
    model: request.model ?? 'grok-latest',
    text: '',
    parserBuffer: '',
    error: null,
    debugTiming: options.debugTiming,
    timings: {
      requestReceivedAt: options.requestReceivedAt,
      jobQueuedAt: queuedAt,
    },
    timer: setTimeout(() => {
      failJob(job, `Timed out waiting for Grok extension response after ${JOB_TIMEOUT_MS} ms`);
    }, JOB_TIMEOUT_MS),
    events: new EventEmitter(),
  };

  jobs.set(job.id, job);
  queue.push(job.id);
  metrics.createdJobs += 1;
  notifyWaiters();

  return job;
}

function timingSnapshot(job: BridgeJob) {
  const baseAt = job.timings.requestReceivedAt ?? job.createdAt;
  const timings = Object.fromEntries(
    Object.entries(job.timings)
      .filter((entry): entry is [TimingName, number] => typeof entry[1] === 'number')
      .map(([name, at]) => [name, { at, ms: at - baseAt }]),
  );

  return {
    jobId: job.id,
    baseAt,
    state: job.state,
    timings,
  };
}

function normalizeTimingMap(value: unknown): TimingMap {
  const timings: TimingMap = {};

  if (!value || typeof value !== 'object') {
    return timings;
  }

  for (const [name, at] of Object.entries(value as Record<string, unknown>)) {
    if (TIMING_NAME_SET.has(name) && typeof at === 'number' && Number.isFinite(at)) {
      timings[name as TimingName] = at;
    }
  }

  return timings;
}

function markTimings(job: BridgeJob, timings: TimingMap): void {
  let changed = false;

  for (const [name, at] of Object.entries(timings) as Array<[TimingName, number]>) {
    if (job.timings[name] === undefined) {
      job.timings[name] = at;
      changed = true;
    }
  }

  if (changed) {
    job.events.emit('timing', timingSnapshot(job));
  }
}

function markTiming(job: BridgeJob, name: TimingName, at = Date.now()): void {
  markTimings(job, { [name]: at } as TimingMap);
}

function removeJob(job: BridgeJob): void {
  clearTimeout(job.timer);
  jobs.delete(job.id);
}

function completeJob(job: BridgeJob): void {
  if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
    return;
  }

  job.state = 'completed';
  metrics.completedJobs += 1;
  job.events.emit('done');
  removeJob(job);
}

function failJob(job: BridgeJob, message: string): void {
  if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
    return;
  }

  job.state = 'failed';
  job.error = message;
  metrics.failedJobs += 1;
  job.events.emit('error', message);
  removeJob(job);
}

function cancelJob(job: BridgeJob): void {
  if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
    return;
  }

  job.state = 'cancelled';
  metrics.cancelledJobs += 1;
  job.events.emit('error', 'Client disconnected before completion');
  removeJob(job);
}

function dequeueJob(): BridgeJob | null {
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) {
      continue;
    }

    const job = jobs.get(id);
    if (job && job.state === 'queued') {
      job.state = 'assigned';
      job.assignedAt = Date.now();
      markTiming(job, 'jobAssignedAt', job.assignedAt);
      metrics.assignedJobs += 1;
      return job;
    }
  }

  return null;
}

function notifyWaiters(): void {
  const pending = waiters.splice(0);
  for (const waiter of pending) {
    waiter();
  }
}

function waitForJob(): Promise<BridgeJob | null> {
  const available = dequeueJob();
  if (available) {
    return Promise.resolve(available);
  }

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(null);
    }, LONG_POLL_MS);

    waiters.push(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(dequeueJob());
    });
  });
}

function parseConcatenatedJson(buffer: string): ParsedObjects {
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  let lastEnd = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth < 0) {
        return { objects, remainder: '', error: 'Unexpected closing brace in Grok stream' };
      }

      if (depth === 0 && start !== -1) {
        const json = buffer.slice(start, index + 1);
        try {
          objects.push(JSON.parse(json));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { objects, remainder: '', error: `Invalid JSON object in Grok stream: ${message}` };
        }
        lastEnd = index + 1;
        start = -1;
      }
    }
  }

  const remainder = start === -1 ? buffer.slice(lastEnd).trimStart() : buffer.slice(start);
  return { objects, remainder, error: null };
}

function tokenFromGrokObject(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const object = value as {
    token?: unknown;
    result?: {
      token?: unknown;
      isThinking?: unknown;
    };
  };

  if (object.result && object.result.isThinking !== true && typeof object.result.token === 'string') {
    return object.result.token;
  }

  if (typeof object.token === 'string') {
    return object.token;
  }

  return null;
}

function emitToken(job: BridgeJob, token: string): void {
  if (!token || job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
    return;
  }

  markTiming(job, 'firstParsedNonThinkingTokenAt');
  job.state = 'streaming';
  job.text += token;
  metrics.emittedTokens += 1;
  metrics.emittedBytes += Buffer.byteLength(token);
  job.events.emit('token', token);
}

function ingestGrokChunk(job: BridgeJob, chunk: string): void {
  metrics.rawChunks += 1;
  job.parserBuffer += chunk;

  const parsed = parseConcatenatedJson(job.parserBuffer);
  if (parsed.error) {
    failJob(job, `Grok stream parse failure: ${parsed.error}`);
    return;
  }

  job.parserBuffer = parsed.remainder;

  for (const object of parsed.objects) {
    const token = tokenFromGrokObject(object);
    if (token !== null) {
      emitToken(job, token);
    }
  }
}

function writeOpenAIStreamChunk(
  res: http.ServerResponse,
  job: BridgeJob,
  content: string,
  finishReason: string | null,
): void {
  const choice = finishReason
    ? { delta: {}, index: 0, finish_reason: finishReason }
    : { delta: { content }, index: 0, finish_reason: null };

  const payload = {
    id: `chatcmpl-${job.id}`,
    object: 'chat.completion.chunk',
    created: Math.floor(job.createdAt / 1000),
    model: job.model,
    choices: [choice],
  };

  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamJob(req: http.IncomingMessage, res: http.ServerResponse, job: BridgeJob): void {
  let ended = false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Grok-Job-Id': job.id,
  });
  res.flushHeaders();
  markTiming(job, 'streamHeadersFlushedAt');

  const writeTiming = () => {
    if (job.debugTiming && !ended && !res.destroyed) {
      res.write(`event: grok-timing\ndata: ${JSON.stringify(timingSnapshot(job))}\n\n`);
    }
  };

  const cleanup = () => {
    job.events.off('token', onToken);
    job.events.off('done', onDone);
    job.events.off('error', onError);
    job.events.off('timing', onTiming);
  };

  const finish = () => {
    if (ended) {
      return;
    }
    ended = true;
    cleanup();
    res.end();
  };

  const onToken = (token: string) => {
    writeOpenAIStreamChunk(res, job, token, null);
  };

  const onDone = () => {
    writeOpenAIStreamChunk(res, job, '', 'stop');
    res.write('data: [DONE]\n\n');
    finish();
  };

  const onError = (message: string) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error: { message, type: 'bridge_error' } })}\n\n`);
    res.write('data: [DONE]\n\n');
    finish();
  };

  const onTiming = () => {
    writeTiming();
  };

  job.events.on('token', onToken);
  job.events.once('done', onDone);
  job.events.once('error', onError);
  job.events.on('timing', onTiming);
  writeTiming();

  req.on('close', () => {
    if (!ended) {
      cleanup();
      cancelJob(job);
    }
  });
}

function waitForCompletion(job: BridgeJob): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      job.events.off('done', onDone);
      job.events.off('error', onError);
    };

    const onDone = () => {
      cleanup();
      resolve(job.text);
    };

    const onError = (message: string) => {
      cleanup();
      reject(new Error(message));
    };

    job.events.once('done', onDone);
    job.events.once('error', onError);
  });
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const requestReceivedAt = Date.now();

  if (!isBridgeReady()) {
    sendError(
      res,
      503,
      'Grok extension bridge is not ready. Open grok.com in Chrome, install the extension, and send one normal Grok message so the request template can be captured.',
    );
    return;
  }

  const openAIRequest = await readJson<OpenAIChatRequest>(req);
  if (!Array.isArray(openAIRequest.messages)) {
    sendError(res, 400, 'Expected OpenAI-compatible request body with messages[]');
    return;
  }

  const prompt = flattenMessages(openAIRequest.messages);
  if (!prompt) {
    sendError(res, 400, 'messages[] did not contain any text content');
    return;
  }

  const job = createJob(openAIRequest, prompt, {
    requestReceivedAt,
    debugTiming: wantsDebugTiming(req),
  });

  if (openAIRequest.stream !== false) {
    streamJob(req, res, job);
    return;
  }

  try {
    const text = await waitForCompletion(job);
    sendJson(res, 200, {
      id: `chatcmpl-${job.id}`,
      object: 'chat.completion',
      created: Math.floor(job.createdAt / 1000),
      model: job.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 502, message);
  }
}

async function handleHeartbeat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const heartbeat = await readJson<BridgeHeartbeat>(req);
  lastHeartbeat = {
    at: Date.now(),
    workerId: typeof heartbeat.workerId === 'string' ? heartbeat.workerId : '',
    activeGrokTab: heartbeat.activeGrokTab === true,
    hasRequestTemplate: heartbeat.hasRequestTemplate === true,
    url: typeof heartbeat.url === 'string' ? heartbeat.url : '',
    manifestVersion: typeof heartbeat.manifestVersion === 'string' ? heartbeat.manifestVersion : '',
    backgroundCodeVersion: typeof heartbeat.backgroundCodeVersion === 'string' ? heartbeat.backgroundCodeVersion : '',
    templateInstallSource: typeof heartbeat.templateInstallSource === 'string' ? heartbeat.templateInstallSource : '',
    templateInstallError: typeof heartbeat.templateInstallError === 'string' ? heartbeat.templateInstallError : '',
  };

  sendJson(res, 200, {
    ok: true,
    bridge: bridgeStatus(),
    templateOverride,
  });
}

async function handleBridgeTemplate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const template = await readJson<BridgeTemplate>(req);
  if (!isValidBridgeTemplate(template)) {
    sendError(res, 400, 'Expected valid bridge template with Grok response url, body, and parentResponseId');
    return;
  }

  templateOverride = normalizeBridgeTemplate(template);

  sendJson(res, 200, { ok: true });
}

async function handlePollJob(res: http.ServerResponse): Promise<void> {
  const job = await waitForJob();
  if (!job) {
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 200, {
    id: job.id,
    createdAt: job.createdAt,
    model: job.model,
    prompt: job.prompt,
    messages: job.request.messages ?? [],
    requestTemplate: templateOverride,
  });
}

async function handleJobChunk(req: http.IncomingMessage, res: http.ServerResponse, jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    sendError(res, 404, `Unknown bridge job ${jobId}`);
    return;
  }

  const body = await readJson<{ chunk?: unknown; timings?: unknown }>(req);
  if (typeof body.chunk !== 'string') {
    sendError(res, 400, 'Expected JSON body with string field chunk');
    return;
  }

  const timings = normalizeTimingMap(body.timings);
  if (timings.firstRawUpstreamChunkAt === undefined && job.timings.firstRawUpstreamChunkAt === undefined) {
    timings.firstRawUpstreamChunkAt = Date.now();
  }
  markTimings(job, timings);

  ingestGrokChunk(job, body.chunk);
  sendJson(res, 200, { ok: true });
}

async function handleJobTiming(req: http.IncomingMessage, res: http.ServerResponse, jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    sendError(res, 404, `Unknown bridge job ${jobId}`);
    return;
  }

  const body = await readJson<{ timings?: unknown }>(req);
  const timings = normalizeTimingMap(body.timings);
  markTimings(job, timings);
  sendJson(res, 200, { ok: true, timing: timingSnapshot(job) });
}

async function handleJobComplete(req: http.IncomingMessage, res: http.ServerResponse, jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    sendError(res, 404, `Unknown bridge job ${jobId}`);
    return;
  }

  const body = await readJson<{ ok?: unknown; error?: unknown }>(req);
  if (body.ok === false || typeof body.error === 'string') {
    failJob(job, typeof body.error === 'string' ? body.error : 'Grok extension reported an upstream error');
    sendJson(res, 200, { ok: true });
    return;
  }

  completeJob(job);
  sendJson(res, 200, { ok: true });
}

function healthPayload() {
  return {
    ok: true,
    bridge: bridgeStatus(),
    jobs: {
      queued: queue.length,
      active: jobs.size,
    },
    metrics,
  };
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (!isLocalAddress(req.socket.remoteAddress)) {
    sendError(res, 403, 'Localhost access only');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, healthPayload());
    return;
  }

  if (req.method === 'GET' && path === '/metrics') {
    sendJson(res, 200, metrics);
    return;
  }

  if (req.method === 'GET' && path === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: 'grok-latest', object: 'model', owned_by: 'grok.com-browser-session' }],
    });
    return;
  }

  if (req.method === 'POST' && path === '/bridge/heartbeat') {
    await handleHeartbeat(req, res);
    return;
  }

  if (req.method === 'POST' && path === '/bridge/template') {
    await handleBridgeTemplate(req, res);
    return;
  }

  if (req.method === 'GET' && path === '/bridge/jobs') {
    await handlePollJob(res);
    return;
  }

  const chunkMatch = path.match(/^\/bridge\/jobs\/([^/]+)\/chunks$/);
  if (req.method === 'POST' && chunkMatch?.[1]) {
    await handleJobChunk(req, res, chunkMatch[1]);
    return;
  }

  const timingMatch = path.match(/^\/bridge\/jobs\/([^/]+)\/timing$/);
  if (req.method === 'POST' && timingMatch?.[1]) {
    await handleJobTiming(req, res, timingMatch[1]);
    return;
  }

  const completeMatch = path.match(/^\/bridge\/jobs\/([^/]+)\/complete$/);
  if (req.method === 'POST' && completeMatch?.[1]) {
    await handleJobComplete(req, res, completeMatch[1]);
    return;
  }

  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    await handleChat(req, res);
    return;
  }

  sendError(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      sendError(res, 500, message);
      return;
    }
    res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Grok OpenAI-compatible proxy listening on http://${HOST}:${PORT}`);
  console.log('Bridge mode: waiting for Chrome extension heartbeat on /bridge/heartbeat');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
