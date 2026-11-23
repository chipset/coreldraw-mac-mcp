// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GraphtecSender", platforms: [.macOS(.v13)],
    products: [.executable(name: "GraphtecSender", targets: ["GraphtecSender"])],
    targets: [
        .target(name: "SenderModel"),
        .executableTarget(name: "GraphtecSender", dependencies: ["SenderModel"]),
        .testTarget(name: "SenderModelTests", dependencies: ["SenderModel"])
    ]
)
