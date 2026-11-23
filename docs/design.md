# Architecture

The server exposes CorelDRAW's JavaScript `host` object model through a local MCP
stdio connection. A Swift helper controls the macOS Scripts inspector through
Accessibility. It loads a request-specific script, runs it once, and returns the
matching JSON alert to the Node process. There are no external npm or Swift packages.

The validated host is English CorelDRAW 2021 (23.1.0.389) on Apple Silicon macOS.
Other versions and languages need separate native validation. The bridge requires a
licensed application, an unlocked desktop and a drawing with the Scripts inspector
available; it is not a headless rendering service.

## Components

| Component | Responsibility |
| --- | --- |
| `src/server.mjs` | JSON-RPC, MCP initialization, tool/resource discovery, cancellation and image responses |
| `src/tools.mjs` | The 48-tool catalog, bounded input validation and operation dispatch |
| `src/document.mjs` | Document selectors, scalar snapshots, group traversal and named Undo groups |
| `src/editor.mjs` | Vector creation, styling, layout, selection and native effects |
| `src/object-operations.mjs` | Duplication, deletion, curve conversion and text read/write |
| `src/pages.mjs` | Paginated pages, page changes, layer activation and verified layer flags |
| `src/inspection.mjs` | Bounded search, curve metadata and pass/fail/unknown checks |
| `src/files.mjs` | Import/export/save builders and destination preflight |
| `src/workflows.mjs` | Editable scenes, personalization, dimensions and cut-line styling |
| `src/bridge.mjs` | Serialized execution, private request files and output verification/publication |
| `native/Sources/CorelBridge/` | Accessibility, cross-process locking, correlated responses and recovery state |

## Execution boundaries

Inputs are encoded as JSON data into a native function body. Structured mutations
require an explicit document selector when multiple drawings are open, activate the
target, and use a named Undo group. New object operations resolve all requested IDs
before editing. Undo groups are not transactions; partial failures retain completed
IDs where available and require inspection.

The Node queue serializes requests within a process. A per-user native lock
serializes across processes. Cancellation before dispatch prevents execution; after
dispatch, the bridge observes until a terminal result or deadline. Indeterminate
operations are never retried automatically.

The helper raises the Scripts window and checks the actual input target before
activation. It refuses unrelated modal dialogs and unmanaged script-name collisions.
A durable in-flight record blocks later scripts after a crash or missing terminal
alert until explicit recovery. Recovery refuses while CorelDRAW is running. Native
response envelopes are limited to 256 KiB of UTF-8 JSON.

## Files and native limitations

Save As refuses existing destinations, supplies native no-overwrite options and
verifies source identity, object counts, resulting path and CDR container bytes.
Exports use private staging paths, verify format signatures and publish through an
atomic no-clobber link. These checks do not establish visual fidelity.

Some Corel proxies report callable methods as `typeof === 'undefined'`. Support is
determined by actual calls and postflight results. Shape-name writes can be ignored
on this Mac, so scenes return JSON label/ID manifests instead of promising persistent
CDR names. IDs must be refreshed after reopening.

Inspection is bounded by item count, depth and serialized size. Unavailable
measurements produce unknown results. Bitmap DPI estimates cannot prove the absence
of shear or ancestor transforms and remain unknown for production checks. Fonts,
duplicate geometry, PowerClip contents, other pages and physical output are outside
the current preflight scope.

Trusted `run_javascript` code has the full powers of Corel scripts and can bypass
structured document targeting, Undo and destination checks.

## Verification

`npm test` exercises protocol behavior, schemas, generated operations against host
doubles, files, cancellation and output bounds. Swift tests exercise response
correlation and durable recovery. These tests do not require CorelDRAW and do not
establish native API support.

The opt-in acceptance scripts under `examples/` call the real bridge with a running
CorelDRAW application. They create disposable drawings and timestamped artifacts,
record results and stop on unexpected failure. Native support must be established
from those results separately from automated test success.
