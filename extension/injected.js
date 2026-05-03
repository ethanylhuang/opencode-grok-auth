(function installOpenCodeGrokBridge() {
  const PAGE_SOURCE = 'opencode-grok-auth-page';
  const EXTENSION_SOURCE = 'opencode-grok-auth-extension';
  const VERSION_KEY = '__opencodeGrokAuthBridgeVersion';
  const VERSION = '8';
  const ORIGINAL_FETCH_KEY = '__opencodeGrokAuthOriginalFetch';
  const BRIDGE_REPLAY_MARKER = '__opencodeGrokBridgeReplay';
  const UI_FALLBACK_STORAGE_KEY = 'opencodeGrokAuthAllowUiFallback';

  if (window[VERSION_KEY] === VERSION) {
    return;
  }

  Object.defineProperty(window, VERSION_KEY, { value: VERSION, configurable: true });

  if (!window[ORIGINAL_FETCH_KEY]) {
    Object.defineProperty(window, ORIGINAL_FETCH_KEY, { value: window.fetch.bind(window), configurable: true });
  }

  const originalFetch = window[ORIGINAL_FETCH_KEY];
  let pendingUiJob = null;

  window.fetch = function patchedFetch(input, init) {
    const url = requestUrl(input);
    const shouldObserve = isGrokResponseUrl(url);

    try {
      if (shouldObserve) {
        observeFetch(url, input, init);
      }
    } catch {
      // Observation must never affect normal Grok page behavior.
    }

    const responsePromise = originalFetch(input, init);
    if (shouldObserve && pendingUiJob) {
      captureUiJobResponse(responsePromise, pendingUiJob);
      pendingUiJob = null;
    }

    return responsePromise;
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== EXTENSION_SOURCE) {
      return;
    }

    if (event.data.type === 'RUN_GROK_JOB_V2') {
      void runGrokJob(event.data.runId, event.data.job, event.data.requestTemplate);
    }
  });

  function observeFetch(url, input, init) {
    if (isBridgeReplayRequest(input, init)) {
      return;
    }

    if (init && typeof init.body === 'string') {
      captureRequest(url, init.body, init.headers);
      return;
    }

    if (input instanceof Request) {
      void input
        .clone()
        .text()
        .then((body) => captureRequest(url, body, input.headers))
        .catch(() => {});
    }
  }

  function requestUrl(input) {
    if (typeof input === 'string') {
      return new URL(input, location.origin).toString();
    }
    if (input instanceof URL) {
      return input.toString();
    }
    if (input instanceof Request) {
      return input.url;
    }
    return '';
  }

  function isGrokResponseUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      return parsed.origin === location.origin && /^\/rest\/app-chat\/conversations\/(new|[^/]+\/responses)$/.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function isBridgeReplayRequest(input, init) {
    try {
      return Boolean(init && init[BRIDGE_REPLAY_MARKER] === true);
    } catch {
      return false;
    }
  }

  function captureRequest(url, bodyText, headersInput) {
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return;
    }

    window.postMessage(
      {
        source: PAGE_SOURCE,
        type: 'GROK_REQUEST_OBSERVED',
        detail: {
          url,
          body,
          headers: headersToObject(headersInput),
          referer: location.href,
        },
      },
      location.origin,
    );
  }

  async function runGrokJob(runId, job, requestTemplate) {
    console.log('[injected] runGrokJob called', { runId, jobId: job?.id, templateUrl: requestTemplate?.url });
    if (!job || typeof job.id !== 'string') {
      return;
    }

    try {
      if (!requestTemplate || typeof requestTemplate.url !== 'string' || !requestTemplate.body) {
        throw new Error('Missing captured Grok request template.');
      }

      const jobTimings = {};
      const response = await directGrokFetch(runId, job, requestTemplate, jobTimings);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (response.status === 403 && isUiFallbackEnabled()) {
          await runGrokJobThroughUi(runId, job);
          return;
        }
        if (response.status === 403) {
          throw new Error(
            `Grok direct replay returned HTTP 403. UI fallback is disabled by default; set localStorage.${UI_FALLBACK_STORAGE_KEY} = "1" on grok.com to diagnose the slower UI path.`,
          );
        }
        throw new Error(`Grok upstream returned HTTP ${response.status}: ${body.slice(0, 500)}`);
      }

      await streamGrokResponse(runId, job.id, response, jobTimings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      postPageMessage('GROK_JOB_ERROR', runId, job.id, { error: message });
    }
  }

  async function directGrokFetch(runId, job, requestTemplate, jobTimings) {
    const payload = buildPayload(requestTemplate.body, job.prompt);
    const headers = buildHeaders(requestTemplate.headers);

    markPageTiming(runId, job.id, jobTimings, 'grokFetchStartedAt');
    const response = await originalFetch(requestTemplate.url, {
      method: 'POST',
      credentials: 'include',
      headers,
      referrer: requestTemplate.referer || location.href,
      body: JSON.stringify(payload),
      [BRIDGE_REPLAY_MARKER]: true,
    });
    markPageTiming(runId, job.id, jobTimings, 'grokResponseHeadersAt');

    console.log('[injected] directGrokFetch response', {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      url: requestTemplate.url,
    });

    return response;
  }

  async function runGrokJobThroughUi(runId, job) {
    pendingUiJob = {
      runId,
      jobId: job.id,
      timeout: setTimeout(() => {
        if (pendingUiJob && pendingUiJob.jobId === job.id) {
          pendingUiJob = null;
          postPageMessage('GROK_JOB_ERROR', runId, job.id, {
            error: 'Timed out waiting for Grok page UI to send a request.',
          });
        }
      }, 30000),
    };

    try {
      await submitPromptToGrokUi(job.prompt);
    } catch (error) {
      if (pendingUiJob && pendingUiJob.jobId === job.id) {
        clearTimeout(pendingUiJob.timeout);
        pendingUiJob = null;
      }
      throw error;
    }
  }

  function captureUiJobResponse(responsePromise, uiJob) {
    clearTimeout(uiJob.timeout);
    void responsePromise
      .then((response) => {
        if (!response.ok) {
          return response
            .text()
            .catch(() => '')
            .then((body) => {
              throw new Error(`Grok UI request returned HTTP ${response.status}: ${body.slice(0, 500)}`);
            });
        }
        return streamGrokResponse(uiJob.runId, uiJob.jobId, response.clone());
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        postPageMessage('GROK_JOB_ERROR', uiJob.runId, uiJob.jobId, { error: message });
      });
  }

  async function streamGrokResponse(runId, jobId, response, jobTimings) {
    try {
      if (!response.body) {
        throw new Error('Grok upstream response did not include a readable stream.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let firstRawChunk = true;

      while (true) {
        const read = await reader.read();
        if (read.done) {
          break;
        }

        const chunk = decoder.decode(read.value, { stream: true });
        if (chunk) {
          const timings = firstRawChunk ? { ...jobTimings, firstRawUpstreamChunkAt: Date.now() } : undefined;
          firstRawChunk = false;
          postPageMessage('GROK_JOB_CHUNK', runId, jobId, { chunk, timings });
        }
      }

      const tail = decoder.decode();
      if (tail) {
        postPageMessage('GROK_JOB_CHUNK', runId, jobId, { chunk: tail });
      }

      postPageMessage('GROK_JOB_COMPLETE', runId, jobId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      postPageMessage('GROK_JOB_ERROR', runId, jobId, { error: `streamGrokResponse failed: ${message}` });
    }
  }

  async function submitPromptToGrokUi(prompt) {
    const input = findComposerInput();
    if (!input) {
      throw new Error('Could not find Grok composer input on the page.');
    }

    input.focus();

    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      input.value = prompt;
    } else {
      input.textContent = prompt;
    }

    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(50);

    const button = findSendButton(input);
    if (!button) {
      throw new Error('Could not find enabled Grok send button on the page.');
    }

    button.click();
  }

  function findComposerInput() {
    const selectors = [
      'textarea',
      'input[type="text"]',
      '[contenteditable="true"]',
      '[role="textbox"]',
      '[data-testid*="composer"]',
      '[data-testid*="input"]',
    ];

    for (const selector of selectors) {
      const inputs = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      const writable = inputs.find((input) => !input.disabled && input.getAttribute('aria-disabled') !== 'true');
      if (writable) {
        return writable;
      }
    }

    return null;
  }

  function findSendButton(input) {
    const roots = [input.closest('form'), input.closest('[role="form"]'), input.parentElement, document].filter(Boolean);
    const buttonMatches = (button) => {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true' || !isVisible(button)) {
        return false;
      }

      const label = `${button.getAttribute('aria-label') || ''} ${button.title || ''} ${button.textContent || ''}`;
      return /send|submit/i.test(label) || button.type === 'submit';
    };

    for (const root of roots) {
      const button = Array.from(root.querySelectorAll('button')).find(buttonMatches);
      if (button) {
        return button;
      }
    }

    return null;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function headersToObject(headersInput) {
    const headers = {};
    if (!headersInput) {
      return headers;
    }

    new Headers(headersInput).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });

    return headers;
  }

  function buildHeaders(templateHeaders) {
    const headers = {
      accept: '*/*',
      'content-type': 'application/json',
      ...sanitizeReplayHeaders(templateHeaders),
    };

    if ('x-xai-request-id' in headers) {
      headers['x-xai-request-id'] = randomId();
    }

    return headers;
  }

  function sanitizeReplayHeaders(headers) {
    if (!headers || typeof headers !== 'object') {
      return {};
    }

    const copy = {};
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

  function buildPayload(templateBody, prompt) {
    const payload = clonePlainObject(templateBody);
    payload.message = prompt;
    payload.isRegenRequest = false;
    payload.skipCancelCurrentInflightRequests = false;
    payload.sendFinalMetadata = true;

    if (!payload.metadata || typeof payload.metadata !== 'object') {
      payload.metadata = { request_metadata: {} };
    }

    if (!Array.isArray(payload.imageAttachments)) {
      payload.imageAttachments = [];
    }

    if (!Array.isArray(payload.fileAttachments)) {
      payload.fileAttachments = [];
    }

    return payload;
  }

  function clonePlainObject(value) {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  }

  function postPageMessage(type, runId, jobId, extra) {
    window.postMessage(
      {
        source: PAGE_SOURCE,
        type,
        runId,
        jobId,
        ...(extra || {}),
      },
      location.origin,
    );
  }

  function postTiming(runId, jobId, timings) {
    postPageMessage('GROK_JOB_TIMING', runId, jobId, { timings });
  }

  function markPageTiming(runId, jobId, jobTimings, name) {
    const at = Date.now();
    jobTimings[name] = at;
    postTiming(runId, jobId, { [name]: at });
  }

  function isUiFallbackEnabled() {
    try {
      return window.localStorage.getItem(UI_FALLBACK_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function randomId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
})();
