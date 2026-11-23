import XCTest
@testable import CorelBridge

final class ResponseTests: XCTestCase {
    func testOnlyExactRequestPrefixIsAccepted() throws {
        XCTAssertNil(try ScriptResponse.parse("Other alert", prefix: "MCP_123:"))
        XCTAssertNil(try ScriptResponse.parse("MCP_OLD:{\"ok\":true}", prefix: "MCP_123:"))
        XCTAssertNil(try ScriptResponse.parse("leading MCP_123:{\"ok\":true}", prefix: "MCP_123:"))
        let result = try XCTUnwrap(ScriptResponse.parse("MCP_123:{\"ok\":true,\"result\":{\"name\":\"café\"}}", prefix: "MCP_123:"))
        XCTAssertEqual((result["result"] as? [String: String])?["name"], "café")
    }
    func testScriptFailureRemainsFailure() throws {
        let result = try XCTUnwrap(ScriptResponse.parse("MCP_123:{\"ok\":false,\"error\":\"No active document\"}", prefix: "MCP_123:"))
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertEqual(result["error"] as? String, "No active document")
    }
    func testMalformedOrOversizedPayloadDoesNotBecomeSuccess() {
        XCTAssertThrowsError(try ScriptResponse.parse("MCP_123:bad", prefix: "MCP_123:"))
        XCTAssertThrowsError(try ScriptResponse.parse("MCP_123:{\"result\":1}", prefix: "MCP_123:"))
        XCTAssertThrowsError(try ScriptResponse.parse("MCP_123:{\"ok\":true}", prefix: "MCP_123:", limit: 4))
    }
}
