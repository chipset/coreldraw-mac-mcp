import Foundation
import Darwin

enum ManagedScript {
    static let header = "// Managed by coreldraw-mcp. Do not edit.\n"
    static let idle = header + "alert('CorelDRAW MCP is idle. Run a tool from your MCP client.');\n"
    static func reset(at url: URL) throws {
        guard try String(contentsOf: url, encoding: .utf8).hasPrefix(header) else {
            throw BridgeError("Managed script ownership changed; recovery record was retained")
        }
        try idle.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

struct RecoveryState {
    let url: URL
    var required: Bool { FileManager.default.fileExists(atPath: url.path) }

    func begin(prefix: String, bundleID: String = "test.bundle", pid: Int32 = 0, managedPath: String = "") throws {
        let data = try JSONSerialization.data(withJSONObject: ["prefix": prefix, "bundleID": bundleID, "pid": pid, "managedPath": managedPath, "startedAt": ISO8601DateFormatter().string(from: Date())])
        let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw BridgeError("Cannot record execution state; recovery may be required") }
        defer { Darwin.close(descriptor) }
        let written = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, data.count) }
        guard written == data.count, fsync(descriptor) == 0 else {
            try? FileManager.default.removeItem(at: url)
            throw BridgeError("Cannot persist execution state")
        }
    }

    func recordedBundleID() throws -> String {
        let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        guard let bundle = value?["bundleID"] as? String, !bundle.isEmpty else {
            throw BridgeError("Recovery record is invalid; quit all CorelDRAW instances before repairing the record")
        }
        return bundle
    }

    // Caller must hold the same cross-process lock used by run.
    func recover(bundleID: String, applicationIsRunning: (String) -> Bool) throws {
        guard required else { return }
        let recordedBundle = try recordedBundleID()
        guard bundleID == recordedBundle else { throw BridgeError("Recovery bundle does not match the recorded CorelDRAW instance") }
        guard !applicationIsRunning(recordedBundle) else {
            throw BridgeError("Quit CorelDRAW after inspecting and saving your documents before recovery. Recovery requires the application to be stopped.")
        }
        let record = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        guard let path = record?["managedPath"] as? String, path.hasPrefix("/"), URL(fileURLWithPath: path).lastPathComponent == "CodexMCP.js" else {
            throw BridgeError("Recovery record has no valid managed script path")
        }
        try ManagedScript.reset(at: URL(fileURLWithPath: path))
        try complete()
    }

    func complete() throws {
        if required { try FileManager.default.removeItem(at: url) }
    }
}
