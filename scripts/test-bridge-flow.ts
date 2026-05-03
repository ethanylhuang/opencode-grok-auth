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
      GROK_LONG_POLL_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proxy.stdout.on('data', (chunk) => process.stdout.write(`[proxy] ${chunk}`));
  proxy.stderr.on('data', (chunk) => process.stderr.write(`[proxy:err] ${chunk}`));

  try {
    await waitForProxy(proxy);

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

    await postJson('/bridge/heartbeat', {
      workerId: 'test-extension',
      activeGrokTab: true,
      hasRequestTemplate: true,
      url: 'https://grok.com/c/test',
    });

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

    await sleep(100);

    const jobResponse = await fetch(`${baseUrl}/bridge/jobs?workerId=test-extension`);
    if (!jobResponse.ok) {
      throw new Error(`Expected bridge job, got HTTP ${jobResponse.status}`);
    }

    const job = (await jobResponse.json()) as { id: string; prompt: string };
    if (!job.id || !job.prompt.includes('Say Hello world.')) {
      throw new Error(`Unexpected bridge job payload: ${JSON.stringify(job)}`);
    }

    const chatResponse = await chatResponsePromise;
    if (!chatResponse.ok) {
      throw new Error(`Chat response failed: HTTP ${chatResponse.status} ${await chatResponse.text()}`);
    }

    const acceptedAt = Date.now();
    await postJson(`/bridge/jobs/${job.id}/timing`, {
      timings: {
        contentScriptAcceptedAt: acceptedAt,
        grokFetchStartedAt: acceptedAt + 1,
        grokResponseHeadersAt: acceptedAt + 2,
      },
    });
    await postJson(`/bridge/jobs/${job.id}/chunks`, {
      chunk: '{"result":{"token":"Hel',
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

    await sleep(100);

    const newJobResponse = await fetch(`${baseUrl}/bridge/jobs?workerId=test-extension`);
    if (!newJobResponse.ok) {
      throw new Error(`Expected new bridge job, got HTTP ${newJobResponse.status}`);
    }

    const newJob = (await newJobResponse.json()) as { id: string; prompt: string; requestTemplate: any };
    if (!newJob.requestTemplate || newJob.requestTemplate.url !== 'https://grok.com/rest/app-chat/conversations/new') {
      throw new Error(`Expected newTemplateOverride to be returned, got ${JSON.stringify(newJob.requestTemplate)}`);
    }

    await postJson(`/bridge/jobs/${newJob.id}/chunks`, { chunk: '{"result":{"token":"Hello new world"}}' });
    await postJson(`/bridge/jobs/${newJob.id}/complete`, { ok: true });
    await newChatResponsePromise;

    const sse = await chatResponse.text();
    const tokenText = extractSseText(sse);
    const metrics = await getJson('/metrics');

    console.log(`job.id=${job.id}`);
    console.log(`job.prompt.bytes=${Buffer.byteLength(job.prompt)}`);
    console.log(`sse.bytes=${Buffer.byteLength(sse)}`);
    console.log(`sse.text=${JSON.stringify(tokenText)}`);
    console.log(`metrics=${JSON.stringify(metrics)}`);

    if (tokenText !== 'Hello world') {
      throw new Error(`Expected "Hello world", got ${JSON.stringify(tokenText)}`);
    }

    if (!sse.includes('data: [DONE]')) {
      throw new Error('Expected terminal [DONE] SSE frame');
    }

    if (!sse.includes('event: grok-timing') || !sse.includes('firstParsedNonThinkingTokenAt')) {
      throw new Error(`Expected debug timing SSE frames, got ${sse}`);
    }

    console.log('PASS bridge flow');
  } finally {
    proxy.kill('SIGTERM');
    await once(proxy, 'exit').catch(() => undefined);
  }
}

async function waitForProxy(proxy: ReturnType<typeof spawn>) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5000) {
    if (proxy.exitCode !== null) {
      throw new Error(`Proxy exited early with code ${proxy.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      await sleep(100);
    }
  }

  throw new Error('Timed out waiting for proxy /health');
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
