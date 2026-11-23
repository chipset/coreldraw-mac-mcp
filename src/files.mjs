import { lstat, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, isAbsolute } from 'node:path';

const filePath = { type: 'string', minLength: 1, maxLength: 4096 };
const dpi = { type: 'integer', minimum: 36, maximum: 1200 };
const pixels = { type: 'integer', minimum: 1, maximum: 16384 };
const raster = { dpi, width: pixels, height: pixels, transparent: { type: 'boolean' } };
const tool = (name, description, properties, required, readOnly = false) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: false, openWorldHint: false },
});

export const fileTools = [
  tool('coreldraw_save_as', 'Save an explicitly selected document to a NEW absolute .cdr path. Existing files are refused. Verifies source identity, shape count, native association and file signature; parent directory must exist.', {
    document: { type: 'string', minLength: 1, maxLength: 4096 }, path: filePath,
  }, ['document', 'path']),
  tool('coreldraw_import_file', 'Import a local CDR, PDF, SVG, PNG or JPEG onto the selected document active layer. Requires newly created selected shape IDs; silent native import failures return an error.', { path: filePath }, ['path']),
  tool('coreldraw_export_file', 'Export to a NEW PNG, PDF or SVG path. PNG/SVG export the current page; PDF uses the selected document PDF settings. PNG dimensions are pixels; omitted dimensions use native defaults. File signatures are checked before no-overwrite publication.', {
    path: filePath, format: { type: 'string', enum: ['png', 'pdf', 'svg'] }, ...raster,
  }, ['path', 'format']),
  tool('coreldraw_preview', 'Export a current-page PNG preview to a NEW absolute .png path and return it as an MCP image. Parent directory must exist; native raster export support is required.', { path: filePath, ...raster }, ['path']),
];

async function newOutput(path, extension) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Output path must be absolute');
  if (path.includes('\0')) throw new Error('Output path contains a null byte');
  if (extname(path).toLowerCase() !== '.' + extension) throw new Error(`Output extension must be .${extension}`);
  try { await lstat(path); throw new Error('Output target already exists; overwriting is disabled'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { if (!(await stat(dirname(path))).isDirectory()) throw new Error(); }
  catch { throw new Error('Output parent directory must exist'); }
}

export async function buildFileOperation(name, args = {}) {
  if (!fileTools.some(item => item.name === name)) return null;
  if (name === 'coreldraw_save_as') {
    if (typeof args.document !== 'string' || !args.document.trim()) throw new Error('Save requires an explicit document selector');
    await newOutput(args.path, 'cdr');
    return { mutates: true, label: 'Save document as', savePath: args.path, expectedDocument: args.document, body: `
      var sourceDoc = doc;
      var sourceDocument = describeDocument(doc);
      var shapeCountBefore = page.Shapes.Count;
      var previousFullFileName = String(doc.FullFileName || '');
      try {
        var saveOptions = host.CreateStructSaveAsOptions();
        saveOptions.Overwrite = false;
        doc.SaveAs(args.path, saveOptions);
      } catch (error) { throw new Error('SaveAs unsupported or failed: ' + String(error.message || error)); }
      if (doc !== sourceDoc || page.Shapes.Count !== shapeCountBefore) throw new Error('Save not verified: source document or shape count changed');
      return {path: args.path, sourceDocument: sourceDocument, document: describeDocument(doc), fullFileName: String(doc.FullFileName || ''), previousFullFileName: previousFullFileName, shapeCountBefore: shapeCountBefore, shapeCountAfter: page.Shapes.Count};
    ` };
  }
  if (name === 'coreldraw_import_file') {
    if (typeof args.path !== 'string' || !isAbsolute(args.path) || args.path.includes('\0')) throw new Error('Import path must be an absolute local file path');
    if (!/\.(cdr|pdf|svg|png|jpe?g)$/i.test(args.path)) throw new Error('Import supports CDR, PDF, SVG, PNG and JPEG files');
    const info = await lstat(args.path);
    if (!info.isFile() || info.size < 1) throw new Error('Import source must be a nonempty regular file; symbolic links are not accepted');
    await access(args.path, constants.R_OK);
    const importFilter = { '.cdr': 1795, '.pdf': 1333, '.svg': 1345, '.png': 802, '.jpg': 774, '.jpeg': 774 }[extname(args.path).toLowerCase()];
    return { mutates: true, label: 'Import file', body: `
      var beforeIds = {}, beforeCount = page.Shapes.Count;
      for (var i = 1; i <= beforeCount; i++) beforeIds[String(page.Shapes.Item(i).StaticID)] = true;
      try {
        var importOptions = host.CreateStructImportOptions();
        if (!importOptions) throw new Error('CreateStructImportOptions returned no options');
        importOptions.LinkBitmapExternally = false;
        layer.Import(args.path, ${importFilter}, importOptions);
      }
      catch (error) { throw new Error('Layer.Import unsupported or failed: ' + String(error.message || error)); }
      var selected = doc.Selection().Shapes;
      if (!selected || typeof selected.Count !== 'number') throw new Error('Import not verified: imported selection is unavailable');
      var imported = [], importedIds = {};
      for (var j = 1; j <= selected.Count; j++) {
        var importedShape = selected.Item(j), importedId = String(importedShape.StaticID);
        if (beforeIds[importedId] || importedIds[importedId]) throw new Error('Import not verified: selection includes an existing or duplicate object');
        importedIds[importedId] = true; imported.push(describeShape(importedShape));
      }
      var delta = page.Shapes.Count - beforeCount;
      if (!imported.length || delta !== imported.length) throw new Error('Import created no new verified selected objects or object count differs; inspect document before retrying');
      return {path: args.path, importedCount: imported.length, shapeCountBefore: beforeCount, shapeCountAfter: page.Shapes.Count, shapes: imported};
    ` };
  }
  const format = name === 'coreldraw_preview' ? 'png' : args.format;
  if (!['png', 'pdf', 'svg'].includes(format)) throw new Error('Export format must be png, pdf or svg');
  if (format !== 'png' && Object.keys(raster).some(key => args[key] !== undefined)) throw new Error('Raster options are supported only for PNG export');
  await newOutput(args.path, format);
  // Mac JavaScript's native dispatcher silently ignores calls with omitted
  // object arguments. Use concrete structures for both Export overloads.
  const exportOptions = `
        var exportOptions = host.CreateStructExportOptions();
        var paletteOptions = host.CreateStructPaletteOptions();
        if (!exportOptions || !paletteOptions) throw new Error('Export option structures are unavailable');
        exportOptions.Overwrite = false;
  `;
  const method = format === 'png' ? `
      try {
        ${exportOptions}
        exportOptions.ImageType = 4;
        exportOptions.ResolutionX = args.dpi || 144;
        exportOptions.ResolutionY = args.dpi || 144;
        exportOptions.AntiAliasingType = 1;
        exportOptions.Transparent = args.transparent === true;
        if (args.width !== undefined) exportOptions.SizeX = args.width;
        if (args.height !== undefined) exportOptions.SizeY = args.height;
        doc.Export(__corelOutputPath, 802, 1, exportOptions, paletteOptions);
      } catch (error) { throw new Error('PNG export unsupported or failed: ' + String(error.message || error)); }
    ` : format === 'pdf' ? `
      try { doc.PublishToPDF(__corelOutputPath); }
      catch (error) { throw new Error('PDF export unsupported or failed: ' + String(error.message || error)); }
    ` : `
      try {
        ${exportOptions}
        doc.Export(__corelOutputPath, 1345, 1, exportOptions, paletteOptions);
      }
      catch (error) { throw new Error('SVG export unsupported or failed: ' + String(error.message || error)); }
    `;
  return { mutates: false, label: name === 'coreldraw_preview' ? 'Preview current page' : 'Export current page', exportPath: args.path, format,
    preview: name === 'coreldraw_preview', body: method + `\nreturn {exportedPath: __corelOutputPath, document: describeDocument(doc), format: '${format}'};` };
}
