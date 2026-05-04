import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

async function main() {
  const injectedPath = path.join(process.cwd(), 'extension', 'injected.js');
  const source = fs.readFileSync(injectedPath, 'utf8');
  const posted: any[] = [];
  let messageHandler: ((event: any) => void) | null = null;
  let capturedFetch: { url: string; options: any } | null = null;

  const encoder = new TextEncoder();
  const windowObject: any = {
    location: {
      origin: 'https://grok.com',
      href: 'https://grok.com/',
    },
    localStorage: {
      getItem: () => null,
    },
    addEventListener: (type: string, handler: (event: any) => void) => {
      if (type === 'message') {
        messageHandler = handler;
      }
    },
    postMessage: (message: unknown) => {
      posted.push(message);
    },
    fetch: async (url: string, options: any) => {
      capturedFetch = { url: String(url), options };
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                '{"result":{"response":{"conversationId":"conv-selected","responseId":"resp-next","token":"ok","isThinking":false}}}',
              ),
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  };

  const context = vm.createContext({
    console,
    crypto,
    Headers,
    location: windowObject.location,
    Response,
    setTimeout,
    structuredClone,
    TextDecoder,
    URL,
    window: windowObject,
  });

  vm.runInContext(source, context, { filename: injectedPath });
  if (!messageHandler) {
    throw new Error('Injected bridge did not register a message handler');
  }

  messageHandler({
    source: windowObject,
    data: {
      source: 'opencode-grok-auth-extension',
      type: 'RUN_GROK_JOB_V2',
      runId: 'run-1',
      job: {
        id: 'job-1',
        prompt: 'Continue selected chat',
        conversationId: 'conv-selected',
        parentResponseId: 'resp-selected',
      },
      requestTemplate: {
        url: 'https://grok.com/rest/app-chat/conversations/template-conv/responses',
        body: {
          message: '',
          parentResponseId: 'template-parent',
          disableMemory: false,
          forceConcise: false,
        },
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          'x-xai-request-id': 'template-request-id',
        },
        referer: 'https://grok.com/c/template-conv',
      },
    },
  });

  await waitFor(() => posted.some((message) => message.type === 'GROK_JOB_COMPLETE'));

  if (!capturedFetch) {
    throw new Error('Injected bridge did not call fetch');
  }

  const body = JSON.parse(capturedFetch.options.body);
  console.log(`fetch.url=${capturedFetch.url}`);
  console.log(`fetch.referrer=${capturedFetch.options.referrer}`);
  console.log(`payload=${JSON.stringify(body)}`);
  console.log(`posted=${posted.map((message) => message.type).join(',')}`);

  if (capturedFetch.url !== 'https://grok.com/rest/app-chat/conversations/conv-selected/responses') {
    throw new Error(`Expected selected conversation URL rewrite, got ${capturedFetch.url}`);
  }
  if (capturedFetch.options.referrer !== 'https://grok.com/c/conv-selected') {
    throw new Error(`Expected selected conversation referrer, got ${capturedFetch.options.referrer}`);
  }
  if (body.message !== 'Continue selected chat') {
    throw new Error(`Expected prompt payload, got ${JSON.stringify(body)}`);
  }
  if (body.parentResponseId !== 'resp-selected') {
    throw new Error(`Expected selected parentResponseId, got ${body.parentResponseId}`);
  }
  if (body.disableMemory === true || body.forceConcise === true) {
    throw new Error(`Expected replay payload to preserve non-polluted settings, got ${JSON.stringify(body)}`);
  }
  if (!posted.some((message) => message.type === 'GROK_JOB_CHUNK')) {
    throw new Error('Expected streamed chunk postMessage');
  }

  console.log('PASS extension routing');
}

async function waitFor(check: () => boolean) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for async bridge work');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
