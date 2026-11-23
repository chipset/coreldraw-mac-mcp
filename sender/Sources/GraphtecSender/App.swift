import SwiftUI
import AppKit
import UniformTypeIdentifiers
import SenderModel

@main struct GraphtecSenderApp: App {
    @StateObject private var model = SenderState()
    var body: some Scene {
        WindowGroup("Graphtec Sender") { SenderView(model: model).frame(minWidth: 1060, minHeight: 760) }
            .defaultSize(width: 1190, height: 890)
            .commands {
                CommandGroup(replacing: .newItem) {
                    Button("Open Cut Job…") { model.openJob() }.keyboardShortcut("o").disabled(model.busy)
                }
            }
    }
}
struct CorelDocument: Identifiable { let id: String; let name: String }

@MainActor final class SenderState: ObservableObject {
    @Published var documents: [CorelDocument] = []
    @Published var document = ""
    @Published var cutLayer = "Sticker Kiss Cut"
    @Published var sheetWidth = "457.2"
    @Published var sheetHeight = "609.6"
    @Published var host = "" { didSet { resetAcknowledgments() } }
    @Published var port = "9100" { didSet { resetAcknowledgments() } }
    @Published var step = "0.025" { didSet { resetAcknowledgments() } }
    @Published var aligned = false
    @Published var panelMatched = false
    @Published var deviceVerified = false
    @Published var busy = false
    @Published var status = "Open a job or prepare a new print-and-cut page from CorelDRAW."
    @Published var isError = false
    @Published var job: CutJob?
    @Published var jobURL: URL?
    @Published var sha256 = ""
    private var node: String { Bundle.main.object(forInfoDictionaryKey: "GraphtecNodePath") as? String ?? ProcessInfo.processInfo.environment["GRAPHTEC_NODE_PATH"] ?? "/opt/homebrew/bin/node" }
    private var cli: String {
        if let override = ProcessInfo.processInfo.environment["GRAPHTEC_CLI_PATH"], !override.isEmpty { return override }
        if let override = Bundle.main.object(forInfoDictionaryKey: "GraphtecCLIPath") as? String, !override.isEmpty { return override }
        return Bundle.main.resourceURL!.appendingPathComponent("runtime/graphtec/cli.mjs").path
    }
    var validTarget: Bool { !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (Int(port).map { (1...65535).contains($0) } ?? false) }
    var canSend: Bool { !busy && job != nil && sha256.count == 64 && validTarget && aligned && panelMatched && deviceVerified }
    func resetAcknowledgments() { aligned = false; panelMatched = false; deviceVerified = false }
    private func call(_ arguments: [String]) async throws -> [String: Any] {
        guard FileManager.default.isExecutableFile(atPath: node) else { throw JobError.invalid("Node could not be found at \(node). Rebuild the app with an installed Node 22 or newer.") }
        let data = try await CommandRunner.run(executable: node, arguments: [cli] + arguments)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw JobError.invalid("The command returned an invalid response.") }
        if let message = object["message"] as? String, object["error"] != nil { throw JobError.invalid(message) }
        return object
    }
    private func perform(_ message: String, work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; status = message; isError = false
        Task {
            defer { busy = false }
            do { try await work() }
            catch { isError = true; status = error.localizedDescription }
        }
    }
    func refreshDocuments() {
        perform("Reading open CorelDRAW documents…") {
            let result = try await self.call(["corel-documents"])
            guard let list = result["documents"] as? [[String: Any]] else { throw JobError.invalid("CorelDRAW returned no document list.") }
            self.documents = list.compactMap { value in
                guard let rawID = value["documentId"] ?? value["id"] else { return nil }
                let id = String(describing: rawID)
                let name = value["name"] as? String ?? value["title"] as? String ?? "Document \(id)"
                return CorelDocument(id: id, name: name)
            }
            if !self.documents.contains(where: { $0.id == self.document }) { self.document = self.documents.first?.id ?? "" }
            self.status = self.documents.isEmpty ? "No open CorelDRAW documents. Open your source artwork in CorelDRAW, then refresh." : "Choose the source document and cut layer, then prepare a new page."
        }
    }
    private func outputURL(title: String, name: String, json: Bool) -> URL? {
        let panel = NSSavePanel()
        panel.title = title
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        panel.allowedContentTypes = json ? [.json] : [.data]
        panel.message = "Choose a new filename. Existing files are never replaced."
        return panel.runModal() == .OK ? panel.url : nil
    }
    func openJob() {
        let panel = NSOpenPanel()
        panel.title = "Open Graphtec Cut Job"
        panel.allowedContentTypes = [.json]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        resetAcknowledgments()
        perform("Validating cut job…") { try await self.load(url) }
    }
    private func load(_ url: URL) async throws {
        // The backend validates the same file and supplies the fixed hash used by send.
        let result = try await call(["inspect", "--job", url.path])
        guard let hash = result["sha256"] as? String, hash.count == 64, hash.allSatisfy({ $0.isHexDigit }) else { throw JobError.invalid("Job inspection did not return a valid SHA256.") }
        guard let object = result["job"], JSONSerialization.isValidJSONObject(object) else { throw JobError.invalid("Inspection did not return a validated job.") }
        let validated = try CutJob.load(JSONSerialization.data(withJSONObject: object))
        job = validated; jobURL = url; sha256 = hash; resetAcknowledgments()
        status = "Job validated. Print the prepared page at 100%, then complete manual four-point alignment at the cutter."
    }
    func prepare() {
        guard !document.isEmpty, let width = Double(sheetWidth), let height = Double(sheetHeight), width.isFinite, height.isFinite, width > 0, height > 0 else {
            isError = true; status = "Select a CorelDRAW document and enter positive sheet dimensions in millimeters."; return
        }
        guard let url = outputURL(title: "Save Prepared Cut Job", name: "cut-job.json", json: true) else { return }
        resetAcknowledgments()
        let args = ["prepare-corel", "--document", document, "--cut-layer", cutLayer, "--sheet-width", sheetWidth, "--sheet-height", sheetHeight, "--output", url.path]
        perform("Preparing a new CorelDRAW page and registration marks…") {
            _ = try await self.call(args)
            try await self.load(url)
            self.status = "New CorelDRAW page prepared; source page preserved. Job saved to \(url.lastPathComponent). Print that page at 100% before alignment."
        }
    }
    func demo() {
        guard let url = outputURL(title: "Save Offline Example Job", name: "graphtec-example.json", json: true) else { return }
        resetAcknowledgments()
        perform("Creating an offline example…") { _ = try await self.call(["demo", "--output", url.path]); try await self.load(url); self.status = "Offline example loaded. No CorelDRAW or cutter action was performed." }
    }
    func export() {
        guard let jobURL, let url = outputURL(title: "Export Cut Paths as GP-GL", name: "cut-paths.gpgl", json: false) else { return }
        let args = ["export-gpgl", "--job", jobURL.path, "--output", url.path, "--step", step]
        perform("Exporting cut paths…") { let result = try await self.call(args); self.status = "Exported \(result["bytes"] ?? "") bytes to \(url.lastPathComponent). Registration marks and artwork are not cut." }
    }
    func probe() {
        guard validTarget else { return }
        let args = ["probe", "--host", host.trimmingCharacters(in: .whitespacesAndNewlines), "--port", port]
        perform("Testing one TCP connection…") { _ = try await self.call(args); self.status = "TCP connection reached the target. This does not verify cutter identity, readiness or cutting. Check the cutter's network address on its panel." }
    }
    func send() {
        guard canSend, let jobURL else { return }
        let args = ["send", "--job", jobURL.path, "--host", host.trimmingCharacters(in: .whitespacesAndNewlines), "--port", port, "--step", step, "--aligned", "--panel-matched", "--verify-device", "--sha256", sha256]
        perform("Delivering cut paths to the specified socket once…") {
            defer { self.resetAcknowledgments() }
            let result = try await self.call(args)
            guard result["status"] as? String == "delivered-to-socket" else { throw JobError.invalid("Delivery could not be confirmed. Inspect the cutter before taking any further action.") }
            self.status = "Delivered \(result["bytes"] ?? "") bytes to the socket. Cutting completion is NOT verified. Observe the cutter before any further action."
        }
    }
    func recoverInterruptedSend() {
        guard validTarget, !busy else { return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Clear the interrupted-send record?"
        alert.informativeText = "First inspect the cutter at \(host):\(port) and manually clear any pending cutter buffer. The previous attempt may have delivered cut commands. This action only clears the local delivery record; it does not stop or clear the cutter. Confirm only after you have inspected the cutter and cleared its buffer."
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "I Inspected and Cleared the Buffer")
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        resetAcknowledgments()
        let args = ["clear-send-state", "--host", host.trimmingCharacters(in: .whitespacesAndNewlines), "--port", port, "--acknowledge-uncertain"]
        perform("Clearing the acknowledged interrupted-send record…") {
            _ = try await self.call(args)
            self.status = "Local interrupted-send record cleared. Recheck this sheet's alignment, panel step and target address before sending. No cutter command was sent by recovery."
        }
    }
}

struct SenderView: View {
    @ObservedObject var model: SenderState
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Graphtec Sender").font(.title2.bold())
                    Text("CorelDRAW → print → align → cut · CE8000").foregroundStyle(.secondary)
                }
                Spacer()
                Button("Open Job…", action: model.openJob)
                Button("Example Job…", action: model.demo)
                Button("Export GP-GL…", action: model.export).disabled(model.job == nil)
            }.padding(20).disabled(model.busy)
            Divider()
            HSplitView {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        preparePanel
                        networkPanel
                        alignmentPanel
                    }.padding(18)
                }.frame(minWidth: 340, idealWidth: 365, maxWidth: 410)
                VStack(alignment: .leading, spacing: 12) {
                    if let job = model.job {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(job.name).font(.title3.bold()).lineLimit(2)
                                Text("\(job.sheet.widthMm, specifier: "%.1f") × \(job.sheet.heightMm, specifier: "%.1f") mm sheet · \(job.paths.count) paths · \(job.pointCount) points").font(.callout).foregroundStyle(.secondary)
                                Text("Source document \(job.source.documentId) · page \(job.source.pageIndex)").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        JobPreview(job: job).frame(maxWidth: .infinity, maxHeight: .infinity).layoutPriority(1)
                        HStack(spacing: 20) {
                            Label("Cut paths", systemImage: "line.diagonal").foregroundStyle(.purple)
                            Label("Printed Type 2 marks", systemImage: "viewfinder").foregroundStyle(.primary)
                        }.font(.caption)
                        Text("Nominal mark spans: feed \(job.feedSpanMm, specifier: "%.2f") mm · crossfeed \(job.crossfeedSpanMm, specifier: "%.2f") mm").font(.callout)
                        Text("P1 lower-right → P2 upper-right → P3 lower-left → P4 upper-left").font(.caption).foregroundStyle(.secondary)
                        Text(model.jobURL?.path ?? "").font(.caption2).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(2)
                    } else {
                        Spacer()
                        VStack(spacing: 14) {
                            Image(systemName: "doc.viewfinder").font(.system(size: 52)).foregroundStyle(.secondary)
                            Text("Preview your print-and-cut sheet").font(.title3.bold())
                            Text("Open a validated job, create an offline example, or prepare a new page from CorelDRAW. The preview shows exact sheet proportions, cut paths and registration marks.").multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 440)
                            Button("Open Job…", action: model.openJob).buttonStyle(.borderedProminent).disabled(model.busy)
                        }.frame(maxWidth: .infinity)
                        Spacer()
                    }
                }.padding(20).frame(minWidth: 590)
            }
            Divider()
            HStack(alignment: .top, spacing: 10) {
                if model.busy { ProgressView().controlSize(.small) }
                else { Image(systemName: model.isError ? "exclamationmark.triangle.fill" : "info.circle").foregroundStyle(model.isError ? .red : .secondary) }
                Text(model.status).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(16).background(model.isError ? Color.red.opacity(0.06) : Color.accentColor.opacity(0.04))
        }
    }
    private var preparePanel: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 11) {
                HStack { Text("1 · Prepare in CorelDRAW").font(.headline); Spacer(); Button("Refresh", action: model.refreshDocuments) }
                Picker("Document", selection: $model.document) {
                    Text("Select a document").tag("")
                    ForEach(model.documents) { Text($0.name).tag($0.id) }
                }
                TextField("Cut layer", text: $model.cutLayer).textFieldStyle(.roundedBorder)
                HStack {
                    TextField("Width", text: $model.sheetWidth)
                    Text("×")
                    TextField("Height", text: $model.sheetHeight)
                    Text("mm")
                }.textFieldStyle(.roundedBorder)
                Button("Prepare New Page…", action: model.prepare).disabled(model.document.isEmpty)
                Text("Copies artwork and cut paths to a new page. Print that page at 100% (actual size). Never scale to fit.").font(.caption).foregroundStyle(.secondary)
            }.padding(5)
        }.disabled(model.busy)
    }
    private var networkPanel: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 11) {
                Text("2 · Cutter connection").font(.headline)
                TextField("Cutter IP address or hostname", text: $model.host).textFieldStyle(.roundedBorder)
                HStack { Text("TCP port"); TextField("9100", text: $model.port).frame(width: 80).textFieldStyle(.roundedBorder); Spacer(); Button("Test Connection", action: model.probe).disabled(!model.validTarget) }
                Picker("Panel step (mm)", selection: $model.step) {
                    ForEach(["0.1", "0.05", "0.025", "0.01"], id: \.self) { Text($0).tag($0) }
                }
                Text("Ethernet / Wi-Fi TCP delivery is experimental on CE8000. Use a pen-only calibration before production. Connection testing confirms TCP reachability only.").font(.caption).foregroundStyle(.secondary)
                DisclosureGroup("Interrupted send recovery") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("If a send was interrupted, inspect the cutter and clear its buffer before clearing the local record. Never resend an uncertain job without checking the cutter.").font(.caption).foregroundStyle(.secondary)
                        Button("Clear Interrupted-Send Record…", action: model.recoverInterruptedSend).disabled(!model.validTarget)
                    }.padding(.top, 6)
                }.font(.callout)
            }.padding(5)
        }.disabled(model.busy)
    }
    private var alignmentPanel: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 11) {
                Text("3 · Align and send").font(.headline)
                Text("Manual four-point alignment is required at the cutter: P1 lower-right, P2 upper-right, P3 lower-left, P4 upper-left. Automatic ARMS scanning is not implemented.").font(.callout)
                Text("After alignment, do not set a new origin or reload the sheet. Confirm the panel step matches the selected value.").font(.callout).fontWeight(.medium)
                Toggle("Four-point alignment completed for this sheet", isOn: $model.aligned)
                Toggle("Cutter panel step matches \(model.step) mm", isOn: $model.panelMatched)
                Toggle("I verified this target address belongs to my cutter", isOn: $model.deviceVerified)
                Button(action: model.send) { Label("Send Cut Paths", systemImage: "paperplane.fill").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).disabled(!model.canSend)
                Text("Sends cut paths once. Delivery does not confirm completed cutting. Loading a job or changing connection/step clears these confirmations.").font(.caption).foregroundStyle(.secondary)
            }.padding(5)
        }.disabled(model.busy || model.job == nil)
    }
}

struct JobPreview: View {
    let job: CutJob
    var body: some View {
        Canvas { context, size in
            let transform = PreviewTransform(sheetWidth: job.sheet.widthMm, sheetHeight: job.sheet.heightMm, width: size.width, height: size.height, padding: 36)
            func position(_ x: Double, _ y: Double) -> CGPoint { let p = transform.project(JobPoint(x: x, y: y)); return CGPoint(x: p.x, y: p.y) }
            let sheet = CGRect(x: transform.originX, y: transform.originY, width: job.sheet.widthMm * transform.scale, height: job.sheet.heightMm * transform.scale)
            context.fill(Path(sheet), with: .color(.white))
            context.stroke(Path(sheet), with: .color(.gray.opacity(0.6)), lineWidth: 1)
            for (index, cut) in job.paths.enumerated() {
                var path = Path()
                for (i, point) in cut.points.enumerated() { if i == 0 { path.move(to: position(point.x, point.y)) } else { path.addLine(to: position(point.x, point.y)) } }
                path.closeSubpath()
                context.stroke(path, with: .color(index % 2 == 0 ? .purple : .red), lineWidth: 1.2)
            }
            for mark in job.registration.points {
                let right = mark.label == "P1" || mark.label == "P2"
                let top = mark.label == "P2" || mark.label == "P4"
                let length = job.registration.lengthMm
                var path = Path()
                path.move(to: position(mark.x + (right ? -length : length), mark.y))
                path.addLine(to: position(mark.x, mark.y))
                path.addLine(to: position(mark.x, mark.y + (top ? -length : length)))
                context.stroke(path, with: .color(.black), style: StrokeStyle(lineWidth: job.registration.thicknessMm * transform.scale, lineCap: .butt, lineJoin: .miter))
                let corner = position(mark.x, mark.y)
                context.draw(Text(mark.label).font(.system(size: 11, weight: .bold)).foregroundColor(.black), at: CGPoint(x: corner.x + (right ? 13 : -13), y: corner.y + (top ? -12 : 12)))
            }
            context.draw(Text("↑  NOMINAL FEED · P1 → P2").font(.system(size: 10, weight: .medium)).foregroundColor(.secondary), at: CGPoint(x: size.width / 2, y: 15))
            context.draw(Text("CROSSFEED · P1 → P3").font(.system(size: 10, weight: .medium)).foregroundColor(.secondary), at: CGPoint(x: size.width / 2, y: size.height - 14))
        }.background(Color.gray.opacity(0.10)).clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityLabel("Sheet preview with inward Type 2 registration marks and cut contours. P1 at lower right. Feed runs from P1 toward P2.")
    }
}
