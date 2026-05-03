import * as http from 'node:http';

async function testProxy() {
  console.log("Sending OpenAI format request to local proxy...");
  
  const response = await fetch('http://localhost:11434/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer sk-fake-key'
    },
    body: JSON.stringify({
      model: "grok-latest",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Tell me a very short joke about a programmer." }
      ],
      stream: true
    })
  });

  if (!response.ok) {
    console.error(`Error from proxy: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.error(text);
    return;
  }

  console.log("--- SSE STREAM START ---");
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    process.stdout.write(chunk);
  }
  console.log("--- SSE STREAM END ---");
}

testProxy();