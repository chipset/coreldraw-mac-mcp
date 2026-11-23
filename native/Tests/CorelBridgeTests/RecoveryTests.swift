import XCTest
@testable import CorelBridge

final class RecoveryTests: XCTestCase {
    func testRecoveryChecksIdentityAndStoppedApplicationBeforeResettingSource() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let script = directory.appendingPathComponent("CodexMCP.js")
        try (ManagedScript.header + "host.CreateDocument();").write(to: script, atomically: true, encoding: .utf8)
        let state = RecoveryState(url: directory.appendingPathComponent("in-flight.json"))
        try state.begin(prefix: "mutation", bundleID: "real.corel", managedPath: script.path)
        XCTAssertThrowsError(try state.recover(bundleID: "wrong.bundle", applicationIsRunning: { _ in false }))
        XCTAssertThrowsError(try state.recover(bundleID: "real.corel", applicationIsRunning: { _ in true }))
        XCTAssertTrue(state.required)
        XCTAssertTrue(try String(contentsOf: script).contains("CreateDocument"))
        try state.recover(bundleID: "real.corel", applicationIsRunning: { _ in false })
        XCTAssertFalse(state.required)
        XCTAssertEqual(try String(contentsOf: script), ManagedScript.idle)
    }

    func testFailedScriptResetRetainsRecoveryRecord() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let script = directory.appendingPathComponent("CodexMCP.js")
        try "unmanaged script".write(to: script, atomically: true, encoding: .utf8)
        let state = RecoveryState(url: directory.appendingPathComponent("in-flight.json"))
        try state.begin(prefix: "mutation", bundleID: "real.corel", managedPath: script.path)
        XCTAssertThrowsError(try state.recover(bundleID: "real.corel", applicationIsRunning: { _ in false }))
        XCTAssertTrue(state.required)
        XCTAssertEqual(try String(contentsOf: script), "unmanaged script")
    }

    func testInterruptedExecutionPersistsAndRejectsReplacement() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let state = RecoveryState(url: directory.appendingPathComponent("in-flight.json"))
        XCTAssertFalse(state.required)
        try state.begin(prefix: "first")
        XCTAssertTrue(RecoveryState(url: state.url).required)
        XCTAssertThrowsError(try state.begin(prefix: "second"))
        let record = try String(contentsOf: state.url)
        XCTAssertTrue(record.contains("first"))
        XCTAssertFalse(record.contains("second"))
        try state.complete()
        XCTAssertFalse(state.required)
    }
}
