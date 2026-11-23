import Foundation

struct BridgeError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

enum ScriptResponse {
    static func parse(_ text: String, prefix: String, limit: Int = 262_144) throws -> [String: Any]? {
        guard text.hasPrefix(prefix) else { return nil }
        let data = Data(text.dropFirst(prefix.count).utf8)
        guard data.count <= limit else { throw BridgeError("Script response exceeds the 256 KiB limit") }
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ok = value["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID() else {
            throw BridgeError("Script returned an invalid response envelope")
        }
        return value
    }
}
