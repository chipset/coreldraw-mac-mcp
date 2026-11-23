import XCTest
@testable import SenderModel

final class JobTests: XCTestCase {
    func fixture() -> [String: Any] {
        ["format": "graphtec-print-cut", "version": 1, "name": "Example", "model": "CE8000",
         "sheet": ["widthMm": 457.2, "heightMm": 609.6],
         "registration": ["type": "type2", "lengthMm": 10, "thicknessMm": 0.5, "gapMm": 20,
                          "frame": ["left": 40, "bottom": 50, "right": 400, "top": 550],
                          "points": [["label": "P1", "x": 400, "y": 50], ["label": "P2", "x": 400, "y": 550], ["label": "P3", "x": 40, "y": 50], ["label": "P4", "x": 40, "y": 550]],
                          "blankingRects": []],
         "placement": ["dxMm": 20, "dyMm": 30], "artworkBounds": ["x": 80, "y": 90, "width": 200, "height": 250],
         "paths": [["sourceId": "1", "closed": true, "points": [["x": 100, "y": 100], ["x": 200, "y": 100], ["x": 200, "y": 200]]]],
         "source": ["documentId": "2", "pageIndex": 1]]
    }
    func decode(_ object: [String: Any]) throws -> CutJob {
        try CutJob.load(JSONSerialization.data(withJSONObject: object))
    }
    func testDecodesJobAndFeedSpans() throws {
        let job = try decode(fixture())
        XCTAssertEqual(job.feedSpanMm, 500)
        XCTAssertEqual(job.crossfeedSpanMm, 360)
        XCTAssertEqual(job.pointCount, 3)
        XCTAssertEqual(job.source.documentId, "2")
    }
    func testAcceptsBackendSourcePageZeroAndBoundedLargeSheet() throws {
        var value = fixture()
        value["source"] = ["documentId": "offline-example", "pageIndex": 0]
        value["sheet"] = ["widthMm": 12_000, "heightMm": 13_000]
        XCTAssertEqual(try decode(value).source.pageIndex, 0)
    }
    func testRejectsUnsupportedVersionAndOpenPaths() throws {
        var value = fixture(); value["version"] = 2
        XCTAssertThrowsError(try decode(value))
        value = fixture(); value["paths"] = [["sourceId": "1", "closed": false, "points": [["x": 100, "y": 100], ["x": 200, "y": 100], ["x": 200, "y": 200]]]]
        XCTAssertThrowsError(try decode(value))
    }
    func testRejectsOversizeDataAndCoordinatesOutsideSheet() throws {
        XCTAssertThrowsError(try CutJob.load(Data(repeating: 32, count: CutJob.maximumBytes + 1)))
        var value = fixture(); value["sheet"] = ["widthMm": -1, "heightMm": 609.6]
        XCTAssertThrowsError(try decode(value))
        value = fixture(); value["paths"] = [["sourceId": "1", "closed": true, "points": [["x": 401, "y": 100], ["x": 200, "y": 100], ["x": 200, "y": 200]]]]
        XCTAssertThrowsError(try decode(value))
    }
    func testRejectsDuplicateRegistrationLabelsAndTooManyPoints() throws {
        var value = fixture(); var registration = value["registration"] as! [String: Any]
        var points = registration["points"] as! [[String: Any]]; points[1]["label"] = "P1"
        registration["points"] = points; value["registration"] = registration
        XCTAssertThrowsError(try decode(value))
        value = fixture(); value["paths"] = [["sourceId": "1", "closed": true, "points": Array(repeating: ["x": 100, "y": 100], count: 4001)]]
        XCTAssertThrowsError(try decode(value))
    }
    func testPreviewFitsSheetAndInvertsVerticalCoordinates() {
        let transform = PreviewTransform(sheetWidth: 400, sheetHeight: 600, width: 600, height: 600, padding: 20)
        XCTAssertEqual(transform.scale, 560.0 / 600.0, accuracy: 0.0001)
        let bottom = transform.project(JobPoint(x: 0, y: 0))
        let top = transform.project(JobPoint(x: 400, y: 600))
        XCTAssertEqual(bottom.y, 580, accuracy: 0.001)
        XCTAssertEqual(top.y, 20, accuracy: 0.001)
        XCTAssertEqual((bottom.x + top.x) / 2, 300, accuracy: 0.001)
    }
}
