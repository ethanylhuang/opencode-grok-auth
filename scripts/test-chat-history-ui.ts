import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const responses = [
  { conversationId: 'conv-alpha', responseId: 'resp-alpha-1', text: 'Alpha answer 1' },
  { conversationId: 'conv-alpha', responseId: 'resp-alpha-2', text: 'Alpha answer 2' },
  { conversationId: 'conv-beta', responseId: 'resp-beta-1', text: 'Beta answer 1' },
  { conversationId: 'conv-alpha', responseId: 'resp-alpha-3', text: 'Alpha answer 3' },
];

async function main() {
  const store: Record<string, string> = {};
  const requests: any[] = [];
  const harness = createHarness(store, requests);

  await sendPrompt(harness, 'Alpha one');
  assertRequest(requests[0], {
    model: 'grok-latest-new',
    absentConversation: true,
    absentParent: true,
  });
  assertSession(sessions(store), 'conv-alpha', 'resp-alpha-1', 'Alpha one');

  await sendPrompt(harness, 'Alpha two');
  assertRequest(requests[1], {
    model: 'grok-latest',
    conversationId: 'conv-alpha',
    parentResponseId: 'resp-alpha-1',
  });
  assertSession(sessions(store), 'conv-alpha', 'resp-alpha-2', 'Alpha one');

  harness.elements.newChatBtn.click();
  await sendPrompt(harness, 'Beta one');
  assertRequest(requests[2], {
    model: 'grok-latest-new',
    absentConversation: true,
    absentParent: true,
  });
  assertSession(sessions(store), 'conv-beta', 'resp-beta-1', 'Beta one');

  clickChatByConversation(harness, 'conv-alpha');
  await sendPrompt(harness, 'Alpha three');
  assertRequest(requests[3], {
    model: 'grok-latest',
    conversationId: 'conv-alpha',
    parentResponseId: 'resp-alpha-2',
  });
  assertSession(sessions(store), 'conv-alpha', 'resp-alpha-3', 'Alpha one');

  const reloaded = createHarness(store, requests);
  const persisted = sessions(store);
  assertSession(persisted, 'conv-alpha', 'resp-alpha-3', 'Alpha one');
  assertSession(persisted, 'conv-beta', 'resp-beta-1', 'Beta one');
  if (reloaded.chatButtons().length !== 2) {
    throw new Error(`Expected two persisted chat buttons after reload, got ${reloaded.chatButtons().length}`);
  }

  console.log(`requests=${JSON.stringify(requests)}`);
  console.log(`sessions=${JSON.stringify(persisted)}`);
  console.log('PASS chat history UI');
}

function createHarness(store: Record<string, string>, requests: any[]) {
  const html = fs.readFileSync(path.join(process.cwd(), 'web', 'index.html'), 'utf8');
  const scriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/);
  if (!scriptMatch?.[1]) {
    throw new Error('Could not find inline web script');
  }

  const elements = makeElements();
  const document = {
    getElementById: (id: string) => {
      const element = elements[id];
      if (!element) {
        throw new Error(`Unknown element id ${id}`);
      }
      return element;
    },
    createElement: () => new MockElement(),
  };

  const context = vm.createContext({
    console,
    Date,
    document,
    Error,
    fetch: mockFetch(requests),
    JSON,
    localStorage: mockLocalStorage(store),
    Math,
    Object,
    setInterval: () => 0,
    setTimeout,
    String,
    TextDecoder,
  });

  vm.runInContext(scriptMatch[1], context, { filename: 'web/index.html inline script' });

  return {
    elements,
    store,
    chatButtons: () => elements.chatList.querySelectorAll('button[data-chat-id]'),
  };
}

function makeElements() {
  const ids = [
    'promptForm',
    'prompt',
    'output',
    'sendBtn',
    'status',
    'timings',
    'summary',
    'healthSummary',
    'healthGrid',
    'healthDetail',
    'refreshHealthBtn',
    'newChatBtn',
    'chatList',
  ];
  return Object.fromEntries(ids.map((id) => [id, new MockElement(id)])) as Record<string, MockElement>;
}

class MockElement {
  id: string;
  className = '';
  dataset: Record<string, string> = {};
  disabled = false;
  value = '';
  private listeners: Record<string, Array<(event: any) => void>> = {};
  private buttons: MockElement[] = [];
  private html = '';
  private text = '';

  constructor(id = '') {
    this.id = id;
  }

  set innerHTML(value: string) {
    this.html = value;
    this.text = stripTags(value);
    if (this.id === 'chatList') {
      this.buttons = parseChatButtons(value);
    }
  }

  get innerHTML() {
    return this.html || escapeHtml(this.text);
  }

  set innerText(value: string) {
    this.text = String(value);
    this.html = escapeHtml(this.text);
  }

  get innerText() {
    return this.text;
  }

  set textContent(value: string) {
    this.text = String(value);
    this.html = escapeHtml(this.text);
  }

  get textContent() {
    return this.text;
  }

  addEventListener(type: string, handler: (event: any) => void) {
    this.listeners[type] ||= [];
    this.listeners[type].push(handler);
  }

  dispatchEvent(event: any) {
    for (const handler of this.listeners[event.type] || []) {
      handler(event);
    }
  }

  click() {
    this.dispatchEvent({ type: 'click' });
  }

  focus() {
  }

  querySelectorAll(selector: string) {
    return selector === 'button[data-chat-id]' ? this.buttons : [];
  }
}

function parseChatButtons(html: string) {
  const buttons: MockElement[] = [];
  const pattern = /<button[^>]*data-chat-id="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const button = new MockElement();
    button.dataset.chatId = match[1];
    button.textContent = stripTags(match[2]);
    buttons.push(button);
  }
  return buttons;
}

function mockFetch(requests: any[]) {
  return async (url: string, init?: any) => {
    if (url === 'http://127.0.0.1:11434/health') {
      return jsonResponse({
        ok: true,
        bridge: {
          connected: true,
          activeGrokTab: true,
          hasRequestTemplate: true,
          proxyHasNewTemplateOverride: true,
        },
        jobs: { queued: 0, active: 0 },
        metrics: { failedJobs: 0, createdJobs: requests.length, completedJobs: requests.length },
      });
    }

    if (url === 'http://127.0.0.1:11434/v1/chat/completions') {
      const body = JSON.parse(init?.body || '{}');
      requests.push(body);
      const response = responses[requests.length - 1];
      if (!response) {
        return textResponse('Unexpected chat request', 500);
      }
      return sseResponse(response);
    }

    return textResponse(`Unexpected fetch URL ${url}`, 404);
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status: number) {
  return new Response(body, { status });
}

function sseResponse(response: { conversationId: string; responseId: string; text: string }) {
  const body = [
    `event: grok-response-metadata\ndata: ${JSON.stringify({
      conversationId: response.conversationId,
      responseId: response.responseId,
    })}`,
    `data: ${JSON.stringify({
      choices: [{ delta: { content: response.text }, index: 0, finish_reason: null }],
    })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'X-Grok-Job-Id': 'job-test',
    },
  });
}

async function sendPrompt(harness: ReturnType<typeof createHarness>, prompt: string) {
  harness.elements.prompt.value = prompt;
  harness.elements.promptForm.dispatchEvent({
    type: 'submit',
    preventDefault() {
    },
  });
  await waitFor(() => harness.elements.status.innerText === 'Done');
}

function clickChatByConversation(harness: ReturnType<typeof createHarness>, conversationId: string) {
  const session = sessions(harness.store).find((item) => item.conversationId === conversationId);
  if (!session) {
    throw new Error(`Missing session ${conversationId}`);
  }
  const button = harness.chatButtons().find((item) => item.dataset.chatId === session.id);
  if (!button) {
    throw new Error(`Missing chat button for session ${session.id}`);
  }
  button.click();
}

function sessions(store: Record<string, string>) {
  return JSON.parse(store['grok-chat-sessions'] || '[]');
}

function assertRequest(actual: any, expected: any) {
  if (!actual) {
    throw new Error(`Missing request for ${JSON.stringify(expected)}`);
  }
  if (actual.model !== expected.model) {
    throw new Error(`Expected model ${expected.model}, got ${actual.model}`);
  }
  if (expected.absentConversation && 'conversationId' in actual) {
    throw new Error(`Expected no conversationId on new chat request, got ${JSON.stringify(actual)}`);
  }
  if (expected.absentParent && 'parentResponseId' in actual) {
    throw new Error(`Expected no parentResponseId on new chat request, got ${JSON.stringify(actual)}`);
  }
  if (expected.conversationId && actual.conversationId !== expected.conversationId) {
    throw new Error(`Expected conversationId ${expected.conversationId}, got ${actual.conversationId}`);
  }
  if (expected.parentResponseId && actual.parentResponseId !== expected.parentResponseId) {
    throw new Error(`Expected parentResponseId ${expected.parentResponseId}, got ${actual.parentResponseId}`);
  }
}

function assertSession(allSessions: any[], conversationId: string, parentResponseId: string, title: string) {
  const session = allSessions.find((item) => item.conversationId === conversationId);
  if (!session) {
    throw new Error(`Missing session ${conversationId}: ${JSON.stringify(allSessions)}`);
  }
  if (session.parentResponseId !== parentResponseId || session.title !== title) {
    throw new Error(`Unexpected session ${conversationId}: ${JSON.stringify(session)}`);
  }
}

function mockLocalStorage(store: Record<string, string>) {
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
}

async function waitFor(check: () => boolean) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for UI async work');
}

function stripTags(value: string) {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
