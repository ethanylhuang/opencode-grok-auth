import type { Plugin, ProviderContext } from '@opencode-ai/plugin';
import type { Model, UserMessage } from '@opencode-ai/sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

export default function grokAuthPlugin(): Plugin {
  return async (input) => {
    return {
      provider: {
        id: 'grok-bridge',
        models: async () => {
          return {
            'grok-latest': {
              id: 'grok-latest',
              name: 'Grok Latest (Browser Bridge)',
              description: 'Grok model via browser session bridge',
            } as any,
          };
        },
      },
      'chat.headers': async (inputContext, output) => {
        if (inputContext.model.id === 'grok-latest') {
          output.headers['X-Grok-Bridge-Id'] = 'opencode-plugin';
        }
      },
    };
  };
}
