const PAGE_SOURCE = 'opencode-grok-auth-page';
const EXTENSION_SOURCE = 'opencode-grok-auth-extension';

injectPageBridge();

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== PAGE_SOURCE) {
    return;
  }

  const data = event.data;

  if (data.type === 'GROK_REQUEST_OBSERVED') {
    safeSendMessage({ type: 'grok-request-observed', detail: data.detail });
    return;
  }

  if (data.type === 'GROK_JOB_CHUNK') {
    safeSendMessage({ type: 'grok-job-chunk', jobId: data.jobId, chunk: data.chunk, timings: data.timings });
    return;
  }

  if (data.type === 'GROK_JOB_TIMING') {
    safeSendMessage({ type: 'grok-job-timing', jobId: data.jobId, timings: data.timings });
    return;
  }

  if (data.type === 'GROK_JOB_COMPLETE') {
    safeSendMessage({ type: 'grok-job-complete', jobId: data.jobId });
    return;
  }

  if (data.type === 'GROK_JOB_ERROR') {
    safeSendMessage({ type: 'grok-job-error', jobId: data.jobId, error: data.error });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'ping-content-script') {
    sendResponse({ ok: true });
    return false;
  }

  if (!message || message.type !== 'run-grok-job') {
    return false;
  }

  const runId = randomId();
  const acceptedAt = Date.now();
  window.postMessage(
    {
      source: EXTENSION_SOURCE,
      type: 'RUN_GROK_JOB_V2',
      runId,
      job: message.job,
      requestTemplate: message.requestTemplate,
    },
    location.origin,
  );

  sendResponse({ ok: true, runId, timings: { contentScriptAcceptedAt: acceptedAt } });
  return false;
});

function injectPageBridge() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.async = false;
  script.onload = () => script.remove();
  (document.documentElement || document.head).appendChild(script);
}

function safeSendMessage(message) {
  try {
    chrome.runtime.sendMessage(message);
  } catch {
    // Extension context can disappear during reloads.
  }
}

function randomId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
