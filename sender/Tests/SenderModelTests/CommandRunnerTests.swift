import XCTest
@testable import SenderModel

final class CommandRunnerTests: XCTestCase {
    func testReturnsOutputWithoutShellInterpolation() async throws {
        let output = try await CommandRunner.run(executable: "/usr/bin/printf", arguments: ["%s", "{\"value\":\"$(touch never)\"}"])
        XCTAssertEqual(String(data: output, encoding: .utf8), "{\"value\":\"$(touch never)\"}")
    }
    func testNonzeroExitIncludesCLIError() async {
        do {
            _ = try await CommandRunner.run(executable: "/usr/bin/false", arguments: [])
            XCTFail("A failed command must throw")
        } catch { XCTAssertTrue(error.localizedDescription.contains("1")) }
    }
    func testStopsTimedOutProcessWithoutRetry() async {
        do {
            _ = try await CommandRunner.run(executable: "/bin/sleep", arguments: ["5"], timeout: 0.05)
            XCTFail("A timed-out command must throw")
        } catch { XCTAssertTrue(error.localizedDescription.contains("timed out")) }
    }
}
