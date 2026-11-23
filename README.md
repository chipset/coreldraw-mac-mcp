# CorelDRAW MCP for macOS

A local [Model Context Protocol](https://modelcontextprotocol.io/) server that lets an AI assistant inspect and edit CorelDRAW drawings on macOS. Create editable geometry and text, manage pages and layers, personalize artwork, inspect production details, and save or export through **48 tools**.

The server uses Node.js built-ins and a small Swift Accessibility helper to run JavaScript through CorelDRAW's Scripts inspector. Your MCP client starts it on demand over **stdio**; there is no web service to deploy or listening port to configure.

## Graphtec print-and-cut

Version 0.4.0 adds a **Graphtec Sender** Mac app and CorelDRAW registration-mark
preparation. It copies artwork to a new page, adds printable Type 2 marks, and keeps
the cut paths nonprinting. The sender previews and exports jobs and can send
geometry over TCP after manual four-point alignment on the CE8000.

```sh
./scripts/build-sender.sh
open 'dist/Graphtec Sender.app'
```

Automatic optical ARMS scanning is not implemented; direct CE8000 network cutting
still needs physical pen-test validation. Socket delivery does not establish cut
completion. No Illustrator or CM5 dependency is required. Read the
[workflow and first-use checks](docs/graphtec-print-cut.md) and
[sender app guide](sender/README.md) before sending a job.

## Requirements

- macOS 13 or later.
- Node.js 22 or later.
- Xcode Command Line Tools with Swift 5.9 or later (`xcode-select --install`).
- A licensed CorelDRAW installation with JavaScript scripting support and an **English UI**.
- An unlocked desktop, CorelDRAW running, and an open drawing for drawing tools.
- macOS Accessibility permission for the application hosting the helper.

The tested environment is **Apple Silicon with CorelDRAW 2021, version 23.1.0.389**. Other CorelDRAW releases, UI languages, and Intel Macs are unverified. CorelDRAW is a separate commercial product and is not included.

## Build and connect

Open a terminal in this repository's root directory and build the native helper:

```sh
./scripts/build-native.sh
```

No npm dependency installation or third-party Swift packages are needed. The build creates `native/coreldraw-bridge`.

Start CorelDRAW and open a drawing. In **System Settings → Privacy & Security → Accessibility**, allow the application hosting the helper, such as your terminal or MCP client. Keep the desktop unlocked. Check readiness and the available drawings:

```sh
node examples/client.mjs coreldraw_status '{}'
node examples/client.mjs coreldraw_list_documents '{}'
```

`coreldraw_status` reports readiness; it does not launch CorelDRAW or change its UI. Tool execution uses the visible Scripts inspector, so avoid interacting with CorelDRAW while a request is running. Unrelated modal dialogs are left for you to resolve.

### Codex

Run this from the repository root so registration records your actual absolute paths:

```sh
codex mcp add coreldraw -- "$(command -v node)" "$PWD/src/server.mjs"
codex mcp get coreldraw
```

Reconnect or restart the MCP client to load the registration. The client launches the server as needed; a separate `npm start` session is unnecessary.

### Other MCP clients

Use your client's stdio server configuration, replacing both paths with absolute paths on your Mac:

```json
{
  "mcpServers": {
    "coreldraw": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/coreldraw-mcp/src/server.mjs"]
    }
  }
}
```

## Try a targeted drawing

In your assistant, ask: “List my CorelDRAW documents, inspect the drawing I choose, create an editable sign on its active page, and preview it.” Have it use the document selector and object IDs returned by the tools.

The following terminal example creates a **new** drawing, styles the exact rectangle and text it creates, then exports a PNG preview. Run it from the repository root with CorelDRAW ready. It calls the real server and changes the drawing:

```sh
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function call(name, args) {
  const result = JSON.parse(execFileSync(process.execPath,
    ['examples/client.mjs', name, JSON.stringify(args)], { encoding: 'utf8' }));
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}

const stamp = Date.now();
const created = call('coreldraw_create_document', {
  name: `MCP sign ${stamp}`, width: 160, height: 80
});
const document = created.document.id;
const panel = call('coreldraw_create_rectangle', {
  document, x: 10, y: 10, width: 140, height: 60
});
call('coreldraw_style_objects', {
  document, ids: [panel.shapeId], fill: '#183D43', outline: { color: 'none' }
});
const title = call('coreldraw_create_text', {
  document, x: 25, y: 35, text: 'HELLO, COREL'
});
call('coreldraw_style_text', { document, ids: [title.shapeId], size: 24, bold: true });
call('coreldraw_style_objects', { document, ids: [title.shapeId], fill: '#FFFFFF' });
const path = join(tmpdir(), `coreldraw-sign-${stamp}.png`);
console.log(call('coreldraw_preview', { document, path, width: 1200, height: 600 }));
JS
```

The example leaves the editable drawing open and prints the preview location. MCP clients also receive preview image content and decide how to display it.

### Documents, IDs, and units

Call `coreldraw_list_documents` first and pass a returned `id` as `document`. Saved selectors look like `path:/absolute/drawing.cdr`; unsaved selectors look like `name:Drawing`. Edits require an explicit selector when multiple drawings are open. Save As always requires one. Ambiguous selectors fail rather than picking a drawing.

Save As or renaming changes the selector; use the returned `document.id` or list documents again. Object `shapeId` values are native **StaticIDs**, valid for the object's lifetime. Use IDs returned by creation or inventory. They resolve on the selected drawing's **active page**, including group descendants. Refresh inventory after changing pages, replacing geometry, or reopening a CDR.

New drawings use millimeters. Coordinates, geometry dimensions, outline widths, and contour offsets use current document units. Rectangle and ellipse x/y values describe lower-left bounds. Path points and cubic control points are absolute coordinates. Text sizes use points, rotation uses degrees, and transparency ranges from 0 to 100 percent. Changing units does not rescale existing artwork.

## Tool catalog

All names below are the complete MCP tool names. Read-only MCP resources `coreldraw://reference` and `coreldraw://tools` expose guidance and current input schemas without running native code.

| Group | Tools |
| --- | --- |
| Documents and scripting | `coreldraw_status`, `coreldraw_list_documents`, `coreldraw_inspect_document`, `coreldraw_create_document`, `coreldraw_run_javascript` |
| Geometry and layers | `coreldraw_create_rectangle`, `coreldraw_create_ellipse`, `coreldraw_create_text`, `coreldraw_create_path`, `coreldraw_create_polygon`, `coreldraw_list_layers`, `coreldraw_create_layer` |
| Styling and layout | `coreldraw_list_objects`, `coreldraw_select_objects`, `coreldraw_style_objects`, `coreldraw_style_text`, `coreldraw_transform_objects`, `coreldraw_arrange_objects`, `coreldraw_group_objects`, `coreldraw_order_objects`, `coreldraw_combine_shapes`, `coreldraw_contour` |
| Files and previews | `coreldraw_save_as`, `coreldraw_import_file`, `coreldraw_export_file`, `coreldraw_preview` |
| Reusable workflows | `coreldraw_set_units`, `coreldraw_add_dimension`, `coreldraw_set_cut_line`, `coreldraw_create_scene`, `coreldraw_personalize_batch`, `coreldraw_scene_batch` |
| Pages and layer control | `coreldraw_list_pages`, `coreldraw_add_pages`, `coreldraw_activate_page`, `coreldraw_set_page_size`, `coreldraw_rename_page`, `coreldraw_activate_layer`, `coreldraw_set_layer_properties` |
| Object and text operations | `coreldraw_duplicate_objects`, `coreldraw_delete_objects`, `coreldraw_convert_to_curves`, `coreldraw_get_text`, `coreldraw_set_text` |
| Inspection and production | `coreldraw_find_objects`, `coreldraw_inspect_curve`, `coreldraw_production_preflight` |
| Graphtec print-and-cut | `coreldraw_prepare_graphtec_job` |

### Files and previews

- `coreldraw_save_as` saves to a **new absolute `.cdr` path** with an existing parent directory. It uses native overwrite protection and verifies the resulting association and CDR bytes.
- `coreldraw_import_file` imports nonempty regular local CDR, PDF, SVG, PNG, or JPEG files. Symbolic-link sources are refused.
- `coreldraw_export_file` exports **PNG, SVG, or PDF** to a new absolute path. PNG/SVG use the active page; PDF uses the drawing's existing PDF settings, which may cover multiple pages. PNG supports pixel dimensions, DPI, and transparency options.
- `coreldraw_preview` writes a new PNG and returns an MCP image plus metadata. Inline images are limited to 16 MiB.

Structured saves, exports, and previews **refuse existing targets**. Exports use private staging files, verify format bytes, then publish without replacing files. Choose a fresh filename for each output. These checks do not establish visual correctness.

### Limits and production checks

Object duplication, deletion, conversion to curves, and text replacement accept up to 200 root IDs. Duplication returns at most 200 copy summaries and creates at most 10,000 objects including descendants. Ancestor/descendant overlaps are refused. Other tools have their own schema limits.

Object inventory returns at most 1,000 objects and reports truncation. `coreldraw_get_text` defaults to 10,000 characters and allows up to 30,000; check `length` and `truncated`. Mutation summaries shorten names and text to 64 characters. Page lists are paginated with a maximum of 100 items per call and a `nextOffset` cursor.

Inspection and preflight have traversal, pagination, and byte bounds. An incomplete scan cannot pass preflight. Production preflight checks active-page objects and nested groups, with exclusions including font substitution, duplicate geometry, PowerClip contents, and other pages. Bitmap DPI remains **unknown**: bounding boxes cannot prove the absence of shear or inherited transforms. `estimatedDpiX/Y` values are estimates, not verified effective resolution. A pass applies only to the reported scope and checks; it is not fabrication certification.

Dimension annotations are editable lines and text, not associative measurements. Cut-line styling does not configure a cutter, materials, compensation, or machine settings.

### Reusable names and personalization

On the tested Mac release, native shape-name writes are silently ignored and custom ObjectData string writes are unsupported. Creation responses preserve logical labels with `namePersistence:"manifest"` and report the actual `nativeName`. Save scene responses as JSON manifests alongside the CDR; those labels have no CDR persistence guarantee.

Scenes return `groupId`, `namedShapes`, and `textFields`. Pass the returned `textFields` as `personalize_batch.fields` to identify text explicitly. StaticIDs can change after reopening; inspect the drawing and rebuild the manifest before reusing it. See [editor examples](docs/editor-expansion.md) for paths, styles, templates, JSON scenes, and personalization.

## Execution, errors, and recovery

The helper writes a managed `CodexMCP.js` into CorelDRAW's User Scripts directory, runs it once through Accessibility, reads a request-specific JSON alert, and leaves an idle script. It refuses to overwrite an existing unmanaged script of that name. Before dispatch, it checks that the actual click point belongs to CorelDRAW's Scripts window. Covered targets fail before execution.

Native execution is serialized across server instances. Stdout carries MCP messages; diagnostics go to stderr. Structured edits use named Undo groups, which **do not provide transactions or rollback**. Native failures can leave partial edits. Batch responses report completed work, surviving IDs, the failed index, and unattempted items. Inspect both the response and drawing before retrying; use CorelDRAW's Undo when appropriate.

**A timeout or error after activation can mean the drawing already changed. There are no automatic retries.** A durable in-flight record blocks later scripts if no matching terminal response was observed, including after a crash. To recover:

1. Inspect the drawing and save any work you need.
2. **Quit CorelDRAW.** Recovery refuses while it is running.
3. From the repository root, clear the interlock:

   ```sh
   native/coreldraw-bridge recover com.corel.coreldrawsuite.2021.coreldraw
   ```

4. Restart CorelDRAW and check status before continuing.

For a custom installation, use its bundle ID in the recovery command. Do not delete the in-flight record to force another script while one could still be running. Cancellation before dispatch prevents execution; cancellation after dispatch keeps observing until completion or deadline. Cancellation does not undo edits.

`coreldraw_run_javascript` runs trusted code with the full Corel script API. It can edit other drawings or write arbitrary files and bypass structured targeting, Undo, and no-overwrite restrictions. Supply only code you trust.

## Configuration

Set environment variables in your MCP client's server configuration before it launches the process.

| Variable | Default / behavior |
| --- | --- |
| `CORELDRAW_BUNDLE_ID` | `com.corel.coreldrawsuite.2021.coreldraw` |
| `CORELDRAW_SCRIPT_DIR` | `~/Library/Application Support/Corel/CorelDRAW Graphics Suite 2021/Draw/Scripts` |
| `CORELDRAW_HELPER` | The built `native/coreldraw-bridge` inside this repository |
| `CORELDRAW_TIMEOUT_SECONDS` | `30`; supported native execution range is 1–120 seconds |
| `CORELDRAW_DEBUG` | Set to `1` for native Accessibility diagnostics |

The bundle ID and scripts directory must refer to the same installed CorelDRAW version. Changing them does not establish support for that release.

## Development and verification

Run the noninteractive checks from the repository root:

```sh
npm test
npm run check
swift test --package-path native --scratch-path "$HOME/Library/Caches/coreldraw-mcp/test-build"
```

Protocol tests, JavaScript object-model doubles, and Swift tests do not establish native API support or visual quality. Live CorelDRAW acceptance is separate and **opt-in**:

```sh
node examples/accept-expansion.mjs
npm run native:consolidation
```

These runners require a ready CorelDRAW session. Each creates a uniquely named disposable drawing and timestamped artifacts under `artifacts/`, retains evidence, and stops on unexpected failure. They do not automatically retry native mutations or close the disposable drawing. The presence of a runner is not a claim that every native operation passes.

See the [architecture notes](docs/design.md) and [editor examples](docs/editor-expansion.md) for implementation details and native API limitations.

## License

[MIT](LICENSE). CorelDRAW and its related trademarks belong to their respective owners.
