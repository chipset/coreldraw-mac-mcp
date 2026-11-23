// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "CorelBridge", platforms: [.macOS(.v13)], products: [.executable(name: "coreldraw-bridge", targets: ["CorelBridge"])], targets: [.executableTarget(name: "CorelBridge"), .testTarget(name: "CorelBridgeTests", dependencies: ["CorelBridge"])])
