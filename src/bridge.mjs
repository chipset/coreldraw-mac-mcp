import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, lstat, open, realpath, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const defaultHelper = fileURLToPath(new URL('../native/coreldraw-bridge', import.meta.url));

export function wrapScript(code, prefix) {
  return `(function () {\n  var envelope;\n  try {\n    var value = (function () {\n${code}\n    })();\n    envelope = {ok: true, result: value === undefined ? null : value};\n    var encoded = JSON.stringify(envelope);\n  } catch (error) {\n    var encoded = JSON.stringify({ok: false, error: String(error && error.message || error)});\n  }\n  alert(${JSON.stringify(prefix)} + encoded);\n})();\n`;
}

async function samePath(actual, expected) {
  if (typeof actual !== 'string' || !isAbsolute(actual)) return false;
  if (resolve(actual) === resolve(expected)) return true;
  try { return await realpath(actual) === await realpath(expected); }
  catch { return false; }
}

async function matchesDocument(document, selector) {
  if (!document || typeof selector !== 'string') return false;
  if (selector === document.id || selector === document.name) return true;
  if (selector.startsWith('name:')) return selector.slice(5) === document.name;
  const path = selector.startsWith('path:') ? selector.slice(5) : selector;
  return await samePath(document.fullFileName, path);
}

async function verifySave(path, result, expectedDocument) {
  if (expectedDocument !== undefined) {
    if (!await matchesDocument(result?.sourceDocument, expectedDocument)) throw new Error('Save not verified: source document does not match the requested document selector');
    if (!Number.isInteger(result?.shapeCountBefore) || result.shapeCountBefore < 0 || result.shapeCountBefore !== result.shapeCountAfter) throw new Error('Save not verified: source document shape count changed or is missing');
    if (!await samePath(result?.document?.fullFileName, path)) throw new Error('Save not verified: returned document identity does not match the target');
  }
  // Mac SaveAs can silently refuse an existing target. A valid header alone
  // cannot distinguish that refusal from a racing writer's Corel document.
  if (await samePath(result?.previousFullFileName, path)) {
    throw new Error('Save not verified: document was already associated with the target before SaveAs');
  }
  if (!await samePath(result?.fullFileName, path)) {
    throw new Error('Save not verified: the active CorelDRAW document is not associated with the requested target');
  }
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size < 12) throw new Error('target is missing, empty, or not a regular Corel document');
    const header = Buffer.alloc(Math.min(info.size, 4096));
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    let fileFormat;
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 11).toString('ascii') === 'CDR') {
      fileFormat = 'riff-cdr';
    } else if (bytes.length >= 30 && bytes.readUInt32LE(0) === 0x04034b50 && bytes.readUInt16LE(8) === 0) {
      const nameLength = bytes.readUInt16LE(26), extraLength = bytes.readUInt16LE(28);
      const content = 30 + nameLength + extraLength;
      const mime = 'application/x-vnd.corel.zcf.draw.document+zip';
      if (bytes.subarray(30, 30 + nameLength).toString('ascii') === 'mimetype'
        && bytes.readUInt32LE(18) === mime.length && bytes.readUInt32LE(22) === mime.length
        && bytes.subarray(content, content + mime.length).toString('ascii') === mime) fileFormat = 'corel-zip';
    }
    if (!fileFormat) throw new Error('target does not have a recognized CorelDRAW document header');
    return { ...result, savedBytes: info.size, fileFormat };
  } catch (error) {
    throw new Error(`Save not verified: ${error.message}`);
  } finally {
    await file?.close();
  }
}

async function verifyExport(path, result, format) {
  if (!await samePath(result?.exportedPath, path)) throw new Error('Export not verified: native output path does not match the requested staging path');
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size < (format === 'svg' ? 6 : 12)) throw new Error('output is missing, empty, or not a regular file');
    const header = Buffer.alloc(Math.min(info.size, 65536));
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (format === 'png') {
      if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR' || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) throw new Error('output has no valid PNG IHDR signature');
      let offset = 8, imageData = false, ended = false, chunks = 0;
      const chunk = Buffer.alloc(8);
      while (offset + 12 <= info.size && ++chunks <= 100000) {
        const read = await file.read(chunk, 0, 8, offset);
        if (read.bytesRead !== 8) break;
        const length = chunk.readUInt32BE(0), type = chunk.toString('ascii', 4, 8);
        if (offset + length + 12 > info.size) break;
        if (type === 'IDAT' && length) imageData = true;
        offset += length + 12;
        if (type === 'IEND') { ended = length === 0 && offset === info.size; break; }
      }
      if (!imageData || !ended) throw new Error('PNG output is incomplete: missing image data or final IEND chunk');
      return { ...result, exportedBytes: info.size, format, pixelWidth: bytes.readUInt32BE(16), pixelHeight: bytes.readUInt32BE(20) };
    }
    if (format === 'pdf') {
      const tail = Buffer.alloc(Math.min(info.size, 1024));
      await file.read(tail, 0, tail.length, info.size - tail.length);
      if (!/^%PDF-[12]\.\d/.test(bytes.toString('ascii', 0, 8)) || !tail.toString('ascii').includes('%%EOF')) throw new Error('output has no PDF header and end marker');
    } else if (format === 'svg') {
      const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
      const root = /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[\s\S]*?>\s*)?<svg(?:\s|\/?>)/i;
      if (!root.test(text)) throw new Error('output has no SVG root signature');
      const tail = Buffer.alloc(Math.min(info.size, 4096));
      await file.read(tail, 0, tail.length, info.size - tail.length);
      if (!/<svg\b[^>]*\/\s*>\s*$/i.test(text) && !/<\/svg\s*>\s*$/i.test(tail.toString('utf8'))) throw new Error('SVG output has no closing root element');
    } else throw new Error('unsupported export format');
    return { ...result, exportedBytes: info.size, format };
  } catch (error) { throw new Error(`Export not verified: ${error.message}`); }
  finally { await file?.close(); }
}

export class CorelBridge {
  constructor({ helper = process.env.CORELDRAW_HELPER || defaultHelper,
    bundleId = process.env.CORELDRAW_BUNDLE_ID || 'com.corel.coreldrawsuite.2021.coreldraw',
    timeoutSeconds = Number(process.env.CORELDRAW_TIMEOUT_SECONDS || 30),
    timeoutGraceMs = 3000, tempRoot = tmpdir() } = {}) {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 120) throw new Error('CORELDRAW_TIMEOUT_SECONDS must be between 0 and 120');
    this.helper = helper; this.bundleId = bundleId; this.timeoutSeconds = timeoutSeconds;
    this.timeoutGraceMs = timeoutGraceMs; this.tempRoot = tempRoot;
    this.queue = Promise.resolve();
  }

  serial(action) {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }

  async invoke(args, signal, execution = false) {
    if (signal?.aborted) throw new Error('Request cancelled before execution');
    return new Promise((resolve, reject) => {
      execFile(this.helper, args, { encoding: 'utf8', maxBuffer: 1024 * 1024,
        // Once dispatched, cancellation cannot roll back native JavaScript. Keep
        // observing the helper so the queue stays held until its terminal result.
        timeout: this.timeoutSeconds * 1000 + this.timeoutGraceMs, signal: execution ? undefined : signal,
      }, (error, stdout, stderr) => {
        if (error?.killed || error?.name === 'AbortError') {
          reject(new Error(execution
            ? 'CorelDRAW request timed out or was cancelled; the script may have already executed. Inspect the document before retrying.'
            : 'CorelDRAW status request timed out or was cancelled.'));
          return;
        }
        if (error?.code === 'ENOENT') { reject(new Error('Native helper is missing. Run ./scripts/build-native.sh before starting the MCP server.')); return; }
        let response;
        try { response = JSON.parse(stdout); }
        catch { reject(new Error(`Native helper returned invalid JSON${stderr?.trim() ? ': ' + stderr.trim().slice(0, 2000) : ''}`)); return; }
        if (!response || typeof response !== 'object' || Array.isArray(response) || typeof response.ok !== 'boolean') { reject(new Error('Native helper returned an invalid response envelope')); return; }
        if (!response.ok) { reject(new Error(String(response.error || 'CorelDRAW operation failed'))); return; }
        if (error) { reject(new Error(`Native helper exited unsuccessfully: ${error.message}`)); return; }
        resolve(response);
      });
    });
  }

  status(signal) {
    return this.serial(async () => {
      const response = await this.invoke(['status', this.bundleId], signal);
      const { ok, ...status } = response;
      return status;
    });
  }

  run(code, { signal, savePath, expectedDocument, exportPath, format, preview = false } = {}) {
    return this.serial(async () => {
      if (signal?.aborted) throw new Error('Request cancelled before execution');
      // Recheck at dispatch because another request may have saved this path while queued.
      if (savePath && exportPath) throw new Error('A request cannot save and export simultaneously');
      if (exportPath && (!isAbsolute(exportPath) || !['png', 'pdf', 'svg'].includes(format))) throw new Error('Export requires an absolute path and supported format');
      if (savePath || exportPath) {
        try { await lstat(savePath || exportPath); throw new Error('Save/export target already exists; overwriting is disabled'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const dir = await mkdtemp(join(this.tempRoot, 'coreldraw-mcp-'));
      const prefix = `CORELDRAW_MCP_${randomUUID()}:`;
      const path = join(dir, `request-${randomUUID()}.js`);
      let exportDir;
      try {
        if (exportPath) exportDir = await mkdtemp(join(dirname(exportPath), '.coreldraw-export-'));
        const stagedPath = exportDir && join(exportDir, `output.${format}`);
        const script = stagedPath ? `var __corelOutputPath = ${JSON.stringify(stagedPath)};\n${code}` : code;
        await writeFile(path, wrapScript(script, prefix), { mode: 0o600 });
        const response = await this.invoke(['run', this.bundleId, path, prefix, String(this.timeoutSeconds)], signal, true);
        if (savePath) return await verifySave(savePath, response.result, expectedDocument);
        if (exportPath) {
          const verified = await verifyExport(stagedPath, response.result, format);
          // link is an atomic no-clobber publication on the same filesystem.
          await link(stagedPath, exportPath);
          const { exportedPath, ...result } = verified;
          return { ...result, path: exportPath, ...(preview ? { previewPath: exportPath } : {}) };
        }
        return response.result ?? null;
      } finally {
        if (exportDir) await rm(exportDir, { recursive: true, force: true });
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}
