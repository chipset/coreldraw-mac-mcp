// Usage: node examples/client.mjs coreldraw_status '{}'
// This calls the real local MCP server. Drawing tools edit the selected document.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
let sequence = 0;
const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const message = JSON.parse(line);
  const receiver = pending.get(message.id);
  if (!receiver) return;
  pending.delete(message.id);
  message.error ? receiver.reject(new Error(message.error.message)) : receiver.resolve(message.result);
});
child.on('exit', code => {
  for (const receiver of pending.values()) receiver.reject(new Error(`Server exited ${code}`));
});
function call(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
try {
  await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-example', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const result = await call('tools/call', { name: process.argv[2] || 'coreldraw_status', arguments: JSON.parse(process.argv[3] || '{}') });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.isError) process.exitCode = 1;
} finally {
  child.stdin.end();
  lines.close();
}
