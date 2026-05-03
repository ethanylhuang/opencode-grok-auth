import * as http from 'node:http';
import { performance } from 'node:perf_hooks';

async function testLatency() {
  const url = 'http://127.0.0.1:11434/v1/chat/completions';
  const payload = JSON.stringify({
    model: 'grok-latest',
    messages: [{ role: 'user', content: 'Say one word.' }],
    stream: true
  });

  console.log('Testing Grok Bridge Latency...');
  
  const start = performance.now();
  let firstTokenTime = 0;
  let end = 0;

  const request = http.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (res) => {
    res.on('data', () => {
      if (firstTokenTime === 0) {
        firstTokenTime = performance.now();
      }
    });

    res.on('end', () => {
      end = performance.now();
      const ttft = firstTokenTime - start;
      const total = end - start;
      
      console.log(`\nResults:`);
      console.log(`- Time to First Token (TTFT): ${ttft.toFixed(2)}ms`);
      console.log(`- Total Response Time: ${total.toFixed(2)}ms`);
      process.exit(0);
    });
  });

  request.on('error', (e) => {
    console.error('Request error:', e);
    process.exit(1);
  });

  request.write(payload);
  request.end();
}

testLatency();
