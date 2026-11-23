const id = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const ids = { type: 'array', items: id, minItems: 1, maxItems: 200, uniqueItems: true };
const coordinate = { type: 'number', minimum: -1e6, maximum: 1e6 };
function tool(suffix, description, properties, required, readOnly = false) {
  return { name: 'coreldraw_' + suffix, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false } };
}
export const objectOperationTools = [
  tool('duplicate_objects', 'Duplicate explicit StaticIDs without changing originals. dx/dy are document-unit offsets per copy, copies defaults to 1. At most 200 copy records and 10000 copied objects including descendants. Rejects overlapping ancestors/descendants. Reports compact surviving-copy summaries on partial native failure.', { ids, dx: coordinate, dy: coordinate, copies: { type: 'integer', minimum: 1, maximum: 100 } }, ['ids']),
  tool('delete_objects', 'Delete explicit StaticIDs after resolving all targets. Rejects overlapping ancestors/descendants. Partial native failures return completed ids; one Undo group, no rollback.', { ids }, ['ids']),
  tool('convert_to_curves', 'Convert explicit StaticIDs to native curves. All targets resolve before editing. Native conversion of unsupported types may fail; completed objects are retained and reported.', { ids }, ['ids']),
  tool('get_text', 'Read a text object story by StaticID, bounded to limit characters (default 10000, maximum 30000). Includes original length and truncation; bound includes worst-case JSON escaping.', { id, limit: { type: 'integer', minimum: 1, maximum: 30000 } }, ['id'], true),
  tool('set_text', 'Replace whole stories of explicit text StaticIDs, including empty text. Validates every target before editing and verifies readback. Formatting follows Corel text replacement behavior; partial failures report completed objects.', { ids, text: { type: 'string', maxLength: 10000 } }, ['ids', 'text']),
];

// Serialized inside documentScript: no Node globals or native object serialization.
function objectRuntime() {
  function summary(shape) {
    var result={shapeId:shape.StaticID,type:shape.Type,name:String(getShapeName(shape)||'').slice(0,64),
      x:shape.LeftX,y:shape.BottomY,width:shape.SizeWidth,height:shape.SizeHeight};
    if(shape.Type===6&&shape.Text&&shape.Text.Story){var value=String(shape.Text.Story.Text);result.text={text:value.slice(0,64),truncated:value.length>64,length:value.length};}
    return result;
  }
  function textStory(shape) {
    if (shape.Type !== 6 || !shape.Text || !shape.Text.Story) throw new Error('Shape ' + shape.StaticID + ' is not a text object');
    return shape.Text.Story;
  }
  if (operation === 'get_text') {
    var shape = getShape(args.id), text = String(textStory(shape).Text);
    return { shapeId: shape.StaticID, text: text.slice(0, args.limit || 10000), length: text.length, truncated: text.length > (args.limit || 10000) };
  }
  var resolved = [], selected = {}, visited = 0, total = 0;
  for (var i = 0; i < args.ids.length; i++) {
    if (selected[args.ids[i]]) throw new Error('Duplicate shape id');
    selected[args.ids[i]] = true;
    resolved.push(getShape(args.ids[i]));
  }
  function descend(shape, depth) {
    if (depth > 30 || ++visited > 10000) throw new Error('Object traversal exceeds safety bound');
    total++;
    if (shape.Type === 7 && shape.Shapes) for (var j = 1; j <= shape.Shapes.Count; j++) {
      var child = shape.Shapes.Item(j);
      if (selected[child.StaticID]) throw new Error('Overlapping ancestor and descendant ids');
      descend(child, depth + 1);
    }
  }
  for (var i = 0; i < resolved.length; i++) descend(resolved[i], 0);
  if (operation === 'set_text') for (var i = 0; i < resolved.length; i++) textStory(resolved[i]);
  var copies = args.copies || 1;
  if (operation === 'duplicate_objects' && resolved.length * copies > 200) throw new Error('Duplication exceeds 200 copy records');
  if (operation === 'duplicate_objects' && total * copies > 10000) throw new Error('Duplication exceeds 10000 copied objects');
  var result = { partial: false, completed: [] };
  if (operation === 'duplicate_objects') result.copies = [];
  if (operation === 'convert_to_curves' || operation === 'set_text') result.objects = [];
  for (var i = 0; i < resolved.length; i++) {
    var s = resolved[i], sourceId = args.ids[i], copyIndex = 0;
    try {
      if (operation === 'duplicate_objects') {
        for (copyIndex = 1; copyIndex <= copies; copyIndex++) {
          var copy = s.Duplicate((args.dx || 0) * copyIndex, (args.dy || 0) * copyIndex);
          if (!copy || !copy.StaticID) throw new Error('Duplicate returned no native object; inspect before retrying');
          // Record identity before optional metadata readback can fail.
          var record = { sourceId: sourceId, copy: copyIndex, shape: { shapeId: copy.StaticID } };
          result.copies.push(record);
          record.shape = summary(copy);
        }
      } else if (operation === 'delete_objects') s.Delete();
      else if (operation === 'convert_to_curves') {
        s.ConvertToCurves();
        if (s.Type !== 3) throw new Error('Native curve conversion readback did not return a curve');
        result.objects.push(summary(s));
      } else if (operation === 'set_text') {
        var story = textStory(s); story.Text = args.text;
        if (String(story.Text) !== args.text) throw new Error('Native text setter ignored request: readback mismatch');
        result.objects.push(summary(s));
      }
      result.completed.push(sourceId);
    } catch (error) {
      result.partial = true; result.status = 'failed'; result.failedId = sourceId;
      if (operation === 'duplicate_objects') result.failedCopy = copyIndex;
      result.error = String(error.message || error).slice(0,1000);
      result.unattempted = resolved.length - i - 1;
      result.recovery = 'Inspect partial edits or Undo the named command group before retrying.';
      return result;
    }
  }
  return result;
}

export function buildObjectOperation(name, args) {
  if (!objectOperationTools.some(tool => tool.name === name)) return null;
  const suffix = name.slice('coreldraw_'.length);
  return { body: `var operation=${JSON.stringify(suffix)};return (${objectRuntime.toString()})();`,
    mutates: suffix !== 'get_text', label: 'MCP ' + suffix.replaceAll('_', ' ') };
}
