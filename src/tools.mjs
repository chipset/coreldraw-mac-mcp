import vm from 'node:vm';
import { documentProperty, documentTools, documentRuntime, documentScript, json } from './document.mjs';
import { editorTools, buildEditorOperation } from './editor.mjs';
import { workflowTools, buildWorkflowOperation } from './workflows.mjs';
import { fileTools, buildFileOperation } from './files.mjs';
import { objectOperationTools, buildObjectOperation } from './object-operations.mjs';
import { pageTools, buildPageOperation } from './pages.mjs';
import { inspectionTools, buildInspectionOperation } from './inspection.mjs';

const coordinate = { type: 'number', minimum: -1000000, maximum: 1000000 };
const dimension = { type: 'number', exclusiveMinimum: 0, maximum: 1000000 };
const position = { x: coordinate, y: coordinate };
const bounds = { ...position, width: dimension, height: dimension };
const makeTool = (name, description, properties = {}, required = [], readOnly = false) => ({
  name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false },
});

export const tools = [
  makeTool('coreldraw_status', 'Inspect installed/running CorelDRAW, Accessibility permission, and desktop session readiness. Does not launch CorelDRAW or change its UI.', {}, [], true),
  ...documentTools,
  makeTool('coreldraw_inspect_document', 'Read bounded document metadata, page size, units and object counts. An omitted selector reads the active document.', { document: documentProperty }, [], true),
  makeTool('coreldraw_create_document', 'Create a new named CorelDRAW document with a single page measured in millimeters (Corel unit enum 3). Returns its selector.', {
    name: { type: 'string', minLength: 1, maxLength: 200 }, width: dimension, height: dimension,
  }, ['name', 'width', 'height']),
  makeTool('coreldraw_create_rectangle', 'Create a rectangle on the target document active layer. x/y are lower-left coordinates in document units.', { document: documentProperty, ...bounds }, ['x', 'y', 'width', 'height']),
  makeTool('coreldraw_create_ellipse', 'Create an ellipse on the target document active layer. x/y are lower-left bounds in document units.', { document: documentProperty, ...bounds }, ['x', 'y', 'width', 'height']),
  makeTool('coreldraw_create_text', 'Create artistic text on the target document active layer at x/y in document units.', {
    document: documentProperty, ...position, text: { type: 'string', minLength: 1, maxLength: 10000 },
  }, ['x', 'y', 'text']),
  makeTool('coreldraw_run_javascript', 'Run trusted local JavaScript inside CorelDRAW with host. code is a function body returning JSON. Full native escape hatch: can modify any document or save paths; structured tool target/undo restrictions do not apply. No automatic retries after timeout.', {
    code: { type: 'string', minLength: 1, maxLength: 100000 },
  }, ['code']),
  ...[...editorTools, ...fileTools, ...workflowTools, ...objectOperationTools, ...pageTools, ...inspectionTools].map(tool => ({...tool,inputSchema:{...tool.inputSchema,properties:{document:documentProperty,...tool.inputSchema.properties}}})),
];

export function validateSchema(rule, value, key = 'arguments') {
  if (rule.anyOf) {
    let matched = false;
    for (const variant of rule.anyOf) { try { validateSchema(variant, value, key); matched = true; break; } catch {} }
    if (!matched) throw new Error(`${key} does not match an allowed schema`);
  }
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (rule.type && (rule.type === 'integer' ? !Number.isInteger(value) : type !== rule.type) || type === 'number' && !Number.isFinite(value)) throw new Error(`${key} must be a finite ${rule.type || 'number'}`);
  if (rule.enum && !rule.enum.includes(value)) throw new Error(`${key} must be one of ${rule.enum.join(', ')}`);
  if (rule.const !== undefined && value !== rule.const) throw new Error(`${key} has an unsupported value`);
  if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum || rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum || rule.exclusiveMaximum !== undefined && value >= rule.exclusiveMaximum) throw new Error(`${key} is outside the supported range`);
  if (type === 'string') {
    if (rule.minLength !== undefined && value.length < rule.minLength || rule.maxLength !== undefined && value.length > rule.maxLength) throw new Error(`${key} has an invalid length`);
    if (rule.pattern && !(new RegExp(rule.pattern)).test(value)) throw new Error(`${key} has an invalid format`);
  }
  if (type === 'number' && rule.multipleOf && Math.abs(value / rule.multipleOf - Math.round(value / rule.multipleOf)) > 1e-8) throw new Error(`${key} must be a multiple of ${rule.multipleOf}`);
  if (rule.type === 'integer' && (!Number.isInteger(value))) throw new Error(`${key} must be an integer`);
  if (type === 'array') {
    if (rule.minItems !== undefined && value.length < rule.minItems || rule.maxItems !== undefined && value.length > rule.maxItems) throw new Error(`${key} has an invalid item count`);
    if (rule.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) throw new Error(`${key} contains duplicate items`);
    value.forEach((item, i) => validateSchema(rule.items || {}, item, `${key}[${i}]`));
  }
  if (type === 'object') {
    for (const required of rule.required || []) if (!Object.hasOwn(value, required)) throw new Error(`Missing argument: ${key}.${required}`);
    for (const [property, item] of Object.entries(value)) {
      if (rule.properties && Object.hasOwn(rule.properties, property)) validateSchema(rule.properties[property], item, `${key}.${property}`);
      else if (rule.additionalProperties === false) throw new Error(`Unknown argument: ${key}.${property}`);
      else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') validateSchema(rule.additionalProperties, item, `${key}.${property}`);
    }
  }
}

export async function buildOperation(name, args = {}) {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  validateSchema(tool.inputSchema, args);
  switch (name) {
    case 'coreldraw_status': return { status: true };
    case 'coreldraw_list_documents': return {code: documentRuntime + `var out=[];if(host.Documents.Count>100)throw new Error('Document count exceeds 100');for(var i=1;i<=host.Documents.Count;i++)out.push(describeDocument(host.Documents.Item(i)));return {documentCount:host.Documents.Count,documents:out};`};
    case 'coreldraw_inspect_document': return { code: !args.document ? documentRuntime + `if(host.Documents.Count<1)return {documentCount:0,activeDocument:null};return {documentCount:host.Documents.Count,activeDocument:describeDocument(host.ActiveDocument)};` : documentScript(args, 'return {documentCount:host.Documents.Count,document:describeDocument(doc)};') };
    case 'coreldraw_create_document': return { code: documentRuntime + `
      var options=host.CreateStructCreateOptions();options.Name=${json(args.name)};
      var doc=host.CreateDocumentEx(options);doc.Unit=3;doc.ActivePage.SetSize(${args.width},${args.height});
      return {document:describeDocument(doc),name:doc.Name,unit:doc.Unit,width:doc.ActivePage.SizeWidth,height:doc.ActivePage.SizeHeight};` };
    case 'coreldraw_create_rectangle': return {code:documentScript(args,`var shape=layer.CreateRectangle2(args.x,args.y,args.width,args.height);return describeShape(shape);`,{mutates:true,label:'MCP rectangle'})};
    case 'coreldraw_create_ellipse': return {code:documentScript(args,`var shape=layer.CreateEllipse(args.x,args.y+args.height,args.x+args.width,args.y);return describeShape(shape);`,{mutates:true,label:'MCP ellipse'})};
    case 'coreldraw_create_text': return {code:documentScript(args,`var shape=layer.CreateArtisticText(args.x,args.y,args.text);return describeShape(shape);`,{mutates:true,label:'MCP text'})};
    case 'coreldraw_run_javascript': {
      try { new vm.Script(`(function(){\n${args.code}\n})`); }
      catch (error) { throw new Error(`Invalid JavaScript: ${error.message}`); }
      return { code: args.code };
    }
  }
  let operation = buildEditorOperation(name,args) || buildWorkflowOperation(name,args) || buildObjectOperation(name,args) || buildPageOperation(name,args) || buildInspectionOperation(name,args);
  if (!operation) operation = await buildFileOperation(name,args);
  if (!operation) throw new Error(`Tool is not implemented: ${name}`);
  return {...operation,code:documentScript(args,operation.body,{mutates:operation.mutates,label:operation.label})};
}
