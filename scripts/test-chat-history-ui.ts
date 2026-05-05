import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type MockChatResponse = {
  conversationId?: string;
  responseId?: string;
  reasoning?: string;
  text: string;
};

const MISSING_METADATA_WARNING =
  'Warning: Grok returned a first response without continuation metadata. This chat cannot be continued; restart the proxy, create a new chat, and send the first prompt again.';

const responses: MockChatResponse[] = [
  { conversationId: 'conv-alpha', responseId: 'resp-alpha-1', reasoning: 'Thinking alpha', text: 'Alpha answer 1' },
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
  assertNewConversationCount(requests, 1);
  assertSession(sessions(store), 'conv-alpha', 'resp-alpha-1', 'Alpha one', ['Alpha one', 'Alpha answer 1']);
  assertTranscript(harness, ['Alpha one', 'Thinking alpha', 'Alpha answer 1']);

  await sendPrompt(harness, 'Alpha two');
  assertRequest(requests[1], {
    model: 'grok-latest',
    conversationId: 'conv-alpha',
    parentResponseId: 'resp-alpha-1',
  });
  assertNewConversationCount(requests, 1);
  assertSession(sessions(store), 'conv-alpha', 'resp-alpha-2', 'Alpha one', [
    'Alpha one',
    'Alpha answer 1',
    'Alpha two',
    'Alpha answer 2',
  ]);
  assertTranscript(harness, ['Alpha one', 'Thinking alpha', 'Alpha answer 1', 'Alpha two', 'Alpha answer 2']);

  harness.elements.newChatBtn.click();
  await sendPrompt(harness, 'Beta one');
  assertRequest(requests[2], {
    model: 'grok-latest-new',
    absentConversation: true,
    absentParent: true,
  });
  assertNewConversationCount(requests, 2);
  assertSession(sessions(store), 'conv-beta', 'resp-beta-1', 'Beta one', ['Beta one', 'Beta answer 1']);
  assertTranscript(harness, ['Beta one', 'Beta answer 1']);

  clickChatByConversation(harness, 'conv-alpha');
  assertTranscript(harness, ['Alpha one', 'Thinking alpha', 'Alpha answer 1', 'Alpha two', 'Alpha answer 2']);
  await sendPrompt(harness, 'Alpha three');
  assertRequest(requests[3], {
    model: 'grok-latest',
    conversationId: 'conv-alpha',
    parentResponseId: 'resp-alpha-2',
  });
  assertNewConversationCount(requests, 2);
  assertSession(sessions(store), 'conv-alpha', 'resp-alpha-3', 'Alpha one', [
    'Alpha one',
    'Alpha answer 1',
    'Alpha two',
    'Alpha answer 2',
    'Alpha three',
    'Alpha answer 3',
  ]);
  assertTranscript(harness, [
    'Alpha one',
    'Thinking alpha',
    'Alpha answer 1',
    'Alpha two',
    'Alpha answer 2',
    'Alpha three',
    'Alpha answer 3',
  ]);

  clickChatByConversation(harness, 'conv-beta');
  assertTranscript(harness, ['Beta one', 'Beta answer 1']);

  const reloaded = createHarness(store, requests);
  const persisted = sessions(store);
  assertSession(persisted, 'conv-alpha', 'resp-alpha-3', 'Alpha one', [
    'Alpha one',
    'Alpha answer 1',
    'Alpha two',
    'Alpha answer 2',
    'Alpha three',
    'Alpha answer 3',
  ]);
  assertSession(persisted, 'conv-beta', 'resp-beta-1', 'Beta one', ['Beta one', 'Beta answer 1']);
  if (reloaded.chatButtons().length !== 2) {
    throw new Error(`Expected two persisted chat buttons after reload, got ${reloaded.chatButtons().length}`);
  }
  clickChatByConversation(reloaded, 'conv-alpha');
  assertTranscript(reloaded, [
    'Alpha one',
    'Thinking alpha',
    'Alpha answer 1',
    'Alpha two',
    'Alpha answer 2',
    'Alpha three',
    'Alpha answer 3',
  ]);
  clickChatByConversation(reloaded, 'conv-beta');
  assertTranscript(reloaded, ['Beta one', 'Beta answer 1']);

  const missingMetadataStore: Record<string, string> = {};
  const missingMetadataRequests: any[] = [];
  const missingMetadataHarness = createHarness(missingMetadataStore, missingMetadataRequests, [
    { text: 'No ids answer' },
  ]);
  await sendPromptExpectStatus(missingMetadataHarness, 'No ids first', 'Warning');
  assertRequest(missingMetadataRequests[0], {
    model: 'grok-latest-new',
    absentConversation: true,
    absentParent: true,
  });
  if (missingMetadataRequests.length !== 1) {
    throw new Error(`Expected one first-response request, got ${JSON.stringify(missingMetadataRequests)}`);
  }
  assertMissingMetadataSession(sessions(missingMetadataStore), 'No ids first', [
    'No ids first',
    `No ids answer\n\n${MISSING_METADATA_WARNING}`,
  ]);
  assertTranscript(missingMetadataHarness, ['No ids first', 'No ids answer', MISSING_METADATA_WARNING]);

  await sendPromptExpectStatus(missingMetadataHarness, 'Second should block', 'Error');
  if (missingMetadataRequests.length !== 1) {
    throw new Error(`Expected missing metadata follow-up to avoid fetch, got ${JSON.stringify(missingMetadataRequests)}`);
  }
  assertTranscript(missingMetadataHarness, [
    'No ids first',
    'No ids answer',
    MISSING_METADATA_WARNING,
    'Second should block',
    'Error: Cannot continue this chat because it is missing Grok conversation metadata.',
  ]);

  const brokenStore: Record<string, string> = {};
  brokenStore['grok-chat-sessions'] = JSON.stringify([
    {
      id: 'broken-chat',
      title: 'Broken Chat',
      conversationId: null,
      parentResponseId: null,
      messages: [{ role: 'user', content: 'Existing prompt', createdAt: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);
  const brokenRequests: any[] = [];
  const brokenHarness = createHarness(brokenStore, brokenRequests);
  await sendPromptExpectStatus(brokenHarness, 'Should not fork', 'Error');
  if (brokenRequests.length !== 0) {
    throw new Error(`Expected missing metadata follow-up to avoid fetch, got ${JSON.stringify(brokenRequests)}`);
  }
  assertTranscript(brokenHarness, [
    'Existing prompt',
    'Should not fork',
    'Error: Cannot continue this chat because it is missing Grok conversation metadata.',
  ]);

  const legacyStore: Record<string, string> = {
    'grok-chat-sessions': JSON.stringify([
      {
        id: 'legacy-chat',
        title: 'Legacy Chat',
        conversationId: 'legacy-conv',
        parentResponseId: 'legacy-resp',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]),
  };
  createHarness(legacyStore, []);
  const legacy = sessions(legacyStore)[0];
  if (legacy.conversationId !== 'legacy-conv' || legacy.parentResponseId !== 'legacy-resp') {
    throw new Error(`Expected legacy metadata to be preserved, got ${JSON.stringify(legacy)}`);
  }
  if (!Array.isArray(legacy.messages) || legacy.messages.length !== 0) {
    throw new Error(`Expected legacy transcript to migrate to [], got ${JSON.stringify(legacy)}`);
  }

  console.log(`requests=${JSON.stringify(requests)}`);
  console.log(`sessions=${JSON.stringify(persisted)}`);
  console.log('PASS chat history UI');
}

function createHarness(store: Record<string, string>, requests: any[], queuedResponses: MockChatResponse[] = responses) {
  const html = fs.readFileSync(path.join(process.cwd(), 'web', 'index.html'), 'utf8');
  assertOutputWhitespacePolicy(html);
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
    fetch: mockFetch(requests, queuedResponses),
    JSON,
    localStorage: mockLocalStorage(store),
    Math,
    Object,
    setInterval: () => 0,
    setTimeout,
    String,
    TextDecoder,
    window: {
      confirm: () => true,
    },
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
    'prewarmBtn',
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
  scrollHeight = 0;
  scrollTop = 0;
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
    this.scrollHeight = this.text.length;
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
    this.scrollHeight = this.text.length;
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

function mockFetch(requests: any[], queuedResponses: MockChatResponse[]) {
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
      const response = queuedResponses[requests.length - 1];
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

function sseResponse(response: MockChatResponse) {
  const frames = [];

  if (response.conversationId || response.responseId) {
    frames.push(
      `event: grok-response-metadata\ndata: ${JSON.stringify({
        conversationId: response.conversationId,
        responseId: response.responseId,
      })}`,
    );
  }

  const body = [
    ...frames,
    response.reasoning
      ? `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: response.reasoning }, index: 0, finish_reason: null }],
        })}`
      : '',
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
  await sendPromptExpectStatus(harness, prompt, 'Done');
}

async function sendPromptExpectStatus(harness: ReturnType<typeof createHarness>, prompt: string, status: string) {
  harness.elements.prompt.value = prompt;
  harness.elements.promptForm.dispatchEvent({
    type: 'submit',
    preventDefault() {
    },
  });
  await waitFor(() => harness.elements.status.innerText === status);
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

function assertSession(
  allSessions: any[],
  conversationId: string,
  parentResponseId: string,
  title: string,
  expectedMessages: string[],
) {
  const session = allSessions.find((item) => item.conversationId === conversationId);
  if (!session) {
    throw new Error(`Missing session ${conversationId}: ${JSON.stringify(allSessions)}`);
  }
  if (session.parentResponseId !== parentResponseId || session.title !== title) {
    throw new Error(`Unexpected session ${conversationId}: ${JSON.stringify(session)}`);
  }
  assertMessages(session, expectedMessages);
}

function assertMissingMetadataSession(allSessions: any[], title: string, expectedMessages: string[]) {
  const session = allSessions.find((item) => item.title === title);
  if (!session) {
    throw new Error(`Missing session titled ${title}: ${JSON.stringify(allSessions)}`);
  }
  if (session.conversationId !== null || session.parentResponseId !== null) {
    throw new Error(`Expected missing metadata session to keep null ids, got ${JSON.stringify(session)}`);
  }
  assertMessages(session, expectedMessages);
}

function assertMessages(session: any, expectedContents: string[]) {
  const actual = Array.isArray(session.messages) ? session.messages.map((message: any) => message.content) : [];
  if (JSON.stringify(actual) !== JSON.stringify(expectedContents)) {
    throw new Error(`Unexpected messages for ${session.conversationId || session.id}: ${JSON.stringify(actual)}`);
  }
}

function assertTranscript(harness: ReturnType<typeof createHarness>, expectedParts: string[]) {
  const transcript = harness.elements.output.innerText;
  let previousIndex = -1;
  for (const part of expectedParts) {
    const index = transcript.indexOf(part, previousIndex + 1);
    if (index === -1) {
      throw new Error(`Transcript missing "${part}" in "${transcript}"`);
    }
    previousIndex = index;
  }
}

function assertNewConversationCount(requests: any[], expected: number) {
  const actual = requests.filter((request) => request.model === 'grok-latest-new').length;
  if (actual !== expected) {
    throw new Error(`Expected ${expected} new-conversation requests, got ${actual}: ${JSON.stringify(requests)}`);
  }
}

function assertOutputWhitespacePolicy(html: string) {
  const outputMatch = html.match(/<div id="output" class="([^"]*)"/);
  if (!outputMatch) {
    throw new Error('Could not find #output class list');
  }
  if (outputMatch[1].split(/\s+/).includes('whitespace-pre-wrap')) {
    throw new Error('#output must not preserve template indentation whitespace');
  }
  if (!html.includes('class="text-zinc-100 whitespace-pre-wrap"')) {
    throw new Error('Message content must preserve intentional message newlines');
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
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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
