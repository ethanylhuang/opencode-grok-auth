import { EventEmitter } from 'node:events';

let handleRequest: typeof import('../src/proxy').handleRequest;

async function main() {
  process.env.GROK_DISABLE_TEMPLATE_RECOVERY = '1';
  process.env.GROK_FAST_PATH = process.env.GROK_FAST_PATH ?? '0';
  ({ handleRequest } = await import('../src/proxy'));

  console.log('=== STEP 1: Send request without bridge (should fail) ===');
  const missingBridgeResponse = await request('POST', '/v1/chat/completions', {
    model: 'grok-latest-new',
    stream: true,
    messages: [{ role: 'user', content: 'This should fail before extension heartbeat.' }],
  });
  console.log(`Status: ${missingBridgeResponse.status}, Body: ${missingBridgeResponse.text.slice(0, 200)}`);
  if (missingBridgeResponse.status !== 503) {
    throw new Error(`Expected 503, got ${missingBridgeResponse.status}`);
  }
  console.log('PASS: Request correctly rejected without bridge\n');

  console.log('=== STEP 2: Register extension heartbeat with NEW conversation template ===');
  await postJson('/bridge/heartbeat', {
    workerId: 'test-extension',
    activeGrokTab: true,
    hasRequestTemplate: true,
    url: 'https://grok.com/c/test',
    manifestVersion: '0.1.11',
    backgroundCodeVersion: 'm4-push-port-v8',
  });

  console.log('=== STEP 3: Submit /new template to proxy ===');
  await postJson('/bridge/template', {
    url: 'https://grok.com/rest/app-chat/conversations/new',
    body: {
      temporary: false,
      message: 'hello',
      disableSearch: false,
      enableImageGeneration: true,
      returnImageBytes: false,
      returnRawGrokInXaiRequest: false,
      enableImageStreaming: true,
      imageGenerationCount: 2,
      forceConcise: false,
      enableSideBySide: true,
      sendFinalMetadata: true,
      disableTextFollowUps: false,
      responseMetadata: {},
      disableMemory: false,
      forceSideBySide: false,
      isAsyncChat: false,
      disableSelfHarmShortCircuit: false,
      collectionIds: [],
      connectors: [],
      deviceEnvInfo: {
        darkModeEnabled: true,
        devicePixelRatio: 2,
        screenWidth: 1512,
        screenHeight: 982,
        viewportWidth: 978,
        viewportHeight: 862,
      },
      modeId: 'grok-420-computer-use-sa',
    },
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      origin: 'https://grok.com',
      referer: 'https://grok.com/',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
    referer: 'https://grok.com/',
  });
  console.log('Template submitted');

  console.log('=== STEP 4: Verify health endpoint shows new template ===');
  const health = await getJson('/health');
  console.log(`proxyHasNewTemplateOverride: ${health.bridge.proxyHasNewTemplateOverride}`);
  if (!health.bridge.proxyHasNewTemplateOverride) {
    throw new Error('Expected proxyHasNewTemplateOverride to be true');
  }
  console.log('PASS: New template is registered\n');

  console.log('=== STEP 5: Send chat completion with model=grok-latest-new ===');
  const chatResponse = startRequest('POST', '/v1/chat/completions', {
    model: 'grok-latest-new',
    stream: true,
    messages: [{ role: 'user', content: 'Say Hello new world.' }],
  });

  await sleep(0);

  console.log('=== STEP 6: Poll for job and verify it gets the NEW template ===');
  const job = await getJson('/bridge/jobs?workerId=test-extension');
  console.log(`Job model: ${job.model}`);
  console.log(`Job requestTemplate URL: ${job.requestTemplate?.url}`);

  if (job.model !== 'grok-latest-new') {
    throw new Error(`Expected model to be grok-latest-new, got ${job.model}`);
  }
  if (!job.requestTemplate || job.requestTemplate.url !== 'https://grok.com/rest/app-chat/conversations/new') {
    throw new Error(`Expected requestTemplate.url to be /new, got ${job.requestTemplate?.url}`);
  }
  console.log('PASS: Job correctly received new conversation template\n');

  console.log('=== STEP 7: Simulate Grok returning streaming response ===');
  const acceptedAt = Date.now();
  await postJson(`/bridge/jobs/${job.id}/timing`, {
    timings: {
      contentScriptAcceptedAt: acceptedAt,
      grokFetchStartedAt: acceptedAt + 1,
      grokResponseHeadersAt: acceptedAt + 2,
    },
  });

  await postJson(`/bridge/jobs/${job.id}/chunks`, {
    chunk: JSON.stringify({
      result: {
        conversation: { id: 'conv-new-123' },
        modelResponse: { id: 'resp-new-draft' },
        response: { token: 'Hello', isThinking: false },
      },
    }),
    timings: { firstRawUpstreamChunkAt: acceptedAt + 3 },
  });
  await sleep(0);
  await postJson(`/bridge/jobs/${job.id}/chunks`, {
    chunk: JSON.stringify({
      result: {
        response: {
          conversation: { id: 'conv-new-123' },
          modelResponse: { id: 'resp-new-mid' },
          token: ' new',
          isThinking: false,
        },
      },
    }),
  });
  await sleep(0);
  await postJson(`/bridge/jobs/${job.id}/chunks`, {
    chunk: JSON.stringify({
      result: {
        conversation_id: 'conv-new-123',
        responseID: 'resp-new-case',
        token: ' world',
        isThinking: false,
      },
    }),
  });
  await sleep(0);
  await postJson(`/bridge/jobs/${job.id}/chunks`, {
    chunk: JSON.stringify({
      result: {
        finalMetadata: JSON.stringify({
          conversationID: 'conv-new-123',
          response_id: 'resp-new-1',
        }),
      },
    }),
  });
  await sleep(0);
  await postJson(`/bridge/jobs/${job.id}/complete`, { ok: true });

  const completedChatResponse = await chatResponse.finished;
  if (completedChatResponse.status !== 200) {
    throw new Error(`Chat response failed: HTTP ${completedChatResponse.status} ${completedChatResponse.text}`);
  }

  const sse = completedChatResponse.text;
  const tokenText = extractSseText(sse);
  const metadata = extractSseMetadata(sse);
  const metrics = await getJson('/metrics');

  console.log(`SSE tokens: "${tokenText}"`);
  console.log(`SSE metadata: ${JSON.stringify(metadata)}`);
  console.log(`Metrics: ${JSON.stringify(metrics)}`);

  if (tokenText !== 'Hello new world') {
    throw new Error(`Expected "Hello new world", got "${tokenText}"`);
  }
  if (metadata.conversationId !== 'conv-new-123' || metadata.responseId !== 'resp-new-1') {
    throw new Error(`Expected new chat metadata, got ${JSON.stringify(metadata)}`);
  }
  if (!sse.includes('data: [DONE]')) {
    throw new Error('Expected terminal [DONE] SSE frame');
  }
  console.log('PASS: Streaming works correctly\n');

  console.log('=== STEP 8: Continue new chat with stored conversationId + parentResponseId ===');
  const continueChat = startRequest('POST', '/v1/chat/completions', {
    model: 'grok-latest',
    conversationId: metadata.conversationId,
    parentResponseId: metadata.responseId,
    stream: true,
    messages: [{ role: 'user', content: 'Continue the new chat.' }],
  });

  await sleep(0);

  const continueJob = await getJson('/bridge/jobs?workerId=test-extension');
  console.log(`Continue job conversationId: ${continueJob.conversationId}`);
  console.log(`Continue job parentResponseId: ${continueJob.parentResponseId}`);
  console.log(`Continue job requestTemplate URL: ${continueJob.requestTemplate?.url}`);

  if (continueJob.model !== 'grok-latest') {
    throw new Error(`Expected continuation model grok-latest, got ${continueJob.model}`);
  }
  if (continueJob.conversationId !== 'conv-new-123' || continueJob.parentResponseId !== 'resp-new-1') {
    throw new Error(`Continuation job lost chat routing fields: ${JSON.stringify(continueJob)}`);
  }
  if (!continueJob.requestTemplate || continueJob.requestTemplate.url !== 'https://grok.com/rest/app-chat/conversations/new') {
    throw new Error(
      `Expected continuation to fall back to /new template before extension URL rewrite, got ${continueJob.requestTemplate?.url}`,
    );
  }

  await postJson(`/bridge/jobs/${continueJob.id}/chunks`, {
    chunk:
      '{"result":{"conversation":{"conversationId":"conv-new-123"},"response":{"modelResponse":{"responseId":"resp-new-2"},"token":"Continued","isThinking":false}}}',
  });
  await postJson(`/bridge/jobs/${continueJob.id}/complete`, { ok: true });

  const completedContinueResponse = await continueChat.finished;
  const continueText = extractSseText(completedContinueResponse.text);
  const continueMetadata = extractSseMetadata(completedContinueResponse.text);
  if (continueText !== 'Continued') {
    throw new Error(`Expected continuation text "Continued", got "${continueText}"`);
  }
  if (continueMetadata.conversationId !== 'conv-new-123' || continueMetadata.responseId !== 'resp-new-2') {
    throw new Error(`Expected updated continuation metadata, got ${JSON.stringify(continueMetadata)}`);
  }
  console.log('PASS: New chat continuation carries isolated chat metadata\n');

  console.log('=== STEP 9: Verify no-session requests start from /new template ===');
  await postJson('/bridge/template', {
    url: 'https://grok.com/rest/app-chat/conversations/old-conv-123/responses',
    body: {
      parentResponseId: 'parent-123',
      message: '',
      disableMemory: false,
      forceConcise: false,
    },
    headers: { accept: '*/*' },
    referer: 'https://grok.com/c/old-conv-123',
  });

  const oldChat = startRequest('POST', '/v1/chat/completions', {
    model: 'grok-latest',
    stream: true,
    messages: [{ role: 'user', content: 'Old chat message.' }],
  });

  await sleep(0);

  const oldJob = await getJson('/bridge/jobs?workerId=test-extension');
  console.log(`Old job requestTemplate URL: ${oldJob.requestTemplate?.url}`);

  if (oldJob.requestTemplate?.url !== 'https://grok.com/rest/app-chat/conversations/new') {
    throw new Error(`Expected no-session job to use /new template, got ${oldJob.requestTemplate?.url}`);
  }
  if (oldJob.conversationId !== null || oldJob.parentResponseId !== null) {
    throw new Error(`Expected no-session job to omit routing fields, got ${JSON.stringify(oldJob)}`);
  }
  console.log('PASS: No-session grok-latest requests start from /new template\n');

  await postJson(`/bridge/jobs/${oldJob.id}/chunks`, {
    chunk: '{"result":{"token":"Old response"}}',
  });
  await postJson(`/bridge/jobs/${oldJob.id}/complete`, { ok: true });
  await oldChat.finished;

  console.log('=== STEP 10: Verify existing conversations still use regular template ===');
  const oldContinuation = startRequest('POST', '/v1/chat/completions', {
    model: 'grok-latest',
    stream: true,
    conversationId: 'old-conv-123',
    parentResponseId: 'parent-123',
    messages: [{ role: 'user', content: 'Continue old chat.' }],
  });

  await sleep(0);

  const oldContinuationJob = await getJson('/bridge/jobs?workerId=test-extension');
  console.log(`Old continuation requestTemplate URL: ${oldContinuationJob.requestTemplate?.url}`);

  if (!oldContinuationJob.requestTemplate?.url?.includes('/responses')) {
    throw new Error(
      `Expected existing conversation job to get regular template, got ${oldContinuationJob.requestTemplate?.url}`,
    );
  }
  if (oldContinuationJob.conversationId !== 'old-conv-123' || oldContinuationJob.parentResponseId !== 'parent-123') {
    throw new Error(`Expected existing conversation routing fields, got ${JSON.stringify(oldContinuationJob)}`);
  }
  console.log('PASS: Existing conversations still use regular template\n');

  await postJson(`/bridge/jobs/${oldContinuationJob.id}/chunks`, {
    chunk: '{"result":{"token":"Old continuation"}}',
  });
  await postJson(`/bridge/jobs/${oldContinuationJob.id}/complete`, { ok: true });
  await oldContinuation.finished;

  console.log('ALL TESTS PASSED');
}

class MockRequest extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket = { remoteAddress: '127.0.0.1' };
  private body: string;

  constructor(method: string, url: string, body: unknown, headers: Record<string, string>) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body === undefined ? '' : JSON.stringify(body);
  }

  start() {
    queueMicrotask(() => {
      if (this.body) {
        this.emit('data', Buffer.from(this.body));
      }
      this.emit('end');
    });
  }

  destroy() {
    this.emit('close');
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  destroyed = false;
  headers: Record<string, string | number | string[]> = {};
  chunks: Buffer[] = [];

  setHeader(name: string, value: string | number | string[]) {
    this.headers[name.toLowerCase()] = value;
  }

  writeHead(status: number, headers?: Record<string, string | number | string[]>) {
    this.statusCode = status;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        this.setHeader(name, value);
      }
    }
    this.headersSent = true;
    return this;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  write(chunk: string | Buffer) {
    this.headersSent = true;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Buffer) {
    if (chunk) {
      this.write(chunk);
    }
    this.destroyed = true;
    this.emit('finish');
    return this;
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function startRequest(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const requestHeaders = { host: 'localhost', 'content-type': 'application/json', ...headers };
  const req = new MockRequest(method, path, body, requestHeaders);
  const res = new MockResponse();
  const finished = new Promise<{ status: number; headers: Record<string, string | number | string[]>; text: string }>(
    (resolve) => {
      res.once('finish', () => {
        resolve({ status: res.statusCode, headers: res.headers, text: res.text() });
      });
    },
  );

  handleRequest(req as any, res as any).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { message } }));
  });
  req.start();

  return { req, res, finished };
}

async function request(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  return startRequest(method, path, body, headers).finished;
}

async function postJson(path: string, body: unknown) {
  const response = await request('POST', path, body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`POST ${path} failed: ${response.status} ${response.text}`);
  }
  return response;
}

async function getJson(path: string) {
  const response = await request('GET', path);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GET ${path} failed: ${response.status} ${response.text}`);
  }
  return JSON.parse(response.text);
}

function extractSseText(sse: string) {
  let text = '';
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice('data: '.length);
    if (data === '[DONE]') continue;
    const payload = JSON.parse(data);
    const content = payload.choices?.[0]?.delta?.content;
    if (typeof content === 'string') text += content;
  }
  return text;
}

function extractSseMetadata(sse: string) {
  const metadata: Record<string, string> = {};
  for (const frame of sse.split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
    if (event !== 'grok-response-metadata') continue;
    const data = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n');
    if (!data) continue;
    Object.assign(metadata, JSON.parse(data));
  }
  return metadata;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
