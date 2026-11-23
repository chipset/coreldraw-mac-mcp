#!/usr/bin/env node
import { CorelBridge } from './bridge.mjs';
import { buildOperation, tools } from './tools.mjs';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

const versions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const maxBytes = 1024 * 1024;
let initialized = false;
let buffer = Buffer.alloc(0);
const requests = new Map();
const bridge = new CorelBridge();
const resources = [
  { uri: 'coreldraw://reference', name: 'CorelDRAW Mac reference', mimeType: 'text/plain', description: 'Target selection, native limits and safe execution/recovery.' },
  { uri: 'coreldraw://tools', name: 'CorelDRAW tool catalog', mimeType: 'application/json', description: 'Current tools and complete input schemas.' },
];
const reference = `CorelDRAW 2021 Mac local Swift Accessibility bridge.
List documents first and pass document ids (path:... or name:...). Multiple open documents require explicit mutation targets; save_as always requires a target.
Object tools use numeric StaticID values returned by list_objects. IDs last only for native object lifetimes; refresh after reopen or conversion.
Logical shape labels may exist only in JSON manifests on this Mac; native shape Name writes can be silently ignored. Text size uses points; geometry uses document units.
Read tools do not edit artwork. Native calls require the running licensed app, unlocked desktop, Accessibility access and the Scripts inspector. Existing unrelated dialogs are left open.
Edits use named Undo groups, not transactions. Check isError, partial and completed results. Never automatically retry an uncertain mutation. Recovery requires inspecting artwork and quitting CorelDRAW before the helper recover command.
Save/export refuse existing outputs. Raw run_javascript is trusted unrestricted Corel code; these structured restrictions do not apply to it.
Production checks use pass/fail/unknown: incomplete or unavailable evidence is never a verified pass. Other Corel versions and all option combinations remain unverified.`;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const failure = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const success = (id, result) => send({ jsonrpc: '2.0', id, result });

async function dispatch(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (Object.hasOwn(message, 'id') && typeof message.id !== 'number' && typeof message.id !== 'string') ||
      (typeof message.id === 'number' && !Number.isFinite(message.id))) {
    failure(null, -32600, 'Invalid JSON-RPC request'); return;
  }
  const { id, method, params = {} } = message;
  if (id === undefined) {
    if (method === 'notifications/cancelled' && params && typeof params === 'object') requests.get(params.requestId)?.abort();
    return;
  }
  if (method === 'ping') { success(id, {}); return; }
  if (!params || typeof params !== 'object' || Array.isArray(params)) { failure(id, -32602, 'params must be an object'); return; }
  if (method === 'initialize') {
    if (initialized) { failure(id, -32600, 'Session is already initialized'); return; }
    initialized = true;
    success(id, {
      protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions.at(-1),
      capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
      serverInfo: { name: 'coreldraw-mcp-macos', version: '0.3.0' },
      instructions: 'Local CorelDRAW Mac JavaScript bridge. Requires running CorelDRAW, unlocked desktop, English UI, and Accessibility permission. List documents first and pass the returned document id; edits require explicit targeting when multiple documents are open and saves always do. Ids change after Save As/rename. Structured edits use Undo command groups, not rollback; batches report partial failures. UI execution is serialized. Cancellation after dispatch keeps observing until result or deadline; inspect before retrying a timeout. Native JavaScript uses host, not Node/browser APIs. The raw JavaScript tool retains unrestricted native behavior.',
    });
    return;
  }
  if (!initialized) { failure(id, -32002, 'Initialize the MCP session first'); return; }
  if (method === 'tools/list') { success(id, { tools }); return; }
  if (method === 'resources/list') { success(id, { resources }); return; }
  if (method === 'resources/read') {
    const resource = resources.find(item => item.uri === params.uri);
    if (!resource) { failure(id, -32602, 'Unknown CorelDRAW resource'); return; }
    success(id, { contents: [{ uri: resource.uri, mimeType: resource.mimeType,
      text: resource.uri === 'coreldraw://tools' ? JSON.stringify(tools) : reference }] });
    return;
  }
  if (method !== 'tools/call') { failure(id, -32601, `Method not found: ${method}`); return; }
  if (typeof params.name !== 'string') { failure(id, -32602, 'tools/call requires a tool name'); return; }
  if (requests.has(id)) { failure(id, -32600, 'Duplicate active request id'); return; }
  const controller = new AbortController();
  requests.set(id, controller);
  try {
    const operation = await buildOperation(params.name, Object.hasOwn(params, 'arguments') ? params.arguments : {});
    const result = operation.status ? await bridge.status(controller.signal)
      : await bridge.run(operation.code, { ...operation, signal: controller.signal });
    const content = [{ type: 'text', text: JSON.stringify(result) }];
    if (operation.preview && result.previewPath) {
      const file = await open(result.previewPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Preview exceeds the 16 MiB inline limit; exported file remains available');
        const bytes = await file.readFile();
        if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Preview is not a verified PNG');
        content.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
      } finally { await file.close(); }
    }
    success(id, { content, isError: result?.partial === true || result?.status === 'failed' });
  } catch (error) {
    success(id, { content: [{ type: 'text', text: String(error.message || error) }], isError: true });
  } finally { requests.delete(id); }
}

function parse(line) {
  if (!line.length) return;
  let message;
  try { message = JSON.parse(line.toString('utf8')); }
  catch { failure(null, -32700, 'Invalid JSON'); return; }
  dispatch(message).catch(error => { process.stderr.write(String(error.stack || error) + '\n'); failure(message?.id ?? null, -32603, 'Internal server error'); });
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  let pos;
  while ((pos = buffer.indexOf(10)) !== -1) {
    if (pos > maxBytes) { failure(null, -32600, 'Message exceeds 1 MiB limit'); process.exitCode = 1; process.stdin.destroy(); return; }
    const line = buffer.subarray(0, pos);
    buffer = buffer.subarray(pos + 1);
    parse(line);
  }
  if (buffer.length > maxBytes) { failure(null, -32600, 'Message exceeds 1 MiB limit'); process.exitCode = 1; process.stdin.destroy(); }
});
process.stdin.on('end', () => { if (buffer.length) parse(buffer); });
process.stdin.on('error', error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; });
process.stdout.on('error', () => { for (const controller of requests.values()) controller.abort(); process.exit(0); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { for (const controller of requests.values()) controller.abort(); process.exit(0); });
