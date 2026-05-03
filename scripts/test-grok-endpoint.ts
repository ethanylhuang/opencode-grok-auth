import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

// Read cookie from ~/.grok_cookie
const cookiePath = path.join(os.homedir(), '.grok_cookie');
let cookie = '';
try {
  cookie = fs.readFileSync(cookiePath, 'utf8').trim();
} catch (e) {
  console.error(`Error reading cookie from ${cookiePath}:`, e.message);
  process.exit(1);
}

const prompt = process.argv[2];
if (!prompt) {
  console.error('Usage: npm run test-endpoint "Your prompt here"');
  process.exit(1);
}

async function main() {
  const convId = randomUUID();
  const url = `https://grok.com/rest/app-chat/conversations/cc930533-47d2-4ac1-87cc-a98a4f73e596/responses`;
  
  const payload = {
    "message": prompt,
    "parentResponseId": "378c9b92-e296-43a1-b217-cc03ff8a5ad3",
    "disableSearch": false,
    "enableImageGeneration": true,
    "imageAttachments": [],
    "returnImageBytes": false,
    "returnRawGrokInXaiRequest": false,
    "fileAttachments": [],
    "enableImageStreaming": true,
    "imageGenerationCount": 2,
    "forceConcise": false,
    "enableSideBySide": true,
    "sendFinalMetadata": true,
    "metadata": {
      "request_metadata": {}
    },
    "disableTextFollowUps": false,
    "isFromGrokFiles": false,
    "disableMemory": false,
    "forceSideBySide": false,
    "isAsyncChat": false,
    "skipCancelCurrentInflightRequests": false,
    "isRegenRequest": false,
    "disableSelfHarmShortCircuit": false,
    "collectionIds": [],
    "connectors": [],
    "deviceEnvInfo": {
      "darkModeEnabled": true,
      "devicePixelRatio": 2,
      "screenWidth": 2560,
      "screenHeight": 1440,
      "viewportWidth": 1774,
      "viewportHeight": 1323
    },
    "modeId": "grok-420-computer-use-sa"
  };

  console.log(`Sending prompt: "${prompt}"`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'Origin': 'https://grok.com',
        'Referer': `https://grok.com/c/cc930533-47d2-4ac1-87cc-a98a4f73e596?rid=378c9b92-e296-43a1-b217-cc03ff8a5ad3`,
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'baggage': 'sentry-environment=production,sentry-release=14649bbc2d47e7a322f3ba56be2c8c3f9d9e6cfd,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c,sentry-trace_id=21a4f14e4bb357727a0a882035c7a208,sentry-org_id=4508179396558848,sentry-sampled=false,sentry-sample_rand=0.650287140954291,sentry-sample_rate=0',
        'priority': 'u=1, i',
        'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'sentry-trace': '21a4f14e4bb357727a0a882035c7a208-b904fa86b22c2e1d-0',
        'traceparent': '00-35abc85a2ee659d81659cf623f068a7c-fe7c5725193656a6-00',
        'x-statsig-id': '1C0eSK7pvDEVZPGjbvqSGFt/wZ1s2ex36L92x5jvKQkRmUYvKpjM5fStB030hRY7WGu7c9GKecgCzdYy4oyBIkF75igp1w',
        'x-xai-request-id': 'c2aeb103-2607-4062-af98-ffa3c1315da0',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`HTTP Error: ${response.status} ${response.statusText}`);
      const text = await response.text();
      console.error(text);
      process.exit(1);
    }

    if (!response.body) {
      console.error('No response body stream available');
      process.exit(1);
    }

    console.log('--- RESPONSE ---');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf8');

    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      
      // Parse concatenated JSON like {"result":...}{"result":...}
      // This is a naive split based on actual undocumented format
      let braceCount = 0;
      let startIndex = -1;
      
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === '{') {
          if (braceCount === 0) startIndex = i;
          braceCount++;
        } else if (buffer[i] === '}') {
          braceCount--;
          if (braceCount === 0 && startIndex !== -1) {
            const jsonStr = buffer.substring(startIndex, i + 1);
            try {
              const obj = JSON.parse(jsonStr);
              // Extract the token, the actual field name depends on the API
              if (obj.result && obj.result.token !== undefined) {
                  if (!obj.result.isThinking) {
                     process.stdout.write(obj.result.token);
                  }
              } else if (obj.token) {
                  process.stdout.write(obj.token);
              }
            } catch (err) {
              // Not valid JSON yet or parsing error, skip
            }
            // Remove the parsed part from buffer
            buffer = buffer.substring(i + 1);
            i = -1; // Reset loop index for new buffer
            startIndex = -1;
          }
        }
      }
    }
    console.log('\n--- END ---');
  } catch (error) {
    console.error('Fetch error:', error);
  }
}

main();
