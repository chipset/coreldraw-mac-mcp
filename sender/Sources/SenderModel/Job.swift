import Foundation

public enum JobError: LocalizedError {
    case invalid(String)
    public var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}
public struct JobPoint: Decodable, Sendable {
    public let x: Double
    public let y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}
public struct JobRect: Decodable, Sendable { public let x, y, width, height: Double }
public struct JobSheet: Decodable, Sendable { public let widthMm, heightMm: Double }
public struct JobFrame: Decodable, Sendable { public let left, bottom, right, top: Double }
public struct RegistrationPoint: Decodable, Sendable { public let label: String; public let x, y: Double }
public struct JobRegistration: Decodable, Sendable {
    public let type: String
    public let lengthMm, thicknessMm, gapMm: Double
    public let frame: JobFrame
    public let points: [RegistrationPoint]
    public let blankingRects: [JobRect]
}
public struct JobPlacement: Decodable, Sendable { public let dxMm, dyMm: Double }
public struct CutPath: Decodable, Sendable { public let sourceId: String; public let closed: Bool; public let points: [JobPoint] }
public struct JobSource: Decodable, Sendable {
    public let documentId: String
    public let pageIndex: Int
    enum CodingKeys: String, CodingKey { case documentId, pageIndex }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let text = try? container.decode(String.self, forKey: .documentId) { documentId = text }
        else { documentId = String(try container.decode(Int.self, forKey: .documentId)) }
        pageIndex = try container.decode(Int.self, forKey: .pageIndex)
    }
}
public struct CutJob: Decodable, Sendable {
    public static let maximumBytes = 2 * 1024 * 1024
    public let format: String
    public let version: Int
    public let name, model: String
    public let sheet: JobSheet
    public let registration: JobRegistration
    public let placement: JobPlacement
    public let artworkBounds: JobRect
    public let paths: [CutPath]
    public let source: JobSource
    public var feedSpanMm: Double { registration.frame.top - registration.frame.bottom }
    public var crossfeedSpanMm: Double { registration.frame.right - registration.frame.left }
    public var pointCount: Int { paths.reduce(0) { $0 + $1.points.count } }

    public static func load(_ data: Data) throws -> CutJob {
        guard data.count <= maximumBytes else { throw JobError.invalid("Job exceeds the 2 MB preview limit.") }
        let job = try JSONDecoder().decode(CutJob.self, from: data)
        try job.validatePreview()
        return job
    }
    private func validatePreview() throws {
        func require(_ condition: Bool, _ message: String) throws { if !condition { throw JobError.invalid(message) } }
        try require(format == "graphtec-print-cut" && version == 1 && model == "CE8000", "Unsupported job format, version or cutter model.")
        try require(!name.isEmpty && name.utf8.count <= 1024 && source.documentId.utf8.count <= 1024 && source.pageIndex >= 0 && source.pageIndex <= 100_000, "Invalid job name or source.")
        try require(sheet.widthMm.isFinite && sheet.heightMm.isFinite && sheet.widthMm > 0 && sheet.heightMm > 0 && sheet.widthMm <= 50_000 && sheet.heightMm <= 50_000, "Invalid sheet dimensions.")
        let frame = registration.frame
        let scalars = [frame.left, frame.bottom, frame.right, frame.top, registration.lengthMm, registration.thicknessMm, registration.gapMm, placement.dxMm, placement.dyMm]
        try require(scalars.allSatisfy { $0.isFinite && abs($0) <= 1_000_000 }, "Invalid registration or placement coordinates.")
        try require(registration.type == "type2" && (5...20).contains(registration.lengthMm) && (0.3...1).contains(registration.thicknessMm) && registration.gapMm >= 0, "Unsupported registration marks.")
        try require(frame.left >= 0 && frame.bottom >= 0 && frame.right <= sheet.widthMm && frame.top <= sheet.heightMm && frame.right > frame.left && frame.top > frame.bottom, "Registration frame is outside the sheet.")
        try require(registration.points.count == 4 && Set(registration.points.map(\.label)) == Set(["P1", "P2", "P3", "P4"]), "Job requires four unique registration points.")
        let expected = ["P1": JobPoint(x: frame.right, y: frame.bottom), "P2": JobPoint(x: frame.right, y: frame.top), "P3": JobPoint(x: frame.left, y: frame.bottom), "P4": JobPoint(x: frame.left, y: frame.top)]
        for point in registration.points {
            let corner = expected[point.label]!
            try require(point.x.isFinite && point.y.isFinite && abs(point.x - corner.x) < 0.001 && abs(point.y - corner.y) < 0.001, "Registration points do not match the frame.")
        }
        try require(registration.blankingRects.count <= 20, "Too many mark blanking rectangles.")
        for rect in [artworkBounds] + registration.blankingRects {
            try require([rect.x, rect.y, rect.width, rect.height].allSatisfy { $0.isFinite && abs($0) <= 1_000_000 } && rect.width >= 0 && rect.height >= 0, "Invalid artwork or blanking rectangle.")
        }
        try require(!paths.isEmpty && paths.count <= 100 && pointCount <= 4000, "Job must contain 1–100 paths and no more than 4,000 points.")
        for path in paths {
            try require(path.closed && path.points.count >= 3 && path.sourceId.utf8.count <= 1024, "Each cut path must be closed with at least three points.")
            for point in path.points {
                try require(point.x.isFinite && point.y.isFinite && point.x >= frame.left && point.x <= frame.right && point.y >= frame.bottom && point.y <= frame.top, "Cut path is outside the registration frame.")
            }
        }
    }
}
public struct PreviewTransform: Sendable {
    public let scale: Double
    public let originX, originY, sheetHeight: Double
    public init(sheetWidth: Double, sheetHeight: Double, width: Double, height: Double, padding: Double = 30) {
        self.sheetHeight = sheetHeight
        scale = max(0, min((width - padding * 2) / sheetWidth, (height - padding * 2) / sheetHeight))
        originX = (width - sheetWidth * scale) / 2
        originY = (height - sheetHeight * scale) / 2
    }
    public func project(_ point: JobPoint) -> JobPoint {
        JobPoint(x: originX + point.x * scale, y: originY + (sheetHeight - point.y) * scale)
    }
}
