import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type FetchCall = {
  url: string;
  options: any;
};

type Harness = {
  button: FakeButton;
  fetchCalls: FetchCall[];
  messageHandler: (event: any) => void;
  posted: any[];
  windowObject: any;
};

async function main() {
  await testDirectContinuationRouting();
  await testTrackedContinuationUiFallback();
  console.log('PASS extension routing');
}

async function testDirectContinuationRouting() {
  const harness = createHarness({
    fetch: async (url, options) => streamResponse(
      '{"result":{"response":{"conversationId":"conv-selected","responseId":"resp-next","token":"ok","isThinking":false}}}',
      url,
      options,
      harness.fetchCalls,
    ),
  });

  runContinuationJob(harness, 'job-direct');
  await waitFor(() => harness.posted.some((message) => message.type === 'GROK_JOB_COMPLETE'));

  const capturedFetch = harness.fetchCalls[0];
  if (!capturedFetch) {
    throw new Error('Injected bridge did not call fetch');
  }

  const body = JSON.parse(capturedFetch.options.body);
  console.log(`fetch.url=${capturedFetch.url}`);
  console.log(`fetch.referrer=${capturedFetch.options.referrer}`);
  console.log(`payload=${JSON.stringify(body)}`);
  console.log(`posted=${harness.posted.map((message) => message.type).join(',')}`);

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
  if (!harness.posted.some((message) => message.type === 'GROK_JOB_CHUNK')) {
    throw new Error('Expected streamed chunk postMessage');
  }
}

async function testTrackedContinuationUiFallback() {
  const harness = createHarness({
    fetch: async (url, options) => {
      harness.fetchCalls.push({ url: String(url), options });
      if (harness.fetchCalls.length === 1) {
        return new Response('{"error":{"code":7,"message":"Request rejected by anti-bot rules.","details":[]}}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      return streamResponse(
        '{"result":{"response":{"conversationId":"conv-selected","responseId":"resp-fallback","token":"fallback","isThinking":false}}}',
      );
    },
  });

  harness.button.onClick = () => {
    void harness.windowObject.fetch('https://grok.com/rest/app-chat/conversations/conv-selected/responses', {
      method: 'POST',
      body: JSON.stringify({ message: 'Continue selected chat', parentResponseId: 'resp-selected' }),
      headers: { 'content-type': 'application/json' },
    });
  };

  runContinuationJob(harness, 'job-fallback');
  await waitFor(() => harness.posted.some((message) => message.type === 'GROK_JOB_COMPLETE'));

  if (harness.fetchCalls.length !== 2) {
    throw new Error(`Expected direct replay plus UI fallback fetch, got ${harness.fetchCalls.length}`);
  }
  if (!harness.button.clicked) {
    throw new Error('Expected UI fallback to click the Grok send button');
  }
  if (!harness.posted.some((message) => message.type === 'GROK_JOB_CHUNK')) {
    throw new Error('Expected fallback streamed chunk postMessage');
  }
}

function createHarness(options: { fetch: (url: string, options: any) => Promise<Response> }): Harness {
  const injectedPath = path.join(process.cwd(), 'extension', 'injected.js');
  const source = fs.readFileSync(injectedPath, 'utf8');
  const posted: any[] = [];
  const fetchCalls: FetchCall[] = [];
  let messageHandler: ((event: any) => void) | null = null;
  const input = new FakeTextAreaElement();
  const button = new FakeButton();
  input.parentElement = { querySelectorAll: (selector: string) => selector === 'button' ? [button] : [] };

  const windowObject: any = {
    location: {
      origin: 'https://grok.com',
      href: 'https://grok.com/c/conv-selected',
    },
    localStorage: {
      getItem: () => null,
    },
    addEventListener: (type: string, handler: (event: any) => void) => {
      if (type === 'message') {
        messageHandler = handler;
      }
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    postMessage: (message: unknown) => {
      posted.push(message);
    },
    fetch: (url: string, init: any) => options.fetch(url, init),
  };

  const context = vm.createContext({
    console,
    crypto,
    Event: FakeEvent,
    Headers,
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: FakeTextAreaElement,
    InputEvent: FakeEvent,
    clearTimeout,
    location: windowObject.location,
    document: {
      querySelectorAll: (selector: string) => selector === 'textarea' ? [input] : [],
    },
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

  return {
    button,
    fetchCalls,
    messageHandler,
    posted,
    windowObject,
  };
}

function runContinuationJob(harness: Harness, jobId: string) {
  harness.messageHandler({
    source: harness.windowObject,
    data: {
      source: 'opencode-grok-auth-extension',
      type: 'RUN_GROK_JOB_V2',
      runId: `run-${jobId}`,
      job: {
        id: jobId,
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
}

function streamResponse(chunk: string, url?: string, options?: any, calls?: FetchCall[]) {
  if (url && calls) {
    calls.push({ url: String(url), options });
  }
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

class FakeEvent {
  constructor(
    readonly type: string,
    readonly options?: any,
  ) {
  }
}

class FakeTextAreaElement {
  disabled = false;
  parentElement: any = null;
  value = '';

  closest() {
    return null;
  }

  dispatchEvent() {
  }

  focus() {
  }

  getAttribute() {
    return null;
  }

  getBoundingClientRect() {
    return { width: 100, height: 30 };
  }
}

class FakeInputElement extends FakeTextAreaElement {
}

class FakeButton {
  clicked = false;
  disabled = false;
  onClick: () => void = () => {};
  textContent = 'Send';
  title = '';
  type = 'button';

  click() {
    this.clicked = true;
    this.onClick();
  }

  getAttribute(name: string) {
    return name === 'aria-label' ? 'Send' : null;
  }

  getBoundingClientRect() {
    return { width: 80, height: 30 };
  }
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
