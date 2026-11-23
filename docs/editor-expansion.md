# CorelDRAW editor tools

The server exposes 48 tools for English CorelDRAW 2021 on macOS. This guide covers drawing, styling, layout, files and reusable workflows; see the [README](../README.md) for page controls, text operations and inspection. A schema test or mocked object-model test does not establish native API support, visual quality or machine readiness.

## Choose the drawing first

Call `coreldraw_list_documents`, then pass one returned `id` as `document` on subsequent calls. Creation also returns `document.id`.

```sh
node examples/client.mjs coreldraw_list_documents '{}'
node examples/client.mjs coreldraw_inspect_document '{"document":"name:MCP example"}'
node examples/client.mjs coreldraw_list_layers '{"document":"name:MCP example"}'
node examples/client.mjs coreldraw_list_objects '{"document":"name:MCP example","recursive":true,"limit":1000}'
```

The names in these examples are illustrative: use the exact returned selector. `path:/absolute/file.cdr` identifies a saved drawing; `name:Drawing` identifies an unsaved drawing. Save As or renaming changes that ID. Save returns the new ID; otherwise list documents again. Duplicate-name selectors fail rather than choosing one. Every mutation requires an explicit selector when multiple documents are open, and Save As requires one even with a single document.

Object `shapeId` values are Corel StaticIDs, valid for the native objects' lifetime. Supply the IDs returned by creation or inventory, with the same document and active page. The resolver searches that page and its group descendants; an ID from another page does not select or activate that page. After reopening a CDR, inspect the drawing and update stored manifests with fresh IDs. New geometry from boolean operations has its own returned ID. Inventory reports truncation; increase the requested limit or narrow the drawing before relying on a truncated list. Object descriptions include fill type and solid-fill `HexValue`, outline width/color, and whole-story font, size, bold, italic and alignment metadata for text. Text content is limited to its first 500 characters with a `truncated` flag. Native properties that cannot be read are marked `unavailable`; returned color strings follow Corel's `HexValue` representation.

Structured mutations activate the selected drawing and use its active layer. Layer creation changes that active layer only with `activate:true`. Read-only inspection can inspect a selected drawing without activating it.

## Geometry, appearance and layout

New documents use millimeters. `coreldraw_set_units` accepts `mm`, `cm`, `inches`, `points` and `pixels`; changing units does not rescale existing artwork. Coordinates, dimensions, outlines and contour offsets use current document units. Text font sizes use points, rotations use degrees and transparency uses percentages from 0 (opaque) to 100 (transparent).

Rectangle and ellipse x/y are lower-left bounds. Path start points, segment endpoints and cubic control points are absolute coordinates in document units. This path consists of a straight segment, a cubic segment and an implicit closing edge:

```json
{
  "document": "name:MCP example",
  "name": "Curved panel",
  "subpaths": [{
    "start": {"x": 10, "y": 10},
    "segments": [
      {"type": "line", "x": 70, "y": 10},
      {"type": "cubic", "x": 10, "y": 50,
       "c1": {"x": 90, "y": 60}, "c2": {"x": 20, "y": 80}}
    ],
    "closed": true
  }]
}
```

Pass that object to `coreldraw_create_path`. Use `coreldraw_create_polygon` with at least three `{x,y}` points for straight closed outlines. A path is limited to 1000 total segments.

`coreldraw_style_objects` accepts `ids`, a hex RGB fill, `"none"`, or a two-color linear gradient; outline color/width and transparency are optional. For example, after replacing `123` with an actual shape ID:

```json
{
  "document": "name:MCP example",
  "ids": [123],
  "fill": {"start": "#FFC86B", "end": "#305A80", "angle": 45},
  "outline": {"color": "#183D43", "width": 0.2},
  "transparency": 10
}
```

`coreldraw_style_text` applies font, point size, bold, italic and alignment to the whole text story. It rejects non-text IDs before formatting. `coreldraw_transform_objects` resizes a collective range first, applies relative rotation, then places its resulting lower-left bound at x/y. Omitted size or position components retain their existing values.

Arrangement aligns to the selected objects' union bounds. Equal-gap distribution requires at least three objects and keeps the outer edges fixed. Ordering sends objects to the front/back of their own layers. Grouping returns a group ID; ungrouping operates one level and returns the resulting objects.

`coreldraw_combine_shapes` takes exactly two IDs: the first is the source and the second the target. `weld`, `trim` and `intersect` remove originals unless `keepOriginals:true`. `coreldraw_contour` applies an effect to each source; it does not separate the contour into independent shapes. Optional `outlineColor`, `fillColor` and `endFillColor` accept `#RRGGBB`. Omitted colors use the source outline and solid fill; a non-solid source fill falls back to white, and the end fill defaults to the chosen fill. Native geometry can reject an operation even when its input schema is valid.

## Templates and JSON scenes

`coreldraw_create_scene` accepts exactly one of `template` or `scene`. Built-ins are `landscape` and `sign`; they create editable Corel objects. Width/height size the built-in template. x/y offset it. Scenes group by default; set `group:false` to keep top-level objects separate.

Scene results include `groupId`, `namedShapes` as `{name,shapeId}` pairs and the text-only subset `textFields`. Preserve the returned scene object as a JSON manifest alongside the CDR. On Mac 23.1, setting native `Shape.Name` silently failed and custom ObjectData variant/string writes were unsupported. The server therefore retains logical names only within the operation; affected shape descriptions include `namePersistence:"manifest"` and the actual `nativeName`. A later inventory request cannot recover those logical names from the CDR. The manifest preserves the label-to-ID mapping, with no guarantee that either labels or IDs persist through saving and reopening.

```sh
node examples/client.mjs coreldraw_create_scene '{"document":"name:MCP example","template":"sign","name":"Shop sign","title":"THE OAK SHOP","subtitle":"MADE WITH CARE","width":180,"height":90}'
```

A custom scene stores reusable geometry as JSON. Supported elements are `rect`, `ellipse`, `polygon` and `text`. Each can have a `name` and RGB styling. Custom element coordinates are used directly, with the scene x/y offset; scene width/height do not scale custom geometry.

```json
{
  "document": "name:MCP example",
  "name": "Reusable label",
  "scene": {
    "elements": [
      {"type": "rect", "name": "Panel", "x": 0, "y": 0,
       "width": 80, "height": 30, "fill": "#E9DFC5"},
      {"type": "text", "name": "Title", "x": 8, "y": 12,
       "text": "CUSTOM NAME", "fontSize": 18, "fill": "#263B35"}
    ]
  }
}
```

`coreldraw_scene_batch` takes `scenes`, an array of the same scene/template specifications without per-scene document selectors. All use the outer document. It accepts at most 20 scenes and 500 total elements; each scene accepts at most 200 elements.

For personalization, pass a source group and its `textFields` manifest as `fields`. The built-in sign uses `Title` and `Subtitle`. Each field must identify a text descendant of the source. `coreldraw_personalize_batch` duplicates the source once per record, then replaces those text stories. It maps source fields to copy descendants using index paths and verifies the copied hierarchy before replacing text. Copies are offset by 1×, 2×, … the supplied offsets; the source stays in place. Replacement names and field IDs are checked before copying. Missing or repeated names, duplicate field IDs and fields outside the source fail. Omitting `fields` requires unique native descendant names, which the tested Mac name setter cannot create.

```json
{
  "document": "name:MCP example",
  "sourceId": 123,
  "fields": [{"name": "Title", "shapeId": 124}],
  "offsetX": 90,
  "offsetY": 0,
  "records": [
    {"name": "Oak label", "replacements": [{"name": "Title", "text": "OAK"}]},
    {"name": "Walnut label", "replacements": [{"name": "Title", "text": "WALNUT"}]}
  ]
}
```

Replace `123` with the scene's `groupId` and `fields` with its returned `textFields`, including the actual IDs. Personalization accepts at most 100 records and 500 explicit fields. With an MCP client helper that returns the decoded tool result as `call`, preserve and pass the result directly:

```js
const sign = await call('coreldraw_create_scene', {
  document, template: 'sign', name: 'Source sign', title: 'SOURCE',
  width: 80, height: 40
});
const copies = await call('coreldraw_personalize_batch', {
  document, sourceId: sign.groupId, fields: sign.textFields,
  offsetX: 90, offsetY: 0,
  records: [{replacements: [{name: 'Title', text: 'OAK'}]}]
});
```

Keep `sign` with the saved CDR. If the drawing is reopened or its structure changes, inspect its current text descendants and rebuild the field mapping before personalizing again.

## Dimensions and cut lines

`coreldraw_add_dimension` creates three editable line objects and a text label from x1/y1, x2/y2 and an offset. The calculated length uses current document units. A custom label, precision and suffix are available. The annotation is non-associative: changing the measured object later does not update it.

`coreldraw_set_cut_line` applies an RGB outline with a width in document units to explicit `shapeIds` and removes fills by default. Set `removeFill:false` to retain fills. This is artwork styling; cutter configuration, spot-color conventions, tool compensation, material settings and physical validation remain separate work.

## Files, previews and failures

`save_as` always needs an explicit document selector and a new absolute `.cdr` path whose parent exists. It refuses existing targets, sets native overwrite protection and verifies the source identity, shape count, resulting native association and CDR bytes. Use its returned `document.id` after saving.

`import_file` accepts a nonempty regular local CDR, PDF, SVG, PNG or JPEG file, and checks new selected IDs and the page's object-count change. A native call that silently creates nothing fails verification. Symbolic-link sources are refused.

The native import path supplies `host.CreateStructImportOptions()` and the mapped format filter to `Layer.Import`. PNG/SVG exports call `Document.Export` with concrete `host.CreateStructExportOptions()` and `host.CreateStructPaletteOptions()` objects. Omitted native object arguments caused silent no-ops in Mac probes; the structured tools supply them explicitly. Bounded probes verified import, decoded a 1200×800 PNG, and produced SVG plus PDF through `PublishToPDF`. See the [README](../README.md) for the validated platform and native acceptance instructions.

`export_file` accepts a new absolute path and `format:"png"`, `"svg"` or `"pdf"`. PNG/SVG export the current page. PDF publishes the selected document using its current PDF settings; the configured range may include multiple pages. Raster options are accepted only for PNG: integer width/height in pixels, dpi 36–1200 and optional transparency. Omitted PNG dimensions use native defaults.

```sh
node examples/client.mjs coreldraw_preview '{"document":"name:MCP example","path":"/tmp/corel-example-preview.png","width":1200,"height":900,"dpi":144}'
node examples/client.mjs coreldraw_export_file '{"document":"name:MCP example","path":"/tmp/corel-example.svg","format":"svg"}'
node examples/client.mjs coreldraw_save_as '{"document":"name:MCP example","path":"/tmp/corel-example.cdr"}'
```

Choose new filenames if these example targets already exist. Export writes to a private staging directory, checks the format bytes and publishes without overwriting an existing target. These checks identify expected file structures; they are not full rendering or playback validation. `preview` returns the PNG as an MCP image plus metadata; clients decide how to display it.

Undo groups collect edits into one Corel Undo step. They do not provide rollback or transactional guarantees. Native failures can leave partial edits. Batch results distinguish completion from failure and include surviving created IDs, the failed index, completed items and how many items were not attempted. Inspect those results and the drawing before retrying. A later retry can otherwise create duplicate artwork.

Corel's JavaScript native proxies can report `typeof nativeMethod === 'undefined'` even for callable methods. Runtime success is based on invocation, returned objects and postflight evidence rather than `typeof` alone. The Mac release can still lack or reject particular API operations. A Mac contour probe returned no effect when native color arguments were omitted; supplying all 12 native arguments, including concrete color objects for the three color parameters, returned contour effect type 6. The structured contour tool therefore supplies explicit colors and numeric defaults. This bounded result does not establish acceptance of every editor, workflow or file operation. The trusted `run_javascript` escape hatch bypasses structured document selection, undo and file-publication restrictions.

A timeout may occur after native edits started. The bridge performs no automatic retries and its recovery interlock can block subsequent requests. Follow the recovery instructions in [README.md](../README.md).

## Opt-in native acceptance

```sh
node examples/accept-expansion.mjs
```

Run with CorelDRAW open, an unlocked desktop and Accessibility permission. The script creates a new disposable drawing and timestamped `artifacts/acceptance-*` directory, records each call in `evidence.json`, and attempts geometry, styling, layout, templates, personalization, preview, export, import and save. It stops at the first failure and retains evidence and artifacts. It does not edit existing drawings and does not automatically close the disposable drawing. Inspect the generated evidence to establish its actual outcome; the presence of the runner is not a native acceptance claim.
