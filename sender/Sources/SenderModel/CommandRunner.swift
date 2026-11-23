import Foundation
import Darwin

/// Process arguments are passed directly, never through a shell. Output goes to bounded
/// temporary files to avoid stdout/stderr pipe deadlocks while the UI remains responsive.
public enum CommandRunner {
    public static func run(executable: String, arguments: [String], timeout: TimeInterval = 120) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            try runBlocking(executable: executable, arguments: arguments, timeout: timeout)
        }.value
    }
    private static func runBlocking(executable: String, arguments: [String], timeout: TimeInterval) throws -> Data {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("graphtec-command-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer { try? FileManager.default.removeItem(at: directory) }
            let stdout = directory.appendingPathComponent("stdout")
            let stderr = directory.appendingPathComponent("stderr")
            FileManager.default.createFile(atPath: stdout.path, contents: nil, attributes: [.posixPermissions: 0o600])
            FileManager.default.createFile(atPath: stderr.path, contents: nil, attributes: [.posixPermissions: 0o600])
            let out = try FileHandle(forWritingTo: stdout)
            let err = try FileHandle(forWritingTo: stderr)
            defer { try? out.close(); try? err.close() }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            process.standardOutput = out
            process.standardError = err
            process.standardInput = FileHandle.nullDevice
            try process.run()
            let deadline = Date().addingTimeInterval(timeout)
            var failure: String?
            while process.isRunning {
                if Date() > deadline { failure = "Command timed out. No retry was attempted." }
                for file in [stdout, stderr] {
                    if let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size]) as? NSNumber, size.intValue > 4_000_000 { failure = "Command output exceeded the 4 MB limit." }
                }
                if failure != nil {
                    process.terminate()
                    Thread.sleep(forTimeInterval: 0.1)
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                    break
                }
                Thread.sleep(forTimeInterval: 0.05)
            }
            process.waitUntilExit()
            if let failure { throw JobError.invalid(failure) }
            let output = try Data(contentsOf: stdout)
            let errorOutput = try Data(contentsOf: stderr)
            guard output.count <= 4_000_000 && errorOutput.count <= 4_000_000 else { throw JobError.invalid("Command output exceeded the 4 MB limit.") }
            guard process.terminationStatus == 0 else {
                let object = (try? JSONSerialization.jsonObject(with: output)) as? [String: Any]
                let detail = object?["message"] as? String ?? String(data: errorOutput.prefix(4000), encoding: .utf8) ?? ""
                throw JobError.invalid("Command failed (\(process.terminationStatus)). \(detail)")
            }
            return output
    }
}
