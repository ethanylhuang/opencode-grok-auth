import * as http from 'node:http';

const port = Number(process.env.GROK_TEST_PORT ?? 11987);
const baseUrl = `http://127.0.0.1:${port}`;

type PushEvent = {
  eventName: string;
  data: any;
};

type PushClient = {
  next: (eventName?: string) => Promise<any>;
  close: () => void;
};

type PushWaiter = {
  eventName: string;
  resolve: (value: any) => void;
};

async function main() {
  let pushClient: PushClient | null = null;
  process.env.GROK_EXTENSION_TTL_MS = process.env.GROK_EXTENSION_TTL_MS ?? '60000';
  process.env.GROK_JOB_TIMEOUT_MS = process.env.GROK_JOB_TIMEOUT_MS ?? '10000';
  process.env.GROK_LONG_POLL_MS = process.env.GROK_LONG_POLL_MS ?? '1000';
  const { createProxyServer } = await import('../src/proxy');
  const proxy = createProxyServer();

  try {
    await listen(proxy, port);

    const missingBridgeResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'grok-latest',
        stream: true,
        messages: [{ role: 'user', content: 'This should fail before extension heartbeat.' }],
      }),
    });
    const missingBridgeBody = await missingBridgeResponse.text();
    console.log(`missingBridge.status=${missingBridgeResponse.status}`);
    if (missingBridgeResponse.status !== 503 || !missingBridgeBody.includes('extension bridge is not ready')) {
      throw new Error(`Expected clear missing-extension 503, got ${missingBridgeResponse.status}: ${missingBridgeBody}`);
    }

    const initialHealth = await getJson('/health') as { bridge?: { fastPath?: { enabled?: boolean } } };
    const fastPathEnabled = initialHealth.bridge?.fastPath?.enabled !== false;

    if (fastPathEnabled) {
      await postJson('/bridge/heartbeat', {
        workerId: 'stale-extension',
        activeGrokTab: true,
        hasRequestTemplate: true,
        url: 'https://grok.com/c/stale',
        manifestVersion: '0.1.4',
        backgroundCodeVersion: 'm4-push-port-v1',
      });

      const staleBridgeResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'grok-latest',
          stream: true,
          messages: [{ role: 'user', content: 'This should fail with a stale extension.' }],
        }),
      });
      const staleBridgeBody = await staleBridgeResponse.text();
      console.log(`staleBridge.status=${staleBridgeResponse.status}`);
      if (
        staleBridgeResponse.status !== 503 ||
        !staleBridgeBody.includes('extension bridge is stale') ||
      !staleBridgeBody.includes('required background m4-push-port-v8')
      ) {
        throw new Error(`Expected clear stale-extension 503, got ${staleBridgeResponse.status}: ${staleBridgeBody}`);
      }
    } else {
      await postJson('/bridge/heartbeat', {
        workerId: 'stale-extension',
        activeGrokTab: true,
        hasRequestTemplate: true,
        url: 'https://grok.com/c/stale',
        manifestVersion: '0.1.4',
        backgroundCodeVersion: 'm4-push-port-v1',
      });

      const stalePollResponse = await fetch(`${baseUrl}/bridge/jobs?workerId=stale-extension&timeoutMs=0`);
      const stalePollBody = await stalePollResponse.text();
      console.log(`stalePoll.status=${stalePollResponse.status}`);
      if (stalePollResponse.status !== 409 || !stalePollBody.includes('required background m4-push-port-v8')) {
        throw new Error(`Expected stale polling worker to be rejected, got ${stalePollResponse.status}: ${stalePollBody}`);
      }
    }

    await postJson('/bridge/heartbeat', {
      workerId: 'test-extension',
      activeGrokTab: true,
      hasRequestTemplate: true,
      url: 'https://grok.com/c/test',
      manifestVersion: '0.1.11',
      backgroundCodeVersion: 'm4-push-port-v8',
    });
    await postJson('/bridge/template', {
      url: 'https://grok.com/rest/app-chat/conversations/regular-test/responses',
      body: {
        message: '',
        parentResponseId: 'regular-parent',
      },
      headers: { accept: '*/*' },
      referer: 'https://grok.com/c/regular-test',
    });
    await postJson('/bridge/template', {
      url: 'https://grok.com/rest/app-chat/conversations/new',
      body: {
        temporary: false,
        message: '',
      },
      headers: { accept: '*/*' },
    });

    pushClient = fastPathEnabled ? await openPushClient('test-extension') : null;
    if (pushClient) {
      await pushClient.next('ready');
      const pollDefault = await fetch(`${baseUrl}/bridge/jobs?workerId=test-extension`);
      if (pollDefault.status !== 409) {
        throw new Error(`Expected default poll to be rejected while fast path is enabled, got HTTP ${pollDefault.status}`);
      }
      await postJson('/bridge/native-probe', { prompt: 'Native probe from test' });
      const nativeProbe = await pushClient.next('native-probe');
      if (nativeProbe.prompt !== 'Native probe from test') {
        throw new Error(`Expected native probe push event, got ${JSON.stringify(nativeProbe)}`);
      }
    }

    const chatResponsePromise = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test',
        'X-Grok-Debug-Timing': '1',
      },
      body: JSON.stringify({
        model: 'grok-latest',
        stream: true,
        messages: [
          { role: 'system', content: 'Keep replies short.' },
          { role: 'user', content: 'Say Hello world.' },
        ],
      }),
    });

    const job = await acquireJob('test-extension', pushClient) as { id: string; prompt: string; requestTemplate: any };
    if (!job.id || !job.prompt.includes('Say Hello world.')) {
      throw new Error(`Unexpected bridge job payload: ${JSON.stringify(job)}`);
    }
    if (!job.requestTemplate || job.requestTemplate.url !== 'https://grok.com/rest/app-chat/conversations/new') {
      throw new Error(`Expected no-conversation requests to use new template, got ${JSON.stringify(job.requestTemplate)}`);
    }

    const chatResponse = await chatResponsePromise;
    if (!chatResponse.ok) {
      throw new Error(`Chat response failed: HTTP ${chatResponse.status} ${await chatResponse.text()}`);
    }

    const acceptedAt = Date.now();
    await postJson(`/bridge/jobs/${job.id}/accept`, {
      workerId: 'test-extension',
      timings: { workerAcceptedAt: acceptedAt },
    });
    await postJson(`/bridge/jobs/${job.id}/timing`, {
      timings: {
        contentScriptAcceptedAt: acceptedAt,
        grokFetchStartedAt: acceptedAt + 1,
        grokResponseHeadersAt: acceptedAt + 2,
      },
    });
    await postJson(`/bridge/jobs/${job.id}/chunks`, {
      chunk: '{"result":{"token":"Thinking","isThinking":true}}{"result":{"token":"Hel',
      timings: { firstRawUpstreamChunkAt: acceptedAt + 3 },
    });
    await postJson(`/bridge/jobs/${job.id}/chunks`, {
      chunk: 'lo","isThinking":false}}{"result":{"token":" world","isThinking":false}}',
    });
    await postJson(`/bridge/jobs/${job.id}/complete`, { ok: true });

    // Test new conversation proxy logic
    await postJson('/bridge/template', {
      url: 'https://grok.com/rest/app-chat/conversations/new',
      body: {
        temporary: false,
        message: "hello",
      },
      headers: { accept: '*/*' }
    });

    const newChatResponsePromise = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-latest-new',
        stream: true,
        messages: [{ role: 'user', content: 'Say Hello new world.' }],
      }),
    });

    const newJob = await acquireJob('test-extension', pushClient) as { id: string; prompt: string; requestTemplate: any };
    if (!newJob.requestTemplate || newJob.requestTemplate.url !== 'https://grok.com/rest/app-chat/conversations/new') {
      throw new Error(`Expected newTemplateOverride to be returned, got ${JSON.stringify(newJob.requestTemplate)}`);
    }

    await postJson(`/bridge/jobs/${newJob.id}/accept`, {
      workerId: 'test-extension',
      timings: { workerAcceptedAt: Date.now() },
    });
    await postJson(`/bridge/jobs/${newJob.id}/chunks`, { chunk: '{"result":{"token":"Hello new world"}}' });
    await postJson(`/bridge/jobs/${newJob.id}/complete`, { ok: true });
    await newChatResponsePromise;

    const sse = await chatResponse.text();
    const tokenText = extractSseText(sse);
    const reasoningText = extractSseReasoning(sse);
    const metrics = await getJson('/metrics');

    console.log(`job.id=${job.id}`);
    console.log(`job.prompt.bytes=${Buffer.byteLength(job.prompt)}`);
    console.log(`sse.bytes=${Buffer.byteLength(sse)}`);
    console.log(`sse.text=${JSON.stringify(tokenText)}`);
    console.log(`metrics=${JSON.stringify(metrics)}`);

    if (tokenText !== 'Hello world') {
      throw new Error(`Expected "Hello world", got ${JSON.stringify(tokenText)}`);
    }
    if (reasoningText !== 'Thinking') {
      throw new Error(`Expected reasoning token to stream separately, got ${JSON.stringify(reasoningText)}`);
    }

    if (!sse.includes('data: [DONE]')) {
      throw new Error('Expected terminal [DONE] SSE frame');
    }

    if (
      !sse.includes('event: grok-timing') ||
      !sse.includes('firstParsedReasoningTokenAt') ||
      !sse.includes('firstParsedNonThinkingTokenAt')
    ) {
      throw new Error(`Expected debug timing SSE frames, got ${sse}`);
    }

    const finalOnlyResponsePromise = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-latest',
        stream: true,
        messages: [{ role: 'user', content: 'Return final-only text.' }],
      }),
    });

    const finalOnlyJob = await acquireJob('test-extension', pushClient) as { id: string; prompt: string };
    await postJson(`/bridge/jobs/${finalOnlyJob.id}/accept`, {
      workerId: 'test-extension',
      timings: { workerAcceptedAt: Date.now() },
    });
    await postJson(`/bridge/jobs/${finalOnlyJob.id}/chunks`, {
      chunk: '{"result":{"modelResponse":{"message":"Final only","sender":"ASSISTANT"}}}',
    });
    await postJson(`/bridge/jobs/${finalOnlyJob.id}/complete`, { ok: true });

    const finalOnlyResponse = await finalOnlyResponsePromise;
    const finalOnlySse = await finalOnlyResponse.text();
    const finalOnlyText = extractSseText(finalOnlySse);
    if (finalOnlyText !== 'Final only') {
      throw new Error(`Expected final modelResponse.message fallback, got ${JSON.stringify(finalOnlyText)}`);
    }

    console.log('PASS bridge flow');
  } finally {
    pushClient?.close();
    await close(proxy);
  }
}

function listen(server: http.Server, listenPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(listenPort, '127.0.0.1');
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function acquireJob(workerId: string, pushClient: PushClient | null) {
  if (pushClient) {
    return pushClient.next('job');
  }

  const jobResponse = await fetch(`${baseUrl}/bridge/jobs?workerId=${encodeURIComponent(workerId)}&fallback=1`);
  if (!jobResponse.ok) {
    throw new Error(`Expected fallback bridge job, got HTTP ${jobResponse.status}`);
  }
  return jobResponse.json();
}

async function openPushClient(workerId: string): Promise<PushClient> {
  const controller = new AbortController();
  const response = await fetch(
    `${baseUrl}/bridge/events?workerId=${encodeURIComponent(workerId)}&capabilities=test`,
    { signal: controller.signal },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Could not open push control stream: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: PushEvent[] = [];
  const waiters: PushWaiter[] = [];
  let buffer = '';

  void (async () => {
    try {
      while (true) {
        const read = await reader.read();
        if (read.done) {
          break;
        }
        buffer += decoder.decode(read.value, { stream: true });
        buffer = processPushBuffer(buffer, false, events, waiters);
      }
      buffer += decoder.decode();
      processPushBuffer(buffer, true, events, waiters);
    } catch {
    }
  })();

  return {
    next(eventName = '') {
      const existingIndex = events.findIndex((event) => !eventName || event.eventName === eventName);
      if (existingIndex !== -1) {
        const [event] = events.splice(existingIndex, 1);
        return Promise.resolve(event.data);
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for push event ${eventName || '*'}`));
        }, 5000);

        waiters.push({
          eventName,
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
        });
      });
    },
    close() {
      controller.abort();
    },
  };
}

function processPushBuffer(
  buffer: string,
  flush: boolean,
  events: PushEvent[],
  waiters: PushWaiter[],
): string {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = flush ? '' : parts.pop() || '';

  for (const part of parts) {
    const event = parsePushFrame(part);
    if (event) {
      const waiterIndex = waiters.findIndex((item) => !item.eventName || item.eventName === event.eventName);
      const waiter = waiterIndex === -1 ? null : waiters.splice(waiterIndex, 1)[0];
      if (waiter) {
        waiter.resolve(event.data);
      } else {
        events.push(event);
      }
    }
  }

  if (flush && parts.length === 0 && buffer.trim()) {
    const event = parsePushFrame(buffer);
    if (event) {
      events.push(event);
    }
  }

  return remainder;
}

function parsePushFrame(frame: string): PushEvent | null {
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
    return null;
  }

  return {
    eventName,
    data: JSON.parse(dataLines.join('\n')),
  };
}

async function postJson(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`POST ${path} failed: HTTP ${response.status} ${await response.text()}`);
  }

  return response;
}

async function getJson(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed: HTTP ${response.status}`);
  }
  return response.json();
}

function extractSseText(sse: string): string {
  let text = '';

  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }

    const data = line.slice('data: '.length);
    if (data === '[DONE]') {
      continue;
    }

    const payload = JSON.parse(data);
    const content = payload.choices?.[0]?.delta?.content;
    if (typeof content === 'string') {
      text += content;
    }
  }

  return text;
}

function extractSseReasoning(sse: string): string {
  let text = '';

  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }

    const data = line.slice('data: '.length);
    if (data === '[DONE]') {
      continue;
    }

    const payload = JSON.parse(data);
    const content = payload.choices?.[0]?.delta?.reasoning_content;
    if (typeof content === 'string') {
      text += content;
    }
  }

  return text;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
