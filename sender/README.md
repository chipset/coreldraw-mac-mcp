# Graphtec Sender

Native macOS 13+ SwiftUI front end for the repository's Graphtec CLI. No external
Swift packages or Node modules are required. Node 22+ must remain installed at the
path recorded when the app is built.

Build from the repository root:

```sh
./scripts/build-sender.sh
# Optional output location:
./scripts/build-sender.sh '/absolute/path/Graphtec Sender.app'
```

Default output: `dist/Graphtec Sender.app`. The script builds release executables
with temporary caches outside Documents, assembles a code-only runtime, validates
the property list and verifies a local ad-hoc signature. It does not install or
launch the app. It replaces only an existing bundle with this app's identifier.
The app is not notarized.

Run the pure model and subprocess tests:

```sh
swift test --package-path sender --scratch-path /tmp/graphtec-sender-tests
```

## Workflow

1. Open an existing JSON job, save an offline example with **Example Job**, or
   refresh open CorelDRAW documents and **Prepare New Page**. Preparation uses the
   selected source document, cut layer and sheet dimensions, then inspects the job.
2. Print the prepared page at 100% / actual size. The preview shows sheet
   proportions, cut paths and Type 2 registration marks, rather than print artwork.
3. Enter the cutter address, TCP port and matching panel step. **Test Connection**
   tests TCP reachability only. It sends no model-query or cutting commands.
4. Complete manual four-point alignment on the cutter. P1 is lower-right, P2
   upper-right, P3 lower-left and P4 upper-left. Do not set a new origin or reload
   after alignment. Automatic optical ARMS scanning is not implemented.
5. Confirm alignment, panel step and device identity, then **Send Cut Paths**.
   These confirmations reset when a job, address, port or step changes and after
   each send attempt. A send is bound to the SHA256 returned by job inspection.

TCP delivery is experimental on CE8000 pending physical validation. A successful
send reports bytes delivered to the socket; it cannot confirm cutting completion.
Use a pen-only calibration before production. There is no automatic sending,
probing, discovery, retry, initialization or origin change.

**Interrupted send recovery** expands under the connection settings. After an
uncertain send, inspect the cutter and manually clear its buffer. The recovery
button requires an explicit confirmation before invoking `clear-send-state
--host … --port … --acknowledge-uncertain`. Recovery only clears the local record;
it neither sends cutter commands nor clears a live sender's record.

## CLI integration

The bundled runtime lives at `Contents/Resources/runtime`. `GraphtecNodePath` in
`Info.plist` selects the external Node executable. Developers may override the CLI
entrypoint with `GRAPHTEC_CLI_PATH` or the `GraphtecCLIPath` property-list key;
`GRAPHTEC_NODE_PATH` is a fallback when the bundle has no recorded Node path.

All commands must write one JSON object to stdout. A nonzero exit is an error;
`{error,message}` is displayed without interpreting shell text. The app uses
`corel-documents`, `prepare-corel`, `inspect`, `demo`, `export-gpgl`, `probe`, and
`send` with the flags documented in [the workflow guide](../docs/graphtec-print-cut.md). `inspect` must
return `{job,sha256}`; `corel-documents` returns `{documents:[{id,name,...}]}`;
successful `send` returns `status: "delivered-to-socket"`.

Each command runs on a background thread with a 120-second limit and bounded
stdout/stderr files, avoiding pipe deadlocks and keeping native controls responsive.
The CLI remains authoritative for geometry and hardware-side validation. Preview
parsing separately bounds JSON size, schema/version, point count and coordinates.
