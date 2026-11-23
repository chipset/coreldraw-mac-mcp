# CorelDRAW Mac → Graphtec CE8000 print and cut
Graphtec Sender prepares a separate print page in CorelDRAW Mac and sends its
closed cut contours through a native Mac app. Illustrator and Cutting Master 5
are not required. **CE8000 transport, axis orientation and physical registration
are not hardware-verified.** Start with a pen and scrap media before production.

## Prepare and print

1. Open the source document in CorelDRAW and activate the artwork page. Put cut
   contours on one uniquely named layer, normally `Sticker Kiss Cut`. Use closed,
   plain native curves; groups of those curves are supported. Convert other cut
   objects to curves first. Open paths, cut effects and PowerClip cuts are refused.
2. Open **Graphtec Sender** from `~/Applications/Graphtec Sender.app`, refresh
   CorelDRAW documents, select the source document and exact cut-layer name.
3. Enter the **actual physical sheet dimensions**. The defaults are 457.2 ×
   609.6 mm (18 × 24 inches), not a promise that every CE8000 model accepts them.
   Choose **Prepare New Page** and a new job-file destination.
4. Preparation copies artwork and cut contours to a new page without scaling,
   preserves the source page, and adds four inward-facing Type 2 marks. Defaults:
   10 mm arms, 0.5 mm thickness, 20 mm artwork-to-mark-frame gap. The copied cut
   layer is nonprinting; artwork and marks print. Save the CorelDRAW document.
5. Print **only the newly prepared current page**, at **100% / actual size**.
   Disable fit-to-page or other scaling. Check print preview: artwork and four
   marks must appear, while cut contours must not print.

The app preview shows sheet proportions, marks and cut paths, not print artwork.
If the new page exists but saving the job fails, the error identifies a recovered
job under `~/Library/Application Support/Graphtec Sender/Recovered Jobs`.

## Align at the cutter, then send

Load the printed sheet and use the cutter's **ARMS → MARK SCAN MODE → AXIS
ALIGNMENT → 4 POINTS** manual position-adjust workflow. Jog the tool tip to each
mark intersection in this order, as shown in the app:

| Point | Position on the prepared page |
|---|---|
| P1 | Lower right; aligned coordinate origin |
| P2 | Upper right; feed direction from P1 |
| P3 | Lower left; crossfeed direction from P1 |
| P4 | Upper left |

Enter the nominal **P1–P2 feed distance** and **P1–P3 crossfeed distance** shown
in the app when the cutter requests distances. Finish alignment and return HOME.
Do not set a new origin, reload the media, or change rotation/mirror afterward;
those actions invalidate alignment. Repeat alignment for each loaded sheet.

Set the panel command mode explicitly to **GP-GL** and make its step size match
the app: **0.025 mm by default**. Available choices are 0.1, 0.05, 0.025 and
0.01 mm. Set force, speed and the appropriate tool condition on the cutter panel.
The sender emits only ETX-terminated `M`/`D` geometry; it does not set tool
conditions, initialize the cutter or change its origin.

Enter the known cutter address and TCP port (default **9100**, configurable).
**Test Connection** opens and closes TCP with zero command bytes: reachability
does not verify cutter identity, readiness, alignment or model. Independently
check the target device, then confirm all three checks in the app: this sheet's
four-point alignment, matching panel mode/step, and target identity. Choose
**Send Cut Paths** once. The send is tied to the inspected job's SHA256.

A successful send means **delivered to the socket**, not accepted geometry or
completed cutting. There is no automatic discovery, sending or retry. Automatic
optical ARMS scanning is not implemented. The panel's **TEST ARMS SENSOR** is a
diagnostic that cuts a cross; this workflow does not invoke it.

## CLI

Run from the repository root with Node 22+. Output files must use new absolute
paths; existing files are not overwritten. Replace the document identifier with
one returned by `corel-documents`. Use your cutter's known address only.

```sh
node graphtec/cli.mjs corel-documents
node graphtec/cli.mjs prepare-corel --document 'name:My Artwork.cdr' \
  --cut-layer 'Sticker Kiss Cut' --sheet-width 457.2 --sheet-height 609.6 \
  --length 10 --thickness 0.5 --gap 20 --output /absolute/path/job.graphtec.json
node graphtec/cli.mjs demo --output /absolute/path/offline-example.graphtec.json
node graphtec/cli.mjs inspect --job /absolute/path/job.graphtec.json
node graphtec/cli.mjs export-gpgl --job /absolute/path/job.graphtec.json \
  --step 0.025 --output /absolute/path/job.gpgl
node graphtec/cli.mjs probe --host CUTTER_ADDRESS --port 9100 --timeout 5000
node graphtec/cli.mjs send --job /absolute/path/job.graphtec.json \
  --host CUTTER_ADDRESS --port 9100 --step 0.025 \
  --sha256 INSPECTED_SHA256 --aligned --panel-matched --verify-device
```

`demo` is an offline 100 × 60 mm rectangle preview, not the 10 mm calibration.
`inspect` validates the job and returns the SHA256 and nominal mark distances.
Reinspect after any job change; all three send flags are required operator checks.

## Interrupted-send recovery

An uncertain dispatch retains a local record and blocks another send to that
host/port. Inspect the physical cutter and manually clear its pending job buffer
before using the app's **Interrupted send recovery**, or:

```sh
node graphtec/cli.mjs clear-send-state --host CUTTER_ADDRESS --port 9100 \
  --acknowledge-uncertain
```

Recovery removes only the local record; it neither stops the cutter, clears its
buffer nor undoes cutting. It refuses to clear a record whose sender process is
still alive. Recheck device, panel settings and sheet alignment before resending.

## Build and validate

```sh
./scripts/build-sender.sh
# Or build directly to the installed app location:
./scripts/build-sender.sh "$HOME/Applications/Graphtec Sender.app"
npm test
npm run check
swift test --package-path sender --scratch-path /tmp/graphtec-sender-tests
swift test --package-path native --scratch-path /tmp/coreldraw-bridge-tests
node --test test/graphtec-transport.test.mjs test/graphtec-service.test.mjs
```

The app requires macOS 13+ and an external Node 22+ executable at its build-time
path. Builds are locally ad-hoc signed, not notarized. The transport tests use a
local fake TCP receiver; they do not prove CE8000 compatibility. Real CorelDRAW
preparation and app interaction require an unlocked desktop and appropriate Mac
permissions. The commands above are validation instructions, not a claim that
every check or live interaction has passed in this environment.

For first physical validation, use a pen: (1) plot a **10 mm square** and measure
both axes to verify step size, scale and orientation; (2) print a small registered
sheet at actual size, perform manual four-point alignment, and plot an overlay;
(3) measure alignment throughout the frame before trying a blade. No physical
cutter test is claimed by this guide.

## Protocol evidence and limits

- [Graphtec CE8000 specifications](https://www.graphteccorp.com/cutting/ce8000/)
  confirm GP-GL/HP-GL support and selectable GP-GL steps.
- [Official command settings](https://mygraphtec.jp/site_download/manual/ce8000/HTML_ENG/ce8000_eng/CE8000-151-11-01.html)
  warn that AUTO command detection can misidentify data.
- [Official manual position adjustment](https://mygraphtec.jp/site_download/manual/ce8000/HTML_ENG/ce8000_eng/CE8000-151-06-01.html)
  documents four-point panel alignment and when adjustment is cleared.
- [Official ARMS guidance](https://mygraphtec.jp/site_download/manual/ce8000/HTML_ENG/ce8000_eng/CE8000-151-05-01.html)
  covers marks, sensor calibration and the diagnostic cutting action.
- [Fieldkit's MIT-licensed implementation](https://github.com/Fieldkit-Print/open-graphtec-server)
  reports TCP 9100 and automatic ARMS validation on FC9000, not CE8000.
- [craft-plotter protocol notes](https://github.com/storytold/craft-libs/tree/main/crates/plotter)
  describe GP-GL framing but explicitly lack hardware verification.

[Graphtec's SDK](https://www.graphteccorp.com/support/sdk/) offers special-command
and XPF documentation by request. SDK-based automation is deferred. This utility's
JSON jobs are its own format; no XPF, barcode/Data Link, USB transport or automated
ARMS compatibility is claimed.
