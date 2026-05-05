const BRIDGE_ORIGIN = 'http://127.0.0.1:11434';
const WORKER_ID = getWorkerId();
const BACKGROUND_CODE_VERSION = 'm4-push-port-v8';
const POLL_BACKOFF_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 5000;
const JOB_RUN_TIMEOUT_MS = 180000;
const PUSH_RETRY_MS = 1000;
const PUSH_RETRY_WINDOW_MS = 5000;
const FAST_PATH_DISABLED_STORAGE_KEY = 'opencodeGrokAuthDisableFastPath';
const NATIVE_TIMING_QUEUE_STORAGE_KEY = 'opencodeGrokAuthPendingNativeTimings';
const MAX_NATIVE_TIMING_QUEUE = 20;
const REQUIRED_CONTENT_SCRIPT_VERSION = 'm4-content-v4';

let lastObservedRequest = null;
let lastObservedNewRequest = null;
let lastTemplateInstallSource = '';
let lastTemplateInstallError = '';
let bridgeStarted = false;
const activeJobs = new Map();
const jobPostChains = new Map();
const activeJobPorts = new Map();
let nativeTimingFlushActive = false;

chrome.storage.local.get(['lastObservedRequest', 'lastObservedNewRequest'], (result) => {
  if (isValidObservedRequest(result.lastObservedRequest)) {
    installObservedRequest(result.lastObservedRequest, 'storage');
  } else if (result.lastObservedRequest) {
    lastTemplateInstallError = observedRequestInvalidReason(result.lastObservedRequest);
    chrome.storage.local.remove('lastObservedRequest');
  }
  if (isValidObservedRequest(result.lastObservedNewRequest)) {
    installObservedRequest(result.lastObservedNewRequest, 'storage');
  } else if (result.lastObservedNewRequest) {
    chrome.storage.local.remove('lastObservedNewRequest');
  }
});

chrome.runtime.onInstalled.addListener(() => {
  startBridge();
});

chrome.runtime.onStartup.addListener(() => {
  startBridge();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (message.type === 'grok-request-observed') {
    rememberObservedRequest(message.detail);
    return false;
  }

  if (message.type === 'grok-native-timing') {
    void postNativeTiming(message.detail);
    return false;
  }

  if (message.type === 'grok-job-chunk') {
    if (activeJobs.has(message.jobId)) {
      void enqueueJobPost(message.jobId, async () => {
        try {
          await postJobChunk(message.jobId, message.chunk, message.timings);
        } catch (error) {
          await postJobComplete(message.jobId, false, errorMessage(error));
          finishActiveJob(message.jobId);
        }
      });
    }
    return false;
  }

  if (message.type === 'grok-job-complete') {
    if (activeJobs.has(message.jobId)) {
      void enqueueJobPost(message.jobId, async () => {
        await postJobComplete(message.jobId, true);
        finishActiveJob(message.jobId);
      });
    }
    return false;
  }

  if (message.type === 'grok-job-error') {
    if (activeJobs.has(message.jobId)) {
      void enqueueJobPost(message.jobId, async () => {
        await postJobComplete(message.jobId, false, message.error);
        finishActiveJob(message.jobId);
      });
    }
    return false;
  }

  if (message.type === 'grok-job-timing') {
    if (activeJobs.has(message.jobId)) {
      void postJobTiming(message.jobId, message.timings);
    }
    return false;
  }

  return false;
});

startBridge();

function getWorkerId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `worker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryTabs(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => resolve(tabs || []));
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function updateTab(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

function createTab(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

async function findGrokTab() {
  const tabs = await queryTabs({});
  const grokTabs = tabs.filter((tab) => {
    return typeof tab.url === 'string' && (tab.url === 'https://grok.com' || tab.url.startsWith('https://grok.com/'));
  });
  if (grokTabs.length === 0) {
    return null;
  }

  return grokTabs.find((tab) => tab.active) || grokTabs[0];
}

async function prewarmGrokTab() {
  let tab = await findGrokTab();
  let created = false;
  if (!tab || typeof tab.id !== 'number') {
    tab = await createTab({ url: 'https://grok.com/', active: true });
    created = true;
  } else {
    await updateTab(tab.id, { active: true });
  }

  if (tab && typeof tab.id === 'number') {
    await waitForTabUrl(tab.id, 'https://grok.com/');
    await ensureContentScript(tab.id).catch(() => {});
  }

  await postHeartbeat().catch(() => {});
}

async function runNativeTimingProbe(payload) {
  const requestTemplate = lastObservedNewRequest || lastObservedRequest;
  if (!requestTemplate) {
    return;
  }

  let tab = await findGrokTab();
  let created = false;
  if (!tab || typeof tab.id !== 'number') {
    tab = await createTab({ url: 'https://grok.com/', active: true });
    created = true;
  } else {
    await updateTab(tab.id, { active: true });
  }

  if (!tab || typeof tab.id !== 'number') {
    return;
  }

  if (created) {
    await waitForTabUrl(tab.id, 'https://grok.com/');
  }
  await ensureContentScript(tab.id);
  await sendTabMessage(tab.id, {
    type: 'run-native-timing-probe',
    prompt: typeof payload?.prompt === 'string' && payload.prompt.trim() ? payload.prompt.trim() : 'Say one word.',
    requestTemplate,
  });
}

function rememberObservedRequest(detail) {
  if (!detail || typeof detail.url !== 'string' || !detail.body || typeof detail.body !== 'object') {
    return;
  }

  const observedRequest = {
    url: detail.url,
    body: sanitizeObservedBody(detail.body),
    headers: sanitizeObservedHeaders(detail.headers),
    referer: typeof detail.referer === 'string' ? detail.referer : '',
    observedAt: Date.now(),
  };

  if (!isValidObservedRequest(observedRequest)) {
    lastTemplateInstallError = observedRequestInvalidReason(observedRequest);
    return;
  }

  installObservedRequest(observedRequest, 'capture');
}

function installObservedRequest(observedRequest, source = 'unknown') {
  if (conversationIdFromResponseUrl(observedRequest.url) === 'new') {
    lastObservedNewRequest = observedRequest;
    chrome.storage.local.set({ lastObservedNewRequest });
  } else {
    lastObservedRequest = observedRequest;
    chrome.storage.local.set({ lastObservedRequest });
  }
  lastTemplateInstallSource = source;
  lastTemplateInstallError = '';
}

function isValidObservedRequest(request) {
  return observedRequestInvalidReason(request) === '';
}

function observedRequestInvalidReason(request) {
  if (!request || typeof request.url !== 'string' || !request.body || typeof request.body !== 'object') {
    return 'missing url/body';
  }

  const urlConversationId = conversationIdFromResponseUrl(request.url);
  if (!urlConversationId) {
    return 'url is not a Grok response endpoint';
  }

  if (urlConversationId !== 'new') {
    const parentResponseId = request.body.parentResponseId;
    if (typeof parentResponseId !== 'string' || parentResponseId.length === 0) {
      return 'missing parentResponseId';
    }
  }

  if (request.body.disableMemory === true) {
    return 'captured template has disableMemory=true';
  }

  if (request.body.forceConcise === true) {
    return 'captured template has forceConcise=true';
  }

  return '';
}

function conversationIdFromResponseUrl(value) {
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

function sanitizeObservedBody(body) {
  const copy = clonePlainObject(body);
  copy.message = '';

  if (Array.isArray(copy.fileAttachments)) {
    copy.fileAttachments = [];
  }

  if (Array.isArray(copy.imageAttachments)) {
    copy.imageAttachments = [];
  }

  return copy;
}

function sanitizeObservedHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  const copy = {};
  const blocked = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie']);

  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (blocked.has(normalized)) {
      continue;
    }
    if (typeof value === 'string') {
      copy[normalized] = value;
    }
  }

  return copy;
}

function clonePlainObject(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

async function bridgeFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Grok-Bridge-Id': WORKER_ID,
    ...(options.headers || {}),
  };

  return fetch(`${BRIDGE_ORIGIN}${path}`, {
    ...options,
    headers,
  });
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

async function postHeartbeat() {
  const tab = await findGrokTab();
  const response = await bridgeFetch('/bridge/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      workerId: WORKER_ID,
      activeGrokTab: Boolean(tab),
      hasRequestTemplate: Boolean(lastObservedRequest || lastObservedNewRequest),
      url: lastObservedRequest
        ? lastObservedRequest.referer || lastObservedRequest.url
        : lastObservedNewRequest
          ? lastObservedNewRequest.referer || lastObservedNewRequest.url
          : '',
      manifestVersion: chrome.runtime.getManifest().version,
      backgroundCodeVersion: BACKGROUND_CODE_VERSION,
      templateInstallSource: lastTemplateInstallSource,
      templateInstallError: lastTemplateInstallError,
    }),
  });

  if (response.ok) {
    const body = await response.json().catch(() => null);
    if (body && body.templateOverride) {
      if (isValidObservedRequest(body.templateOverride)) {
        installObservedRequest(body.templateOverride, 'proxy-template-override');
      } else {
        lastTemplateInstallError = observedRequestInvalidReason(body.templateOverride);
      }
    }
    if (body && body.newTemplateOverride) {
      if (isValidObservedRequest(body.newTemplateOverride)) {
        installObservedRequest(body.newTemplateOverride, 'proxy-new-template-override');
      }
    }
    void flushNativeTimingQueue();
  }
}

async function pollJob(fallback = false, timeoutMs = '') {
  const fallbackParam = fallback ? '&fallback=1' : '';
  const timeoutParam = typeof timeoutMs === 'number' ? `&timeoutMs=${encodeURIComponent(String(timeoutMs))}` : '';
  const response = await bridgeFetch(`/bridge/jobs?workerId=${encodeURIComponent(WORKER_ID)}${fallbackParam}${timeoutParam}`);
  if (response.status === 204) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Bridge job poll failed: ${response.status}`);
  }
  return response.json();
}

async function postJobAccept(jobId, timings) {
  if (typeof jobId !== 'string') {
    return;
  }

  await bridgeFetch(`/bridge/jobs/${encodeURIComponent(jobId)}/accept`, {
    method: 'POST',
    body: JSON.stringify({
      workerId: WORKER_ID,
      timings: sanitizeTimings(timings),
    }),
  }).catch(() => {});
}

async function postJobChunk(jobId, chunk, timings) {
  if (typeof jobId !== 'string' || typeof chunk !== 'string') {
    return;
  }

  const response = await bridgeFetch(`/bridge/jobs/${encodeURIComponent(jobId)}/chunks`, {
    method: 'POST',
    body: JSON.stringify({ chunk, timings: sanitizeTimings(timings) }),
  });

  if (!response.ok) {
    throw new Error(`Bridge chunk post failed: ${response.status}`);
  }
}

async function postJobTiming(jobId, timings) {
  if (typeof jobId !== 'string') {
    return;
  }

  const cleanTimings = sanitizeTimings(timings);
  if (Object.keys(cleanTimings).length === 0) {
    return;
  }

  await bridgeFetch(`/bridge/jobs/${encodeURIComponent(jobId)}/timing`, {
    method: 'POST',
    body: JSON.stringify({ timings: cleanTimings }),
  }).catch(() => {});
}

async function postJobComplete(jobId, ok, error) {
  if (typeof jobId !== 'string') {
    return;
  }

  await bridgeFetch(`/bridge/jobs/${encodeURIComponent(jobId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({ ok, error: typeof error === 'string' ? error : undefined }),
  }).catch(() => {});
}

async function postNativeTiming(detail) {
  if (!detail || typeof detail !== 'object') {
    return;
  }

  const payload = nativeTimingPayload(detail);
  try {
    await postNativeTimingPayload(payload);
  } catch {
    await queueNativeTiming(payload);
  }
}

function nativeTimingPayload(detail) {
  return {
    workerId: WORKER_ID,
    url: typeof detail.url === 'string' ? detail.url : '',
    status: typeof detail.status === 'number' ? detail.status : null,
    timings: sanitizeTimings(detail.timings),
    error: typeof detail.error === 'string' ? detail.error : undefined,
    queuedAt: Date.now(),
  };
}

async function postNativeTimingPayload(payload) {
  const response = await bridgeFetch('/bridge/native-timing', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Bridge native timing post failed: ${response.status}`);
  }
}

async function queueNativeTiming(payload) {
  const result = await storageGet([NATIVE_TIMING_QUEUE_STORAGE_KEY]);
  const existing = Array.isArray(result[NATIVE_TIMING_QUEUE_STORAGE_KEY])
    ? result[NATIVE_TIMING_QUEUE_STORAGE_KEY]
    : [];
  const queue = [...existing, payload].slice(-MAX_NATIVE_TIMING_QUEUE);
  await storageSet({ [NATIVE_TIMING_QUEUE_STORAGE_KEY]: queue });
}

async function flushNativeTimingQueue() {
  if (nativeTimingFlushActive) {
    return;
  }

  nativeTimingFlushActive = true;
  try {
    const result = await storageGet([NATIVE_TIMING_QUEUE_STORAGE_KEY]);
    const queue = Array.isArray(result[NATIVE_TIMING_QUEUE_STORAGE_KEY])
      ? result[NATIVE_TIMING_QUEUE_STORAGE_KEY]
      : [];
    if (queue.length === 0) {
      return;
    }

    const remaining = [];
    for (let index = 0; index < queue.length; index += 1) {
      const payload = queue[index];
      try {
        await postNativeTimingPayload(payload);
      } catch {
        remaining.push(...queue.slice(index));
        break;
      }
    }
    await storageSet({ [NATIVE_TIMING_QUEUE_STORAGE_KEY]: remaining });
  } finally {
    nativeTimingFlushActive = false;
  }
}

async function runJobInGrokTab(job) {
  const isNew = job.model === 'grok-latest-new';
  const fallbackTemplate = isNew
    ? lastObservedNewRequest
    : job.conversationId
      ? lastObservedRequest || lastObservedNewRequest
      : lastObservedNewRequest || lastObservedRequest;
  const requestTemplate = isValidObservedRequest(job.requestTemplate) ? job.requestTemplate : fallbackTemplate;

  if (!requestTemplate) {
    await postJobComplete(
      job.id,
      false,
      isNew ? 'No new conversation template captured. Send a first message in a new Grok tab.' : 'No Grok request template captured. Open grok.com and send one normal message before using OpenCode.',
    );
    return;
  }

  const tab = await findGrokTab();
  if (!tab || typeof tab.id !== 'number') {
    await postJobComplete(job.id, false, 'No active grok.com tab is available for the browser bridge.');
    return;
  }

  if (job.conversationId) {
    await focusContinuationTab(tab.id, job.conversationId);
  }

  try {
    await ensureContentScript(tab.id);
  } catch (error) {
    await postJobComplete(job.id, false, `Could not attach Grok content bridge: ${errorMessage(error)}`);
    return;
  }

  const completion = waitForActiveJob(job.id);

  try {
    const port = connectJobPort(tab.id, job.id);
    activeJobPorts.set(job.id, port);
    attachJobPort(job.id, port);
    port.postMessage({
      type: 'run-grok-job',
      job,
      requestTemplate,
    });
  } catch (error) {
    finishActiveJob(job.id);
    await postJobComplete(job.id, false, errorMessage(error));
    return;
  }

  await completion;
}

async function focusContinuationTab(tabId, conversationId) {
  const targetUrl = `https://grok.com/c/${encodeURIComponent(conversationId)}`;
  const loaded = waitForTabUrl(tabId, targetUrl);
  await updateTab(tabId, { active: true, url: targetUrl });
  await loaded;
}

function waitForTabUrl(tabId, targetUrl) {
  return new Promise((resolve) => {
    const timeout = setTimeout(done, 10000);

    function done() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) {
        return;
      }
      if (tab.url && tab.url.startsWith(targetUrl) && changeInfo.status === 'complete') {
        done();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function waitForActiveJob(jobId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      void postJobComplete(jobId, false, `Timed out waiting for Grok page job after ${JOB_RUN_TIMEOUT_MS} ms`);
      finishActiveJob(jobId);
    }, JOB_RUN_TIMEOUT_MS);

    activeJobs.set(jobId, () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    const response = await sendTabMessage(tabId, { type: 'ping-content-script' });
    if (response && response.ok === true && response.contentScriptVersion === REQUIRED_CONTENT_SCRIPT_VERSION) {
      return;
    }
  } catch {
    // Fall through and inject below.
  }

  if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
    throw new Error('chrome.scripting permission is unavailable.');
  }

  await new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });

  // Successful injection is enough here. Existing stale content listeners may also
  // respond to pings, so a second ping can race with the fresh listener.
}

function connectJobPort(tabId, jobId) {
  if (!chrome.tabs || typeof chrome.tabs.connect !== 'function') {
    throw new Error('chrome.tabs.connect is unavailable.');
  }
  return chrome.tabs.connect(tabId, { name: `grok-job:${jobId}` });
}

function attachJobPort(jobId, port) {
  port.onMessage.addListener((message) => {
    void handleJobPortMessage(jobId, message);
  });

  port.onDisconnect.addListener(() => {
    activeJobPorts.delete(jobId);
    if (activeJobs.has(jobId)) {
      void postJobComplete(jobId, false, 'Grok content Port disconnected before completion.');
      finishActiveJob(jobId);
    }
  });
}

async function handleJobPortMessage(jobId, message) {
  if (!message || typeof message !== 'object' || !activeJobs.has(jobId)) {
    return;
  }

  if (message.type === 'grok-job-accepted') {
    await postJobTiming(jobId, message.timings);
    return;
  }

  if (message.type === 'grok-job-chunk') {
    await enqueueJobPost(jobId, async () => {
      try {
        await postJobChunk(jobId, message.chunk, message.timings);
      } catch (error) {
        await postJobComplete(jobId, false, errorMessage(error));
        finishActiveJob(jobId);
      }
    });
    return;
  }

  if (message.type === 'grok-job-complete') {
    await enqueueJobPost(jobId, async () => {
      await postJobComplete(jobId, true);
      finishActiveJob(jobId);
    });
    return;
  }

  if (message.type === 'grok-job-error') {
    await enqueueJobPost(jobId, async () => {
      await postJobComplete(jobId, false, message.error);
      finishActiveJob(jobId);
    });
    return;
  }

  if (message.type === 'grok-job-timing') {
    await postJobTiming(jobId, message.timings);
  }
}

function finishActiveJob(jobId) {
  const finish = activeJobs.get(jobId);
  if (!finish) {
    return;
  }
  activeJobs.delete(jobId);
  const port = activeJobPorts.get(jobId);
  if (port) {
    activeJobPorts.delete(jobId);
    try {
      port.disconnect();
    } catch {
    }
  }
  jobPostChains.delete(jobId);
  finish();
}

function enqueueJobPost(jobId, task) {
  const previous = jobPostChains.get(jobId) || Promise.resolve();
  const next = previous.then(task, task);
  jobPostChains.set(
    jobId,
    next.catch(() => {
      // Error propagation is handled inside the queued task.
    }),
  );
  return next;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeTimings(timings) {
  if (!timings || typeof timings !== 'object') {
    return {};
  }

  const clean = {};
  for (const [name, at] of Object.entries(timings)) {
    if (typeof at === 'number' && Number.isFinite(at)) {
      clean[name] = at;
    }
  }
  return clean;
}

async function startBridge() {
  if (bridgeStarted) {
    return;
  }

  bridgeStarted = true;
  void heartbeatLoop();
  void controlLoop();
}

async function heartbeatLoop() {
  while (true) {
    try {
      await postHeartbeat();
      await sleep(HEARTBEAT_INTERVAL_MS);
    } catch {
      await sleep(POLL_BACKOFF_MS);
    }
  }
}

async function controlLoop() {
  while (true) {
    if (!(await isFastPathLocallyDisabled())) {
      try {
        await runPushSession();
        continue;
      } catch {
        await sleep(PUSH_RETRY_MS);
      }
    }

    await runFallbackPollingWindow();
  }
}

async function runPushSession() {
  const response = await bridgeFetch(
    `/bridge/events?workerId=${encodeURIComponent(WORKER_ID)}&capabilities=push,port-v1`,
    {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    },
  );

  if (!response.ok || !response.body) {
    throw new Error(`Bridge push channel failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const read = await reader.read();
    if (read.done) {
      break;
    }

    buffer += decoder.decode(read.value, { stream: true });
    buffer = processControlBuffer(buffer, false);
  }

  buffer += decoder.decode();
  processControlBuffer(buffer, true);
}

async function runFallbackPollingWindow() {
  const startedAt = Date.now();

  while ((await isFastPathLocallyDisabled()) || Date.now() - startedAt < PUSH_RETRY_WINDOW_MS) {
    try {
      const job = await pollJob(true, 1000);
      if (job) {
        void postJobAccept(job.id, { workerAcceptedAt: Date.now() });
        await runJobInGrokTab(job);
      }
    } catch {
      await sleep(POLL_BACKOFF_MS);
    }
  }
}

function processControlBuffer(buffer, flush) {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = flush ? '' : parts.pop() || '';

  for (const part of parts) {
    void handleControlFrame(part);
  }

  if (flush && parts.length === 0 && buffer.trim()) {
    void handleControlFrame(buffer);
  }

  return remainder;
}

async function handleControlFrame(frame) {
  const lines = frame.split('\n').map((line) => line.replace(/\r$/, ''));
  let eventName = 'message';
  const dataLines = [];

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

  let payload = null;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }

  if (eventName === 'job') {
    void postJobAccept(payload.id, { workerAcceptedAt: Date.now() });
    await runJobInGrokTab(payload);
    return;
  }

  if (eventName === 'prewarm') {
    await prewarmGrokTab();
    return;
  }

  if (eventName === 'native-probe') {
    await runNativeTimingProbe(payload);
  }
}

function isFastPathLocallyDisabled() {
  return new Promise((resolve) => {
    chrome.storage.local.get([FAST_PATH_DISABLED_STORAGE_KEY], (result) => {
      resolve(result && result[FAST_PATH_DISABLED_STORAGE_KEY] === true);
    });
  });
}
