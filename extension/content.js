(() => {
const CONTENT_SCRIPT_VERSION = 'm4-content-v4';
const CONTENT_SCRIPT_VERSION_KEY = '__opencodeGrokAuthContentVersion';

if (globalThis[CONTENT_SCRIPT_VERSION_KEY] === CONTENT_SCRIPT_VERSION) {
  return;
}
globalThis[CONTENT_SCRIPT_VERSION_KEY] = CONTENT_SCRIPT_VERSION;

const PAGE_SOURCE = 'opencode-grok-auth-page';
const EXTENSION_SOURCE = 'opencode-grok-auth-extension';
const jobPorts = new Map();

const pageBridgeReady = injectPageBridge();

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== PAGE_SOURCE) {
    return;
  }

  const data = event.data;

  if (data.type === 'GROK_REQUEST_OBSERVED') {
    safeSendMessage({ type: 'grok-request-observed', detail: data.detail });
    return;
  }

  if (data.type === 'GROK_NATIVE_TIMING') {
    safeSendMessage({ type: 'grok-native-timing', detail: data.detail });
    return;
  }

  if (data.type === 'GROK_JOB_CHUNK') {
    sendJobPortMessage(data.jobId, {
      type: 'grok-job-chunk',
      jobId: data.jobId,
      chunk: data.chunk,
      timings: data.timings,
    });
    return;
  }

  if (data.type === 'GROK_JOB_TIMING') {
    sendJobPortMessage(data.jobId, {
      type: 'grok-job-timing',
      jobId: data.jobId,
      timings: data.timings,
    });
    return;
  }

  if (data.type === 'GROK_JOB_COMPLETE') {
    sendJobPortMessage(data.jobId, { type: 'grok-job-complete', jobId: data.jobId });
    jobPorts.delete(data.jobId);
    return;
  }

  if (data.type === 'GROK_JOB_ERROR') {
    sendJobPortMessage(data.jobId, { type: 'grok-job-error', jobId: data.jobId, error: data.error });
    jobPorts.delete(data.jobId);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name || !port.name.startsWith('grok-job:')) {
    return;
  }

  const jobId = port.name.slice('grok-job:'.length);
  if (!jobId) {
    port.disconnect();
    return;
  }

  jobPorts.set(jobId, port);
  port.onDisconnect.addListener(() => {
    if (jobPorts.get(jobId) === port) {
      jobPorts.delete(jobId);
    }
  });

  port.onMessage.addListener((message) => {
    if (!message || message.type !== 'run-grok-job') {
      return;
    }
    runGrokJobFromPort(port, message.job, message.requestTemplate);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'ping-content-script') {
    sendResponse({ ok: true, contentScriptVersion: CONTENT_SCRIPT_VERSION });
    return false;
  }

  if (message && message.type === 'run-native-timing-probe') {
    const runId = randomId();
    postPageMessageWhenReady({
        source: EXTENSION_SOURCE,
        type: 'RUN_NATIVE_TIMING_PROBE',
        runId,
        prompt: message.prompt,
        requestTemplate: message.requestTemplate,
    });
    sendResponse({ ok: true, runId });
    return false;
  }

  if (!message || message.type !== 'run-grok-job') {
    return false;
  }

  // Compatibility fallback for older background workers. M4 fast path uses chrome.runtime.Port.
  const runId = randomId();
  const acceptedAt = Date.now();
  postPageMessageWhenReady({
      source: EXTENSION_SOURCE,
      type: 'RUN_GROK_JOB_V2',
      runId,
      job: message.job,
      requestTemplate: message.requestTemplate,
  });

  sendResponse({ ok: true, runId, timings: { contentScriptAcceptedAt: acceptedAt } });
  return false;
});

function runGrokJobFromPort(port, job, requestTemplate) {
  const runId = randomId();
  const acceptedAt = Date.now();
  const jobId = job && typeof job.id === 'string' ? job.id : '';

  if (jobId) {
    jobPorts.set(jobId, port);
  }

  postPageMessageWhenReady({
      source: EXTENSION_SOURCE,
      type: 'RUN_GROK_JOB_V2',
      runId,
      job,
      requestTemplate,
  });

  try {
    port.postMessage({
      type: 'grok-job-accepted',
      jobId,
      runId,
      timings: { contentScriptAcceptedAt: acceptedAt },
    });
  } catch {
  }
}

function injectPageBridge() {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.async = false;
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = () => {
      script.remove();
      resolve();
    };
    (document.documentElement || document.head).appendChild(script);
  });
}

function postPageMessageWhenReady(message) {
  pageBridgeReady
    .then(() => {
      window.postMessage(message, location.origin);
    })
    .catch(() => {
      window.postMessage(message, location.origin);
    });
}

function safeSendMessage(message) {
  try {
    chrome.runtime.sendMessage(message);
  } catch {
    // Extension context can disappear during reloads.
  }
}

function sendJobPortMessage(jobId, message) {
  const port = typeof jobId === 'string' ? jobPorts.get(jobId) : null;
  if (port) {
    try {
      port.postMessage(message);
      return;
    } catch {
      jobPorts.delete(jobId);
    }
  }

  // Fallback for stale extension contexts that have not upgraded to the Port data plane.
  safeSendMessage(message);
}

function randomId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
})();
