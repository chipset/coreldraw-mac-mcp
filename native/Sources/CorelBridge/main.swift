import AppKit
import ApplicationServices
import Foundation
import Darwin

func output(_ value: [String: Any], code: Int32 = 0) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"error\":\"JSON encoding failed\"}".utf8)
    FileHandle.standardOutput.write(data + Data([10]))
    exit(code)
}

let args = CommandLine.arguments
guard args.count >= 3 else { output(["ok": false, "error": "Usage: coreldraw-bridge status BUNDLE_ID | run BUNDLE_ID SCRIPT_PATH RESPONSE_PREFIX TIMEOUT_SECONDS"], code: 2) }
let bundleID = args[2]
let installedURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first
let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
let locked = session["CGSSessionScreenIsLocked"] as? Bool ?? false
let trusted = AXIsProcessTrusted()
let eventPostingAllowed = CGPreflightPostEventAccess()
let cacheURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/coreldraw-mcp")
let recovery = RecoveryState(url: cacheURL.appendingPathComponent("in-flight.json"))

if args[1] == "status" {
    let version: String = installedURL.flatMap { Bundle(url: $0)?.infoDictionary?["CFBundleShortVersionString"] as? String } ?? "unknown"
    output(["ok": true, "installed": installedURL != nil, "running": running != nil,
            "accessibilityTrusted": trusted, "eventPostingAllowed": eventPostingAllowed, "screenLocked": locked, "bundleID": bundleID,
            "version": version, "path": installedURL?.path ?? "", "pid": running?.processIdentifier ?? 0,
            "recoveryRequired": recovery.required])
}

if args[1] == "diagnose", let process = running {
    guard trusted else { output(["ok": false, "error": "Accessibility permission required"], code: 1) }
    let ui = CorelAccessibility(pid: process.processIdentifier, timeout: 5)
    let elements = ui.elements()
    var activationHits: [[String: Any]] = []
    for row in elements where ui.string(row, kAXRoleAttribute) == kAXRowRole && ui.label(row) == "CodexMCP" {
        if let position = ui.attribute(row, kAXPositionAttribute), let size = ui.attribute(row, kAXSizeAttribute) {
            var point = CGPoint.zero, dimensions = CGSize.zero
            if AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) {
                point.x += min(dimensions.width / 2, 120); point.y += dimensions.height / 2
                for (scope, root) in [("application", ui.app), ("system", AXUIElementCreateSystemWide())] {
                    var hit: AXUIElement?
                    let error = AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &hit)
                    var record: [String: Any] = ["scope": scope, "x": point.x, "y": point.y, "error": error.rawValue]
                    if let hit {
                        var pid: pid_t = 0; AXUIElementGetPid(hit, &pid)
                        record["pid"] = pid; record["role"] = ui.string(hit, kAXRoleAttribute); record["label"] = ui.label(hit)
                        var ancestors: [[String: String]] = [], current: AXUIElement? = hit
                        for _ in 0..<10 {
                            guard let element = current else { break }
                            ancestors.append(["role": ui.string(element, kAXRoleAttribute), "label": ui.label(element)])
                            current = ui.attribute(element, kAXParentAttribute).map { $0 as! AXUIElement }
                        }
                        record["ancestors"] = ancestors
                    }
                    activationHits.append(record)
                }
            }
        }
    }
    output(["ok": true, "activationHits": activationHits, "elements": elements.map { element in
        ["role": ui.string(element, kAXRoleAttribute), "label": ui.label(element), "id": ui.string(element, kAXIdentifierAttribute)]
    }])
}

func acquireLock() {
    do { try FileManager.default.createDirectory(at: cacheURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
    catch { output(["ok": false, "error": "Cannot create bridge lock directory: \(error.localizedDescription)"], code: 1) }
    let descriptor = Darwin.open(cacheURL.appendingPathComponent("bridge.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    guard descriptor >= 0, flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
        output(["ok": false, "error": "Another CorelDRAW MCP request is running; no script was run."], code: 1)
    }
    // Retain this descriptor for the process lifetime, including recovery.
}

if args[1] == "recover" {
    acquireLock()
    do {
        try recovery.recover(bundleID: bundleID, applicationIsRunning: { !NSRunningApplication.runningApplications(withBundleIdentifier: $0).isEmpty })
        output(["ok": true, "recoveryRequired": false])
    }
    catch { output(["ok": false, "error": error.localizedDescription], code: 1) }
}

guard args[1] == "run", args.count == 6, let timeout = Double(args[5]), timeout >= 1, timeout <= 120 else {
    output(["ok": false, "error": "Invalid run arguments; timeout must be 1-120 seconds"], code: 2)
}
guard installedURL != nil else { output(["ok": false, "error": "CorelDRAW bundle is not installed: \(bundleID)"], code: 1) }
guard trusted else { output(["ok": false, "error": "Accessibility permission is required for the MCP host/native helper in System Settings > Privacy & Security > Accessibility. No script was run."], code: 1) }
guard eventPostingAllowed else { output(["ok": false, "error": "macOS is blocking input events from the MCP host/native helper. Check its Accessibility permission in System Settings > Privacy & Security > Accessibility. No script was run."], code: 1) }
guard !locked else { output(["ok": false, "error": "The macOS screen is locked. Unlock the desktop before CorelDRAW automation. No script was run."], code: 1) }
guard let process = running else { output(["ok": false, "error": "Open CorelDRAW before running scripts. No script was run."], code: 1) }
let path = args[3]
guard path.hasPrefix("/"), URL(fileURLWithPath: path).pathExtension.lowercased() == "js", FileManager.default.fileExists(atPath: path), !args[4].isEmpty else {
    output(["ok": false, "error": "Expected an existing absolute .js path and a nonempty response prefix"], code: 2)
}
acquireLock()
// Closing the descriptor on process exit releases the cross-process lock.
process.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
let scriptDir = ProcessInfo.processInfo.environment["CORELDRAW_SCRIPT_DIR"] ??
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Corel/CorelDRAW Graphics Suite 2021/Draw/Scripts").path
let managedURL = URL(fileURLWithPath: scriptDir).appendingPathComponent("CodexMCP.js")
let managedHeader = ManagedScript.header
let idleScript = ManagedScript.idle
var result: [String: Any]
do {
    try FileManager.default.createDirectory(at: managedURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    if FileManager.default.fileExists(atPath: managedURL.path) {
        guard try String(contentsOf: managedURL, encoding: .utf8).hasPrefix(managedHeader) else {
            throw BridgeError("CodexMCP.js exists and is not managed by this server; refusing to overwrite it")
        }
    }
    if recovery.required {
        try idleScript.write(to: managedURL, atomically: true, encoding: .utf8)
        throw BridgeError("A previous script has an indeterminate outcome. Inspect your document, quit CorelDRAW, then run coreldraw-bridge recover BUNDLE_ID. No new script was run.")
    }
    let source = try String(contentsOfFile: path, encoding: .utf8)
    try (managedHeader + source).write(to: managedURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: managedURL.path)
    let ui = CorelAccessibility(pid: process.processIdentifier, timeout: timeout)
    do { result = try ui.run(path: managedURL.path, prefix: args[4], beforeActivation: { try recovery.begin(prefix: args[4], bundleID: bundleID, pid: process.processIdentifier, managedPath: managedURL.path) }) }
    catch { result = ["ok": false, "error": error.localizedDescription] }
    // Ordinary completion leaves an inert script instead of the last drawing mutation.
    try idleScript.write(to: managedURL, atomically: true, encoding: .utf8)
    if ui.responseReceived { try recovery.complete() }
} catch { result = ["ok": false, "error": error.localizedDescription] }
output(result, code: (result["ok"] as? Bool) == true ? 0 : 1)
