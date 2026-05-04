const BRIDGE_ORIGIN = 'http://127.0.0.1:11434';
const WORKER_ID = getWorkerId();
const BACKGROUND_CODE_VERSION = 'chat-session-routing-v1';
const POLL_BACKOFF_MS = 1000;
const JOB_RUN_TIMEOUT_MS = 180000;

let lastObservedRequest = null;
let lastObservedNewRequest = null;
let lastTemplateInstallSource = '';
let lastTemplateInstallError = '';
let polling = false;
const activeJobs = new Map();
const jobPostChains = new Map();

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
  startPolling();
});

chrome.runtime.onStartup.addListener(() => {
  startPolling();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (message.type === 'grok-request-observed') {
    rememberObservedRequest(message.detail);
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

startPolling();

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

async function findGrokTab() {
  const tabs = await queryTabs({ url: 'https://grok.com/*' });
  if (tabs.length === 0) {
    return null;
  }

  return tabs.find((tab) => tab.active) || tabs[0];
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
  }
}

async function pollJob() {
  const response = await bridgeFetch(`/bridge/jobs?workerId=${encodeURIComponent(WORKER_ID)}`);
  if (response.status === 204) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Bridge job poll failed: ${response.status}`);
  }
  return response.json();
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

async function runJobInGrokTab(job) {
  console.log('[bridge] runJobInGrokTab', { jobId: job.id, model: job.model });

  const isNew = job.model === 'grok-latest-new';
  const fallbackTemplate = isNew
    ? lastObservedNewRequest
    : job.conversationId
      ? lastObservedRequest || lastObservedNewRequest
      : lastObservedRequest;
  const requestTemplate = isValidObservedRequest(job.requestTemplate) ? job.requestTemplate : fallbackTemplate;

  console.log('[bridge] template', { isNew, templateUrl: requestTemplate?.url });

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

  try {
    await ensureContentScript(tab.id);
  } catch (error) {
    await postJobComplete(job.id, false, `Could not attach Grok content bridge: ${errorMessage(error)}`);
    return;
  }

  const completion = waitForActiveJob(job.id);

  try {
    const response = await sendTabMessage(tab.id, {
      type: 'run-grok-job',
      job,
      requestTemplate,
    });

    if (!response || response.ok !== true) {
      throw new Error('Grok content script did not accept the bridge job.');
    }
    void postJobTiming(job.id, response.timings);
  } catch (error) {
    finishActiveJob(job.id);
    await postJobComplete(job.id, false, errorMessage(error));
    return;
  }

  await completion;
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
    if (response && response.ok === true) {
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

  const response = await sendTabMessage(tabId, { type: 'ping-content-script' });
  if (!response || response.ok !== true) {
    throw new Error('content script injection did not respond.');
  }
}

function finishActiveJob(jobId) {
  const finish = activeJobs.get(jobId);
  if (!finish) {
    return;
  }
  activeJobs.delete(jobId);
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

async function startPolling() {
  if (polling) {
    return;
  }

  polling = true;

  while (true) {
    try {
      await postHeartbeat();
      const job = await pollJob();
      if (job) {
        await runJobInGrokTab(job);
      }
    } catch {
      await sleep(POLL_BACKOFF_MS);
    }
  }
}
