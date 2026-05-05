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
const FAST_PATH_ENABLED = process.env.GROK_FAST_PATH !== '0';
const POLL_FALLBACK_ENABLED = process.env.GROK_POLL_FALLBACK !== '0';
const DEBUG_PARSE = process.env.GROK_DEBUG_PARSE === '1';
const REQUIRED_BACKGROUND_CODE_VERSION = 'm4-push-port-v8';
const PUSH_KEEPALIVE_MS = Number(process.env.GROK_PUSH_KEEPALIVE_MS ?? 15_000);
const CHROME_PROFILE_DIR =
  process.env.GROK_CHROME_PROFILE_DIR ??
  path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default');
const CHROME_EXTENSION_ID = process.env.GROK_EXTENSION_ID ?? 'fodbpllijbgbjnhhimbojapinpdhfkae';
const DISABLE_TEMPLATE_RECOVERY = process.env.GROK_DISABLE_TEMPLATE_RECOVERY === '1';
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
  conversationId?: string;
  parentResponseId?: string;
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

type NativeTimingBody = {
  workerId?: unknown;
  url?: unknown;
  status?: unknown;
  timings?: unknown;
  error?: unknown;
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
  'workerNotifiedAt',
  'workerAcceptedAt',
  'jobAssignedAt',
  'streamHeadersFlushedAt',
  'contentScriptAcceptedAt',
  'grokFetchStartedAt',
  'grokResponseHeadersAt',
  'firstRawUpstreamChunkAt',
  'firstParsedReasoningTokenAt',
  'firstParsedNonThinkingTokenAt',
  'firstSseChunkAt',
] as const;
type TimingName = (typeof TIMING_NAMES)[number];
type TimingMap = Partial<Record<TimingName, number>>;

const TIMING_NAME_SET = new Set<string>(TIMING_NAMES);

type BridgeJob = {
  id: string;
  createdAt: number;
  assignedAt: number | null;
  workerId: string | null;
  state: JobState;
  request: OpenAIChatRequest;
  prompt: string;
  model: string;
  isNewConversation: boolean;
  conversationId: string | null;
  parentResponseId: string | null;
  responseId: string | null;
  text: string;
  parserBuffer: string;
  error: string | null;
  debugTiming: boolean;
  timings: TimingMap;
  timer: NodeJS.Timeout;
  events: EventEmitter;
};

type WorkerConnection = {
  workerId: string;
  connectedAt: number;
  lastSeenAt: number;
  capabilities: string[];
  res: http.ServerResponse;
  keepalive: NodeJS.Timeout;
};

type WorkerHeartbeat = {
  at: number;
  workerId: string;
  activeGrokTab: boolean;
  hasRequestTemplate: boolean;
  url: string;
  manifestVersion: string;
  backgroundCodeVersion: string;
  templateInstallSource: string;
  templateInstallError: string;
};

type ParsedObjects = {
  objects: unknown[];
  remainder: string;
  error: string | null;
};

type GrokResponseMetadata = {
  conversationId?: string;
  responseId?: string;
};

const CONVERSATION_ID_KEYS = ['conversationId', 'conversation_id', 'conversationID'] as const;
const RESPONSE_ID_KEYS = ['responseId', 'response_id', 'responseID'] as const;

const jobs = new Map<string, BridgeJob>();
const queue: string[] = [];
const waiters: Array<() => void> = [];
const workerConnections = new Map<string, WorkerConnection>();
const workerHeartbeats = new Map<string, WorkerHeartbeat>();
const nativeTimings: Array<{
  observedAt: number;
  workerId: string | null;
  url: string | null;
  status: number | null;
  error: string | null;
  timings: Record<string, number>;
}> = [];
const MAX_NATIVE_TIMINGS = 200;

const metrics = {
  createdJobs: 0,
  assignedJobs: 0,
  completedJobs: 0,
  failedJobs: 0,
  cancelledJobs: 0,
  rawChunks: 0,
  emittedReasoningTokens: 0,
  emittedReasoningBytes: 0,
  emittedTokens: 0,
  emittedBytes: 0,
  pushConnections: 0,
  pushDisconnects: 0,
  pushedJobs: 0,
  polledJobs: 0,
  acceptedJobs: 0,
  prewarmRequests: 0,
  nativeProbeRequests: 0,
  nativeTimingSamples: 0,
};

let lastHeartbeat: WorkerHeartbeat = {
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
let newTemplateOverride: BridgeTemplate | null = null;
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
    if (parsed.pathname === '/rest/app-chat/conversations/new') {
      return 'new';
    }
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
  if (urlConversationId !== 'new' && refererConversationId && refererConversationId !== urlConversationId) {
    return false;
  }

  const body = template.body as Record<string, unknown>;
  if (urlConversationId !== 'new') {
    if (typeof body.parentResponseId !== 'string' || body.parentResponseId.length === 0) {
      return false;
    }
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

function recoverTemplatesFromChromeStorage(): { regular: BridgeTemplate | null; newConv: BridgeTemplate | null } {
  const storageDir = path.join(CHROME_PROFILE_DIR, 'Local Extension Settings', CHROME_EXTENSION_ID);
  if (!fs.existsSync(storageDir)) {
    return { regular: null, newConv: null };
  }

  const regularCandidates: BridgeTemplate[] = [];
  const newCandidates: BridgeTemplate[] = [];

  for (const fileName of fs.readdirSync(storageDir)) {
    if (!/\.(log|ldb)$/.test(fileName)) {
      continue;
    }

    const text = fs.readFileSync(path.join(storageDir, fileName), 'utf8');
    for (let start = text.indexOf('{"body":'); start !== -1; start = text.indexOf('{"body":', start + 1)) {
      const parsed = parseJsonObjectAt(text, start);
      if (isValidBridgeTemplate(parsed)) {
        const normalized = normalizeBridgeTemplate(parsed);
        const convId = conversationIdFromResponseUrl(normalized.url as string);
        if (convId === 'new') {
          newCandidates.push(normalized);
        } else {
          regularCandidates.push(normalized);
        }
      }
    }
  }

  regularCandidates.sort((left, right) => Number(right.observedAt ?? 0) - Number(left.observedAt ?? 0));
  newCandidates.sort((left, right) => Number(right.observedAt ?? 0) - Number(left.observedAt ?? 0));

  return {
    regular: regularCandidates[0] ?? null,
    newConv: newCandidates[0] ?? null,
  };
}

function ensureTemplateOverrideRecovered(): void {
  if (DISABLE_TEMPLATE_RECOVERY) {
    return;
  }

  if ((templateOverride && newTemplateOverride) || Date.now() - lastTemplateRecoveryAt < TEMPLATE_RECOVERY_INTERVAL_MS) {
    return;
  }

  lastTemplateRecoveryAt = Date.now();
  try {
    const { regular, newConv } = recoverTemplatesFromChromeStorage();
    if (regular) {
      templateOverride = regular;
      console.log(`Recovered regular Grok request template from Chrome storage: ${regular.url}`);
    }
    if (newConv) {
      newTemplateOverride = newConv;
      console.log(`Recovered new-conversation Grok request template from Chrome storage: ${newConv.url}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not recover Grok request templates from Chrome storage: ${message}`);
  }
}

function connectedHeartbeats(now = Date.now()): WorkerHeartbeat[] {
  const connected: WorkerHeartbeat[] = [];

  for (const [workerId, heartbeat] of workerHeartbeats) {
    if (now - heartbeat.at <= EXTENSION_TTL_MS) {
      connected.push(heartbeat);
    } else {
      workerHeartbeats.delete(workerId);
    }
  }

  return connected;
}

function heartbeatHasTemplate(heartbeat: WorkerHeartbeat | undefined, proxyHasTemplate: boolean): boolean {
  return Boolean(heartbeat?.hasRequestTemplate || proxyHasTemplate);
}

function isRequiredWorkerVersion(heartbeat: WorkerHeartbeat | undefined): boolean {
  return heartbeat?.backgroundCodeVersion === REQUIRED_BACKGROUND_CODE_VERSION;
}

function displayHeartbeat(heartbeats: WorkerHeartbeat[], connectedWorkerIds: string[]): WorkerHeartbeat {
  const currentConnected = heartbeats.find((heartbeat) => {
    return isRequiredWorkerVersion(heartbeat) && connectedWorkerIds.includes(heartbeat.workerId);
  });
  if (currentConnected) {
    return currentConnected;
  }

  const current = heartbeats.find(isRequiredWorkerVersion);
  if (current) {
    return current;
  }

  const m4Connected = heartbeats.find((heartbeat) => {
    return heartbeat.backgroundCodeVersion.startsWith('m4-push-port-') && connectedWorkerIds.includes(heartbeat.workerId);
  });
  if (m4Connected) {
    return m4Connected;
  }

  return heartbeats[0] ?? lastHeartbeat;
}

function bridgeStatus() {
  ensureTemplateOverrideRecovered();

  const now = Date.now();
  const proxyHasTemplateOverride = Boolean(templateOverride);
  const proxyHasNewTemplateOverride = Boolean(newTemplateOverride);
  const proxyHasAnyTemplateOverride = proxyHasTemplateOverride || proxyHasNewTemplateOverride;
  const heartbeats = connectedHeartbeats(now);
  const connectedWorkerIds = Array.from(workerConnections.keys());
  const heartbeat = displayHeartbeat(heartbeats, connectedWorkerIds);
  const ageMs = heartbeat.at === 0 ? null : now - heartbeat.at;
  const connected = heartbeats.length > 0;
  const controlChannelConnected = connectedWorkerIds.length > 0;
  const readyWorkerIds = connectedWorkerIds.filter((workerId) => {
    const workerHeartbeat = workerHeartbeats.get(workerId);
    return (
      workerHeartbeat &&
      isRequiredWorkerVersion(workerHeartbeat) &&
      now - workerHeartbeat.at <= EXTENSION_TTL_MS &&
      workerHeartbeat.activeGrokTab &&
      heartbeatHasTemplate(workerHeartbeat, proxyHasAnyTemplateOverride)
    );
  });
  const activeGrokTab = heartbeats.some((item) => item.activeGrokTab);
  const extensionHasRequestTemplate = heartbeats.some((item) => item.hasRequestTemplate);
  const hasRequestTemplate = extensionHasRequestTemplate || proxyHasAnyTemplateOverride;
  const fallbackWorkerReady = heartbeats.some((item) => {
    return (
      isRequiredWorkerVersion(item) &&
      item.activeGrokTab &&
      heartbeatHasTemplate(item, proxyHasAnyTemplateOverride)
    );
  });
  const warmReady =
    connected &&
    activeGrokTab &&
    hasRequestTemplate &&
    (!FAST_PATH_ENABLED || readyWorkerIds.length > 0);
  const fallbackReady =
    FAST_PATH_ENABLED &&
    POLL_FALLBACK_ENABLED &&
    fallbackWorkerReady;
  const requestReady = warmReady || fallbackReady;

  return {
    connected,
    ageMs,
    workerId: heartbeat.workerId || null,
    activeGrokTab,
    hasRequestTemplate,
    extensionHasRequestTemplate,
    proxyHasTemplateOverride,
    proxyHasNewTemplateOverride,
    warmReady,
    fallbackReady,
    requestReady,
    controlChannelConnected,
    connectedWorkerIds,
    readyWorkerIds,
    requiredBackgroundCodeVersion: REQUIRED_BACKGROUND_CODE_VERSION,
    fastPath: {
      enabled: FAST_PATH_ENABLED,
      pollingFallbackEnabled: POLL_FALLBACK_ENABLED,
    },
    workers: heartbeats.map((item) => ({
      workerId: item.workerId,
      ageMs: now - item.at,
      activeGrokTab: item.activeGrokTab,
      hasRequestTemplate: item.hasRequestTemplate,
      manifestVersion: item.manifestVersion || null,
      backgroundCodeVersion: item.backgroundCodeVersion || null,
    })),
    nativeTimingSamples: nativeTimings.length,
    latestNativeTiming: nativeTimings[nativeTimings.length - 1] ?? null,
    url: heartbeat.url || null,
    manifestVersion: heartbeat.manifestVersion || null,
    backgroundCodeVersion: heartbeat.backgroundCodeVersion || null,
    templateInstallSource: heartbeat.templateInstallSource || null,
    templateInstallError: heartbeat.templateInstallError || null,
  };
}

function bridgeNotReadyMessage(status: ReturnType<typeof bridgeStatus>): string {
  if (
    status.connected &&
    status.requiredBackgroundCodeVersion &&
    status.backgroundCodeVersion &&
    status.backgroundCodeVersion !== status.requiredBackgroundCodeVersion
  ) {
    const manifest = status.manifestVersion ? ` manifest ${status.manifestVersion},` : '';
    return `Grok extension bridge is stale. Loaded${manifest} background ${status.backgroundCodeVersion}; required background ${status.requiredBackgroundCodeVersion}. Reload the unpacked extension and refresh grok.com.`;
  }

  const missing: string[] = [];
  if (!status.connected) {
    missing.push('extension heartbeat');
  }
  if (status.activeGrokTab !== true) {
    missing.push('active Grok tab');
  }
  if (status.hasRequestTemplate !== true) {
    missing.push('request template');
  }
  if (status.fastPath.enabled && status.controlChannelConnected !== true) {
    missing.push('push channel');
  }

  const suffix = missing.length > 0 ? ` Missing: ${missing.join(', ')}.` : '';
  return `Grok extension bridge is not ready.${suffix} Open grok.com in Chrome, install or reload the extension, and send one normal Grok message so the request template can be captured.`;
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
  const isNewConversation = request.model === 'grok-latest-new';
  const conversationId =
    typeof request.conversationId === 'string' && request.conversationId.length > 0 ? request.conversationId : null;
  const parentResponseId =
    typeof request.parentResponseId === 'string' && request.parentResponseId.length > 0
      ? request.parentResponseId
      : null;
  const job: BridgeJob = {
    id: randomUUID(),
    createdAt: queuedAt,
    assignedAt: null,
    workerId: null,
    state: 'queued',
    request,
    prompt,
    model: request.model ?? 'grok-latest',
    isNewConversation,
    conversationId,
    parentResponseId,
    responseId: null,
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
  dispatchQueuedJobs();

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

function normalizeLooseTimings(value: unknown): Record<string, number> {
  const timings: Record<string, number> = {};

  if (!value || typeof value !== 'object') {
    return timings;
  }

  for (const [name, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof name === 'string' && typeof at === 'number' && Number.isFinite(at)) {
      timings[name] = at;
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
  dispatchQueuedJobs();
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
  dispatchQueuedJobs();
}

function cancelJob(job: BridgeJob): void {
  if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
    return;
  }

  job.state = 'cancelled';
  metrics.cancelledJobs += 1;
  job.events.emit('error', 'Client disconnected before completion');
  removeJob(job);
  dispatchQueuedJobs();
}

function dequeueJob(workerId = ''): BridgeJob | null {
  while (queue.length > 0) {
    const index = queue.findIndex((id) => {
      const job = jobs.get(id);
      return !job || job.state !== 'queued' || !workerId || !job.workerId || job.workerId === workerId;
    });

    if (index === -1) {
      return null;
    }

    const [id] = queue.splice(index, 1);
    const job = id ? jobs.get(id) : null;
    if (job && job.state === 'queued' && (!workerId || !job.workerId || job.workerId === workerId)) {
      job.state = 'assigned';
      if (workerId) {
        job.workerId = workerId;
      }
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

function waitForJob(workerId = '', timeoutMs = LONG_POLL_MS): Promise<BridgeJob | null> {
  const available = dequeueJob(workerId);
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
    }, timeoutMs);

    waiters.push(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(dequeueJob(workerId));
    });
  });
}

function hasActiveJobForWorker(workerId: string): boolean {
  for (const job of jobs.values()) {
    if (
      job.workerId === workerId &&
      (job.state === 'assigned' || job.state === 'streaming')
    ) {
      return true;
    }
  }

  return false;
}

function isWorkerWarmReady(workerId: string): boolean {
  ensureTemplateOverrideRecovered();
  const heartbeat = workerHeartbeats.get(workerId);
  if (!heartbeat || Date.now() - heartbeat.at > EXTENSION_TTL_MS) {
    return false;
  }

  return (
    isRequiredWorkerVersion(heartbeat) &&
    heartbeat.activeGrokTab &&
    heartbeatHasTemplate(heartbeat, Boolean(templateOverride || newTemplateOverride))
  );
}

function pollWorkerNotReadyMessage(workerId: string): string {
  const heartbeat = workerHeartbeats.get(workerId);
  if (!heartbeat || Date.now() - heartbeat.at > EXTENSION_TTL_MS) {
    return `Worker ${workerId} is not registered or heartbeat is stale`;
  }
  if (!isRequiredWorkerVersion(heartbeat)) {
    return `Worker ${workerId} is stale: loaded background ${heartbeat.backgroundCodeVersion || 'unknown'}; required background ${REQUIRED_BACKGROUND_CODE_VERSION}`;
  }
  if (!heartbeat.activeGrokTab) {
    return `Worker ${workerId} does not have an active Grok tab`;
  }
  if (!heartbeatHasTemplate(heartbeat, Boolean(templateOverride || newTemplateOverride))) {
    return `Worker ${workerId} does not have a request template`;
  }
  return `Worker ${workerId} is not ready`;
}

function jobPayload(job: BridgeJob) {
  const template = job.isNewConversation
    ? newTemplateOverride
    : job.conversationId
      ? templateOverride ?? newTemplateOverride
      : newTemplateOverride ?? templateOverride;

  return {
    id: job.id,
    createdAt: job.createdAt,
    model: job.model,
    prompt: job.prompt,
    conversationId: job.conversationId,
    parentResponseId: job.parentResponseId,
    responseId: job.responseId,
    messages: job.request.messages ?? [],
    requestTemplate: template,
  };
}

function writeWorkerEvent(connection: WorkerConnection, event: string, payload: unknown): boolean {
  if (connection.res.destroyed || connection.res.writableEnded) {
    return false;
  }

  connection.lastSeenAt = Date.now();
  try {
    connection.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function requeueJob(job: BridgeJob): void {
  if (!jobs.has(job.id) || job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
    return;
  }

  job.state = 'queued';
  job.assignedAt = null;
  queue.unshift(job.id);
}

function dispatchQueuedJobs(): void {
  if (!FAST_PATH_ENABLED || queue.length === 0 || workerConnections.size === 0) {
    return;
  }

  for (const connection of workerConnections.values()) {
    if (queue.length === 0) {
      return;
    }

    if (!isWorkerWarmReady(connection.workerId) || hasActiveJobForWorker(connection.workerId)) {
      continue;
    }

    const job = dequeueJob(connection.workerId);
    if (!job) {
      continue;
    }

    const workerNotifiedAt = Date.now();
    markTiming(job, 'workerNotifiedAt', workerNotifiedAt);
    const sent = writeWorkerEvent(connection, 'job', {
      ...jobPayload(job),
      timings: timingSnapshot(job),
    });

    if (!sent) {
      requeueJob(job);
      workerConnections.delete(connection.workerId);
      metrics.pushDisconnects += 1;
      continue;
    }

    metrics.pushedJobs += 1;
  }
}

function broadcastWorkerEvent(event: string, payload: unknown): number {
  let sent = 0;

  for (const connection of workerConnections.values()) {
    if (writeWorkerEvent(connection, event, payload)) {
      sent++;
    }
  }

  return sent;
}

function broadcastReadyWorkerEvent(event: string, payload: unknown): number {
  let sent = 0;

  for (const connection of workerConnections.values()) {
    if (!isWorkerWarmReady(connection.workerId)) {
      continue;
    }
    if (writeWorkerEvent(connection, event, payload)) {
      sent++;
    }
  }

  return sent;
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

  const object = value as Record<string, unknown>;

  // Handle /new format: {"result":{"response":{"token":"...","isThinking":false,...}}}
  const result = object.result as Record<string, unknown> | undefined;
  if (result) {
    const response = result.response as Record<string, unknown> | undefined;
    if (response) {
      const isThinking = response.isThinking;
      const token = response.token;
      if (isThinking !== true && typeof token === 'string') {
        return token;
      }
    }

    // Handle old format: {"result":{"token":"...","isThinking":false}}
    const isThinking = result.isThinking;
    const token = result.token;
    if (isThinking !== true && typeof token === 'string') {
      return token;
    }
  }

  // Handle direct token formats
  if (typeof object.token === 'string') {
    return object.token;
  }

  if (typeof object.text === 'string') {
    return object.text;
  }

  return null;
}

function reasoningTokenFromGrokObject(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const object = value as Record<string, unknown>;
  const result = object.result as Record<string, unknown> | undefined;
  if (!result) {
    return null;
  }

  const response = result.response as Record<string, unknown> | undefined;
  if (response && response.isThinking === true && typeof response.token === 'string') {
    return response.token;
  }

  if (result.isThinking === true && typeof result.token === 'string') {
    return result.token;
  }

  return null;
}

function assistantMessageFromModelResponse(value: unknown): string | null {
  const object = recordFrom(value);
  if (!object) {
    return null;
  }

  const message = object.message;
  if (typeof message !== 'string' || message.length === 0) {
    return null;
  }

  const sender = object.sender;
  if (typeof sender === 'string' && sender.toLowerCase() !== 'assistant') {
    return null;
  }

  return message;
}

function finalAssistantMessageFromGrokObject(value: unknown): string | null {
  const object = recordFrom(value);
  if (!object) {
    return null;
  }

  const direct = assistantMessageFromModelResponse(object.modelResponse);
  if (direct) {
    return direct;
  }

  const result = recordFrom(object.result);
  if (!result) {
    return null;
  }

  const resultMessage = assistantMessageFromModelResponse(result.modelResponse);
  if (resultMessage) {
    return resultMessage;
  }

  const response = recordFrom(result.response);
  return assistantMessageFromModelResponse(response?.modelResponse);
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(object: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function parsedJsonMetadataString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function metadataFromExplicitPaths(object: Record<string, unknown>): GrokResponseMetadata {
  const metadata: GrokResponseMetadata = {};

  // Handle /new format: {"result":{"response":{"conversationId":"...","responseId":"..."}}}
  const result = recordFrom(object.result);
  if (result) {
    const resultConversationId = stringField(result, CONVERSATION_ID_KEYS);
    if (resultConversationId) {
      metadata.conversationId = resultConversationId;
    }
    const resultResponseId = stringField(result, RESPONSE_ID_KEYS);
    if (resultResponseId) {
      metadata.responseId = resultResponseId;
    }

    const resultConversation = recordFrom(result.conversation);
    if (!metadata.conversationId && resultConversation) {
      const conversationId = stringField(resultConversation, CONVERSATION_ID_KEYS);
      if (conversationId) {
        metadata.conversationId = conversationId;
      }
    }

    const resultModelResponse = recordFrom(result.modelResponse);
    if (resultModelResponse) {
      const responseId = stringField(resultModelResponse, RESPONSE_ID_KEYS);
      if (responseId) {
        metadata.responseId = responseId;
      }
    }

    const response = recordFrom(result.response);
    if (response) {
      const responseConversationId = stringField(response, CONVERSATION_ID_KEYS);
      if (responseConversationId) {
        metadata.conversationId = responseConversationId;
      }
      const responseResponseId = stringField(response, RESPONSE_ID_KEYS);
      if (responseResponseId) {
        metadata.responseId = responseResponseId;
      }

      const conversation = recordFrom(response.conversation);
      if (!metadata.conversationId && conversation) {
        const conversationId = stringField(conversation, CONVERSATION_ID_KEYS);
        if (conversationId) {
          metadata.conversationId = conversationId;
        }
      }

      const modelResponse = recordFrom(response.modelResponse);
      if (modelResponse) {
        const responseId = stringField(modelResponse, RESPONSE_ID_KEYS);
        if (responseId) {
          metadata.responseId = responseId;
        }
      }
    }
  }

  // Handle direct metadata formats
  if (!metadata.conversationId) {
    const conversationId = stringField(object, CONVERSATION_ID_KEYS);
    if (conversationId) {
      metadata.conversationId = conversationId;
    }
  }
  const responseId = stringField(object, RESPONSE_ID_KEYS);
  if (responseId) {
    metadata.responseId = responseId;
  }

  return metadata;
}

function metadataFromFallbackValue(
  value: unknown,
  containerKey = '',
  seen: WeakSet<object> = new WeakSet(),
): GrokResponseMetadata {
  if (typeof value === 'string') {
    const parsed = parsedJsonMetadataString(value);
    return parsed === undefined ? {} : metadataFromFallbackValue(parsed, containerKey, seen);
  }

  if (!value || typeof value !== 'object') {
    return {};
  }

  if (seen.has(value)) {
    return {};
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const metadata: GrokResponseMetadata = {};
    for (const item of value) {
      const itemMetadata = metadataFromFallbackValue(item, containerKey, seen);
      if (!metadata.conversationId && itemMetadata.conversationId) {
        metadata.conversationId = itemMetadata.conversationId;
      }
      if (!metadata.responseId && itemMetadata.responseId) {
        metadata.responseId = itemMetadata.responseId;
      }
      if (metadata.conversationId && metadata.responseId) {
        break;
      }
    }
    return metadata;
  }

  const object = value as Record<string, unknown>;
  const normalizedContainerKey = containerKey.toLowerCase();
  const metadata: GrokResponseMetadata = {};

  const conversationId = stringField(object, CONVERSATION_ID_KEYS);
  if (conversationId) {
    metadata.conversationId = conversationId;
  } else if (normalizedContainerKey === 'conversation' && typeof object.id === 'string' && object.id.length > 0) {
    metadata.conversationId = object.id;
  }

  const responseId = stringField(object, RESPONSE_ID_KEYS);
  if (responseId) {
    metadata.responseId = responseId;
  } else if (
    (normalizedContainerKey === 'modelresponse' ||
      normalizedContainerKey === 'response' ||
      normalizedContainerKey === 'message') &&
    typeof object.id === 'string' &&
    object.id.length > 0
  ) {
    metadata.responseId = object.id;
  }

  for (const [key, child] of Object.entries(object)) {
    if (metadata.conversationId && metadata.responseId) {
      break;
    }

    const childMetadata = metadataFromFallbackValue(child, key, seen);
    if (!metadata.conversationId && childMetadata.conversationId) {
      metadata.conversationId = childMetadata.conversationId;
    }
    if (!metadata.responseId && childMetadata.responseId) {
      metadata.responseId = childMetadata.responseId;
    }
  }

  return metadata;
}

function metadataFromGrokObject(value: unknown): GrokResponseMetadata {
  const object = recordFrom(value);
  if (!object) {
    return {};
  }

  const explicit = metadataFromExplicitPaths(object);
  const fallback = metadataFromFallbackValue(object);
  const metadata: GrokResponseMetadata = {};

  const conversationId = explicit.conversationId ?? fallback.conversationId;
  if (conversationId) {
    metadata.conversationId = conversationId;
  }
  const responseId = explicit.responseId ?? fallback.responseId;
  if (responseId) {
    metadata.responseId = responseId;
  }

  return metadata;
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

function emitReasoningToken(job: BridgeJob, token: string): void {
  if (!token || job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
    return;
  }

  markTiming(job, 'firstParsedReasoningTokenAt');
  job.state = 'streaming';
  metrics.emittedReasoningTokens += 1;
  metrics.emittedReasoningBytes += Buffer.byteLength(token);
  job.events.emit('reasoning', token);
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

  let tokensEmitted = 0;
  for (const object of parsed.objects) {
    const metadata = metadataFromGrokObject(object);
    const metadataUpdate: GrokResponseMetadata = {};

    if (metadata.conversationId && job.conversationId !== metadata.conversationId) {
      job.conversationId = metadata.conversationId;
      metadataUpdate.conversationId = metadata.conversationId;
    }
    if (metadata.responseId && job.responseId !== metadata.responseId) {
      job.responseId = metadata.responseId;
      metadataUpdate.responseId = metadata.responseId;
    }
    if (Object.keys(metadataUpdate).length > 0) {
      job.events.emit('metadata', metadataUpdate);
    }

    const token = tokenFromGrokObject(object);
    if (token !== null) {
      emitToken(job, token);
      tokensEmitted++;
      continue;
    }

    const reasoningToken = reasoningTokenFromGrokObject(object);
    if (reasoningToken !== null) {
      emitReasoningToken(job, reasoningToken);
      tokensEmitted++;
      continue;
    }

    const finalMessage = finalAssistantMessageFromGrokObject(object);
    if (finalMessage !== null && job.text.length === 0) {
      emitToken(job, finalMessage);
      tokensEmitted++;
    }
  }

  if (DEBUG_PARSE && tokensEmitted === 0 && parsed.objects.length > 0) {
    console.log(
      `[proxy] ingestGrokChunk: ${parsed.objects.length} objects but no tokens extracted. First object:`,
      JSON.stringify(parsed.objects[0]).slice(0, 200),
    );
  }
}

function writeOpenAIStreamChunk(
  res: http.ServerResponse,
  job: BridgeJob,
  delta: Record<string, unknown>,
  finishReason: string | null,
): void {
  const choice = finishReason
    ? { delta: {}, index: 0, finish_reason: finishReason }
    : { delta, index: 0, finish_reason: null };

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
  res.socket?.setNoDelay(true);

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
    job.events.off('reasoning', onReasoning);
    job.events.off('done', onDone);
    job.events.off('error', onError);
    job.events.off('timing', onTiming);
    job.events.off('metadata', onMetadata);
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
    const firstSseChunk = job.timings.firstSseChunkAt === undefined;
    if (firstSseChunk) {
      job.timings.firstSseChunkAt = Date.now();
    }
    writeOpenAIStreamChunk(res, job, { content: token }, null);
    if (firstSseChunk) {
      job.events.emit('timing', timingSnapshot(job));
    }
  };

  const onReasoning = (token: string) => {
    const firstSseChunk = job.timings.firstSseChunkAt === undefined;
    if (firstSseChunk) {
      job.timings.firstSseChunkAt = Date.now();
    }
    writeOpenAIStreamChunk(res, job, { reasoning_content: token }, null);
    if (firstSseChunk) {
      job.events.emit('timing', timingSnapshot(job));
    }
  };

  const onMetadata = (metadata: GrokResponseMetadata) => {
    if (!ended && !res.destroyed) {
      res.write(`event: grok-response-metadata\ndata: ${JSON.stringify(metadata)}\n\n`);
    }
  };

  const onDone = () => {
    if ((job.conversationId || job.responseId) && !ended && !res.destroyed) {
      res.write(
        `event: grok-response-metadata\ndata: ${JSON.stringify({
          conversationId: job.conversationId,
          responseId: job.responseId,
        })}\n\n`,
      );
    }
    writeOpenAIStreamChunk(res, job, {}, 'stop');
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
  job.events.on('reasoning', onReasoning);
  job.events.once('done', onDone);
  job.events.once('error', onError);
  job.events.on('timing', onTiming);
  job.events.on('metadata', onMetadata);
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
  const bridge = bridgeStatus();

  if (!bridge.requestReady) {
    sendError(res, 503, bridgeNotReadyMessage(bridge));
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
  const normalized: WorkerHeartbeat = {
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
  lastHeartbeat = normalized;
  if (normalized.workerId) {
    workerHeartbeats.set(normalized.workerId, normalized);
  }

  dispatchQueuedJobs();

  sendJson(res, 200, {
    ok: true,
    bridge: bridgeStatus(),
    templateOverride,
    newTemplateOverride,
  });
}

async function handleBridgeTemplate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const template = await readJson<BridgeTemplate>(req);
  if (!isValidBridgeTemplate(template)) {
    sendError(res, 400, 'Expected valid bridge template with Grok response url, body, and parentResponseId');
    return;
  }

  const normalized = normalizeBridgeTemplate(template);
  if (conversationIdFromResponseUrl(normalized.url as string) === 'new') {
    newTemplateOverride = normalized;
  } else {
    templateOverride = normalized;
  }

  sendJson(res, 200, { ok: true });
}

async function handlePollJob(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const explicitFallback = url.searchParams.get('fallback') === '1';
  if (FAST_PATH_ENABLED && !explicitFallback) {
    sendError(res, 409, 'Polling job acquisition is fallback-only while Grok fast path is enabled');
    return;
  }
  if (!POLL_FALLBACK_ENABLED) {
    sendError(res, 403, 'Polling fallback is disabled by GROK_POLL_FALLBACK=0');
    return;
  }

  const workerId = url.searchParams.get('workerId') || '';
  if (!workerId) {
    sendError(res, 400, 'Expected workerId query parameter');
    return;
  }
  if (!isWorkerWarmReady(workerId)) {
    sendError(res, 409, pollWorkerNotReadyMessage(workerId));
    return;
  }

  const requestedTimeoutMs = Number(url.searchParams.get('timeoutMs') ?? LONG_POLL_MS);
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(0, Math.min(LONG_POLL_MS, requestedTimeoutMs))
    : LONG_POLL_MS;
  const job = await waitForJob(workerId, timeoutMs);
  if (!job) {
    res.writeHead(204);
    res.end();
    return;
  }

  markTiming(job, 'workerNotifiedAt');
  metrics.polledJobs += 1;

  sendJson(res, 200, jobPayload(job));
}

async function handleWorkerEvents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (!FAST_PATH_ENABLED) {
    sendError(res, 409, 'Grok fast path is disabled by GROK_FAST_PATH=0');
    return;
  }

  const workerId = url.searchParams.get('workerId') || '';
  if (!workerId) {
    sendError(res, 400, 'Expected workerId query parameter');
    return;
  }

  const existing = workerConnections.get(workerId);
  if (existing && !existing.res.destroyed && !existing.res.writableEnded) {
    existing.res.end();
    clearInterval(existing.keepalive);
  }

  res.socket?.setNoDelay(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const capabilities = (url.searchParams.get('capabilities') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const connection: WorkerConnection = {
    workerId,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    capabilities,
    res,
    keepalive: setInterval(() => {
      writeWorkerEvent(connection, 'heartbeat', { at: Date.now() });
    }, PUSH_KEEPALIVE_MS),
  };

  workerConnections.set(workerId, connection);
  metrics.pushConnections += 1;
  writeWorkerEvent(connection, 'ready', {
    workerId,
    fastPath: true,
    pollingFallbackEnabled: POLL_FALLBACK_ENABLED,
  });
  dispatchQueuedJobs();

  req.on('close', () => {
    if (workerConnections.get(workerId) === connection) {
      workerConnections.delete(workerId);
      metrics.pushDisconnects += 1;
    }
    clearInterval(connection.keepalive);
  });
}

async function handleJobAccept(req: http.IncomingMessage, res: http.ServerResponse, jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    sendError(res, 404, `Unknown bridge job ${jobId}`);
    return;
  }

  const body = await readJson<{ workerId?: unknown; timings?: unknown }>(req);
  const timings = normalizeTimingMap(body.timings);
  if (timings.workerAcceptedAt === undefined && job.timings.workerAcceptedAt === undefined) {
    timings.workerAcceptedAt = Date.now();
  }
  if (typeof body.workerId === 'string' && body.workerId) {
    job.workerId = body.workerId;
  }

  markTimings(job, timings);
  metrics.acceptedJobs += 1;
  sendJson(res, 200, { ok: true, timing: timingSnapshot(job) });
}

async function handlePrewarm(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  metrics.prewarmRequests += 1;
  const sent = broadcastWorkerEvent('prewarm', { requestedAt: Date.now() });
  sendJson(res, sent > 0 ? 202 : 503, {
    ok: sent > 0,
    sent,
    bridge: bridgeStatus(),
  });
}

async function handleNativeProbe(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  metrics.nativeProbeRequests += 1;
  const body = await readJson<{ prompt?: unknown }>(req);
  const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : 'Say one word.';
  const sent = broadcastReadyWorkerEvent('native-probe', { requestedAt: Date.now(), prompt });
  sendJson(res, sent > 0 ? 202 : 503, {
    ok: sent > 0,
    sent,
    bridge: bridgeStatus(),
  });
}

async function handleNativeTiming(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<NativeTimingBody>(req);
  const timings = normalizeLooseTimings(body.timings);
  const sample = {
    observedAt: Date.now(),
    workerId: typeof body.workerId === 'string' && body.workerId ? body.workerId : null,
    url: typeof body.url === 'string' ? body.url : null,
    status: typeof body.status === 'number' && Number.isFinite(body.status) ? body.status : null,
    error: typeof body.error === 'string' ? body.error.slice(0, 500) : null,
    timings,
  };

  nativeTimings.push(sample);
  if (nativeTimings.length > MAX_NATIVE_TIMINGS) {
    nativeTimings.splice(0, nativeTimings.length - MAX_NATIVE_TIMINGS);
  }
  metrics.nativeTimingSamples += 1;

  sendJson(res, 200, { ok: true, sample });
}

function nativeTimingsPayload() {
  const samples = nativeTimings.map((sample) => {
    const startedAt = sample.timings.nativeFetchStartedAt;
    const firstVisibleAt =
      sample.timings.nativeFirstParsedOutputTokenAt ??
      sample.timings.nativeFirstParsedVisibleTokenAt ??
      sample.timings.nativeFirstRawChunkAt;
    const doneAt = sample.timings.nativeDoneAt;
    return {
      ...sample,
      nativeTtftMs:
        typeof startedAt === 'number' && typeof firstVisibleAt === 'number' ? firstVisibleAt - startedAt : null,
      nativeTotalMs: typeof startedAt === 'number' && typeof doneAt === 'number' ? doneAt - startedAt : null,
    };
  });
  const ttfts = samples
    .map((sample) => sample.nativeTtftMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right);

  return {
    count: samples.length,
    summary: {
      p50: percentile(ttfts, 0.5),
      p95: percentile(ttfts, 0.95),
      p99: percentile(ttfts, 0.99),
      min: ttfts.length > 0 ? ttfts[0] : null,
      max: ttfts.length > 0 ? ttfts[ttfts.length - 1] : null,
    },
    samples,
  };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index] ?? null;
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

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

  if (req.method === 'GET' && path === '/bridge/native-timings') {
    sendJson(res, 200, nativeTimingsPayload());
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

  if (req.method === 'GET' && path === '/bridge/events') {
    await handleWorkerEvents(req, res, url);
    return;
  }

  if (req.method === 'POST' && path === '/bridge/prewarm') {
    await handlePrewarm(req, res);
    return;
  }

  if (req.method === 'POST' && path === '/bridge/native-probe') {
    await handleNativeProbe(req, res);
    return;
  }

  if (req.method === 'POST' && path === '/bridge/native-timing') {
    await handleNativeTiming(req, res);
    return;
  }

  if (req.method === 'GET' && path === '/bridge/jobs') {
    await handlePollJob(req, res, url);
    return;
  }

  const acceptMatch = path.match(/^\/bridge\/jobs\/([^/]+)\/accept$/);
  if (req.method === 'POST' && acceptMatch?.[1]) {
    await handleJobAccept(req, res, acceptMatch[1]);
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

export function createProxyServer(): http.Server {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        sendError(res, 500, message);
        return;
      }
      res.end();
    });
  });
}

if (require.main === module) {
  const server = createProxyServer();

  server.listen(PORT, HOST, () => {
    console.log(`Grok OpenAI-compatible proxy listening on http://${HOST}:${PORT}`);
    console.log('Bridge mode: waiting for Chrome extension heartbeat on /bridge/heartbeat');
  });

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}
