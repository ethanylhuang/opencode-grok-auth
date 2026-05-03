import { spawn } from 'node:child_process';
import { once } from 'node:events';

const port = Number(process.env.GROK_TEST_PORT ?? 11987);
const baseUrl = `http://127.0.0.1:${port}`;

async function main() {
  const proxy = spawn('npm', ['run', 'proxy'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GROK_PROXY_PORT: String(port),
      GROK_EXTENSION_TTL_MS: '60000',
      GROK_JOB_TIMEOUT_MS: '10000',
      GROK_LONG_POLL_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proxy.stdout.on('data', (chunk) => process.stdout.write(`[proxy] ${chunk}`));
  proxy.stderr.on('data', (chunk) => process.stderr.write(`[proxy:err] ${chunk}`));

  try {
    await waitForProxy(proxy);
    console.log('=== STEP 1: Send request without bridge (should fail) ===');
    const missingBridgeResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'grok-latest-new',
        stream: true,
        messages: [{ role: 'user', content: 'This should fail before extension heartbeat.' }],
      }),
    });
    const missingBridgeBody = await missingBridgeResponse.text();
    console.log(`Status: ${missingBridgeResponse.status}, Body: ${missingBridgeBody.slice(0, 200)}`);
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
    });

    console.log('=== STEP 3: Submit /new template to proxy ===');
    await postJson('/bridge/template', {
      url: 'https://grok.com/rest/app-chat/conversations/new',
      body: {
        temporary: false,
        message: "hello",
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
        modeId: "grok-420-computer-use-sa"
      },
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'origin': 'https://grok.com',
        'referer': 'https://grok.com/',
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
    const chatResponsePromise = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'grok-latest-new',
        stream: true,
        messages: [{ role: 'user', content: 'Say Hello new world.' }],
      }),
    });

    await sleep(200);

    console.log('=== STEP 6: Poll for job and verify it gets the NEW template ===');
    const jobResponse = await fetch(`${baseUrl}/bridge/jobs?workerId=test-extension`);
    if (!jobResponse.ok) {
      throw new Error(`Expected bridge job, got HTTP ${jobResponse.status}`);
    }
    const job = await jobResponse.json();
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

    // Send chunks that look like Grok's streaming response
    await postJson(`/bridge/jobs/${job.id}/chunks`, {
      chunk: '{"result":{"token":"Hello","isThinking":false}}',
      timings: { firstRawUpstreamChunkAt: acceptedAt + 3 },
    });
    await sleep(50);
    await postJson(`/bridge/jobs/${job.id}/chunks`, {
      chunk: '{"result":{"token":" new","isThinking":false}}',
    });
    await sleep(50);
    await postJson(`/bridge/jobs/${job.id}/chunks`, {
      chunk: '{"result":{"token":" world","isThinking":false}}',
    });
    await sleep(50);
    await postJson(`/bridge/jobs/${job.id}/complete`, { ok: true });

    const chatResponse = await chatResponsePromise;
    if (!chatResponse.ok) {
      throw new Error(`Chat response failed: HTTP ${chatResponse.status} ${await chatResponse.text()}`);
    }

    const sse = await chatResponse.text();
    const tokenText = extractSseText(sse);
    const metrics = await getJson('/metrics');

    console.log(`SSE tokens: "${tokenText}"`);
    console.log(`Metrics: ${JSON.stringify(metrics)}`);

    if (tokenText !== 'Hello new world') {
      throw new Error(`Expected "Hello new world", got "${tokenText}"`);
    }
    if (!sse.includes('data: [DONE]')) {
      throw new Error('Expected terminal [DONE] SSE frame');
    }
    console.log('PASS: Streaming works correctly\n');

    console.log('=== STEP 8: Verify OLD conversations still use regular template ===');
    // First submit a regular /responses template
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

    const oldChatPromise = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'grok-latest',  // NOT new
        stream: true,
        messages: [{ role: 'user', content: 'Old chat message.' }],
      }),
    });

    await sleep(200);

    const oldJobResponse = await fetch(`${baseUrl}/bridge/jobs?workerId=test-extension`);
    const oldJob = await oldJobResponse.json();
    console.log(`Old job requestTemplate URL: ${oldJob.requestTemplate?.url}`);

    if (!oldJob.requestTemplate?.url?.includes('/responses')) {
      throw new Error(`Expected old job to get regular template, got ${oldJob.requestTemplate?.url}`);
    }
    console.log('PASS: Old conversations still work correctly\n');

    await postJson(`/bridge/jobs/${oldJob.id}/chunks`, {
      chunk: '{"result":{"token":"Old response"}}',
    });
    await postJson(`/bridge/jobs/${oldJob.id}/complete`, { ok: true });
    await oldChatPromise;

    console.log('ALL TESTS PASSED');

  } finally {
    proxy.kill('SIGTERM');
    await once(proxy, 'exit').catch(() => undefined);
  }
}

async function waitForProxy(proxy) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    if (proxy.exitCode !== null) throw new Error(`Proxy exited with ${proxy.exitCode}`);
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Timeout waiting for proxy');
}

async function postJson(path, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} failed: ${r.status} ${await r.text()}`);
  return r;
}

async function getJson(path) {
  const r = await fetch(`${baseUrl}${path}`);
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
  return r.json();
}

function extractSseText(sse) {
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error(e); process.exit(1); });