import AppKit
import ApplicationServices

// Resolve controls within the selected CorelDRAW process. Pointer events use current AX bounds.
final class CorelAccessibility {
    let app: AXUIElement
    let deadline: Date
    var runWasPressed = false
    var responseReceived = false

    init(pid: pid_t, timeout: Double) {
        app = AXUIElementCreateApplication(pid)
        deadline = Date().addingTimeInterval(timeout)
        AXUIElementSetMessagingTimeout(app, 2)
    }

    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    func string(_ element: AXUIElement, _ name: String) -> String {
        attribute(element, name) as? String ?? ""
    }

    func children(_ element: AXUIElement) -> [AXUIElement] {
        attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }

    func walk(_ root: AXUIElement, depth: Int = 0, budget: inout Int) -> [AXUIElement] {
        guard depth < 30, budget > 0, Date() < deadline else { return [] }
        budget -= 1
        if string(root, kAXRoleAttribute) == "AXWebArea" { return [root] }
        return [root] + children(root).flatMap { walk($0, depth: depth + 1, budget: &budget) }
    }

    func elements(_ root: AXUIElement? = nil) -> [AXUIElement] {
        var budget = 4000
        return walk(root ?? app, budget: &budget)
    }

    func label(_ element: AXUIElement) -> String {
        let own = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXValueAttribute]
            .map { string(element, $0) }.filter { !$0.isEmpty }.joined(separator: " | ")
        if !own.isEmpty { return own }
        if [kAXRowRole, kAXCellRole].contains(string(element, kAXRoleAttribute)) {
            return elements(element).dropFirst().filter { string($0, kAXRoleAttribute) == kAXStaticTextRole }
                .map { string($0, kAXValueAttribute) }.filter { !$0.isEmpty }.joined(separator: " | ")
        }
        return ""
    }

    func find(_ predicate: (AXUIElement) -> Bool) -> AXUIElement? { elements().first(where: predicate) }

    func wait(_ description: String, _ predicate: () -> AXUIElement?) throws -> AXUIElement {
        while Date() < deadline {
            if let element = predicate() { return element }
            RunLoop.current.run(until: Date().addingTimeInterval(0.12))
        }
        let suffix = runWasPressed ? " Script may already have changed the document; inspect before retrying." : " Script was not run."
        throw BridgeError("Timed out waiting for \(description).\(suffix)")
    }

    func press(_ element: AXUIElement) throws {
        guard (attribute(element, kAXEnabledAttribute) as? Bool) != false else {
            throw BridgeError("CorelDRAW control is disabled: \(label(element))")
        }
        if ProcessInfo.processInfo.environment["CORELDRAW_DEBUG"] == "1" {
            FileHandle.standardError.write(Data("Press \(label(element)) [\(string(element, kAXIdentifierAttribute))]\n".utf8))
        }
        let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard error == .success else { throw BridgeError("Cannot press \(label(element)) (Accessibility \(error.rawValue))") }
    }

    func debug(_ message: String, element: AXUIElement? = nil) {
        guard ProcessInfo.processInfo.environment["CORELDRAW_DEBUG"] == "1" else { return }
        var details = message
        if let element = element {
            var names: CFArray?
            AXUIElementCopyActionNames(element, &names)
            details += " label=\(label(element)) role=\(string(element, kAXRoleAttribute)) actions=\(names as? [String] ?? [])"
            for name in [kAXPositionAttribute, kAXSizeAttribute, kAXSelectedAttribute] {
                details += " \(name)=\(String(describing: attribute(element, name)))"
            }
        }
        FileHandle.standardError.write(Data((details + "\n").utf8))
    }

    func set(_ element: AXUIElement, _ name: String, _ value: CFTypeRef) throws {
        let error = AXUIElementSetAttributeValue(element, name as CFString, value)
        guard error == .success else { throw BridgeError("Cannot set \(name) (Accessibility \(error.rawValue))") }
    }

    func scriptClickPoint(_ element: AXUIElement) throws -> CGPoint {
        guard let position = attribute(element, kAXPositionAttribute),
              let size = attribute(element, kAXSizeAttribute) else { throw BridgeError("Script row has no accessible bounds") }
        var point = CGPoint.zero
        var dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
              AXValueGetValue(size as! AXValue, .cgSize, &dimensions), dimensions.width > 0, dimensions.height > 0 else {
            throw BridgeError("Script row has invalid bounds")
        }
        point.x += min(dimensions.width / 2, 120)
        point.y += dimensions.height / 2
        return point
    }

    func window(of element: AXUIElement) -> AXUIElement? {
        if string(element, kAXRoleAttribute) == kAXWindowRole { return element }
        return attribute(element, kAXWindowAttribute).map { $0 as! AXUIElement }
    }

    func globalHit(at point: CGPoint) -> AXUIElement? {
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success else { return nil }
        return hit
    }

    func visibleScriptRow(_ locate: () -> AXUIElement?) throws -> AXUIElement {
        guard let item = locate(), let intendedWindow = window(of: item) else {
            throw BridgeError("Cannot identify the script row's window. Script was not run.")
        }
        var pid: pid_t = 0
        guard AXUIElementGetPid(app, &pid) == .success else {
            throw BridgeError("Cannot resolve CorelDRAW PID. Script was not run.")
        }
        debug("Raise script window", element: intendedWindow)
        guard AXUIElementPerformAction(intendedWindow, kAXRaiseAction as CFString) == .success else {
            throw BridgeError("Cannot raise the Scripts window. Script was not run.")
        }
        var previousDiagnostic = ""
        return try wait("Scripts window to be visible at the script click point") {
            guard let current = locate(), let currentWindow = self.window(of: current),
                  CFEqual(currentWindow, intendedWindow), let point = try? self.scriptClickPoint(current) else { return nil }
            let hit = self.globalHit(at: point)
            var hitPID: pid_t = 0
            if let hit { AXUIElementGetPid(hit, &hitPID) }
            let hitWindow = hit.flatMap { self.window(of: $0) }
            let sameWindow = hitWindow.map { CFEqual($0, intendedWindow) } ?? false
            let focused = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
            let ready = hitPID == pid && sameWindow && focused
            let diagnostic = "Script click hit x=\(point.x) y=\(point.y) ownerPID=\(hitPID) role=\(hit.map { self.string($0, kAXRoleAttribute) } ?? "none") label=\(hit.map { self.label($0) } ?? "none") intendedWindow=\(self.label(intendedWindow)) actualWindow=\(hitWindow.map { self.label($0) } ?? "none") focused=\(focused) ready=\(ready)"
            if diagnostic != previousDiagnostic { self.debug(diagnostic); previousDiagnostic = diagnostic }
            return ready ? current : nil
        }
    }

    func doubleClick(_ element: AXUIElement) throws {
        let point = try scriptClickPoint(element)
        var pid: pid_t = 0
        guard AXUIElementGetPid(app, &pid) == .success else { throw BridgeError("Cannot resolve CorelDRAW PID") }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            throw BridgeError("CorelDRAW lost focus before script activation")
        }
        debug("Double-click script", element: element)
        for click in 1...2 {
            guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
                throw BridgeError("Cannot create script activation event")
            }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            if click == 1 { RunLoop.current.run(until: Date().addingTimeInterval(0.06)) }
        }
    }

    func scriptRow(named name: String, in section: AXUIElement? = nil) -> AXUIElement? {
        let matches: (AXUIElement) -> Bool = {
            self.string($0, kAXRoleAttribute) == kAXRowRole && self.label($0) == name
        }
        guard let section else { return find(matches) }
        guard (attribute(section, kAXDisclosingAttribute) as? Bool) == true else { return nil }
        // Outline rows need not be AXChildren of the row that discloses them.
        if let disclosed = attribute(section, kAXDisclosedRowsAttribute) as? [AXUIElement],
           let row = disclosed.flatMap({ elements($0) }).first(where: matches) { return row }
        if let row = elements(section).dropFirst().first(where: matches) { return row }
        // Some custom outlines expose hierarchy only through ordered rows and levels.
        var ancestor = attribute(section, kAXParentAttribute).map { $0 as! AXUIElement }
        for _ in 0..<10 {
            guard let current = ancestor else { break }
            if let rows = attribute(current, kAXRowsAttribute) as? [AXUIElement],
               let index = rows.firstIndex(where: { CFEqual($0, section) }),
               let level = attribute(section, kAXDisclosureLevelAttribute) as? NSNumber {
                for row in rows.dropFirst(index + 1) {
                    guard let rowLevel = attribute(row, kAXDisclosureLevelAttribute) as? NSNumber,
                          rowLevel.intValue > level.intValue else { break }
                    if matches(row) { return row }
                }
                return nil
            }
            ancestor = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
        }
        return nil
    }

    @discardableResult
    func expandRow(named name: String, in section: AXUIElement? = nil, refresh: Bool = false) throws -> AXUIElement {
        let row = try wait("\(name) script section") {
            self.scriptRow(named: name, in: section)
        }
        debug("Expanding \(name)", element: row)
        if ProcessInfo.processInfo.environment["CORELDRAW_DEBUG"] == "1" {
            var names: CFArray?
            AXUIElementCopyAttributeNames(row, &names)
            FileHandle.standardError.write(Data("Row attributes: \(names as? [String] ?? [])\n".utf8))
            children(row).forEach { debug("Row child", element: $0) }
        }
        if refresh, (attribute(row, kAXDisclosingAttribute) as? Bool) == true {
            try set(row, kAXDisclosingAttribute, kCFBooleanFalse)
            _ = try wait("\(name) script section to collapse") {
                guard let current = self.scriptRow(named: name, in: section),
                      (self.attribute(current, kAXDisclosingAttribute) as? Bool) == false else { return nil }
                return current
            }
        }
        let current = try wait("\(name) script section") {
            self.scriptRow(named: name, in: section)
        }
        if (attribute(current, kAXDisclosingAttribute) as? Bool) != true {
            try set(current, kAXDisclosingAttribute, kCFBooleanTrue)
        }
        return try wait("\(name) script section to expand") {
            guard let expanded = self.scriptRow(named: name, in: section),
                  (self.attribute(expanded, kAXDisclosingAttribute) as? Bool) == true else { return nil }
            return expanded
        }
    }

    func modal() -> AXUIElement? {
        find { [kAXSheetRole, "AXDialog"].contains(string($0, kAXRoleAttribute)) || (attribute($0, kAXModalAttribute) as? Bool) == true }
    }

    func button(_ name: String, in root: AXUIElement? = nil) -> AXUIElement? {
        elements(root).first {
            string($0, kAXRoleAttribute) == kAXButtonRole &&
            [string($0, kAXTitleAttribute), string($0, kAXDescriptionAttribute), string($0, kAXHelpAttribute)]
                .contains(where: { $0 == name || $0 == name + "..." || $0 == name + "…" })
        }
    }

    func center(_ element: AXUIElement) throws -> CGPoint {
        guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute) else {
            throw BridgeError("Control has no accessible bounds: \(label(element))")
        }
        var point = CGPoint.zero
        var dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions), dimensions.width > 0, dimensions.height > 0 else {
            throw BridgeError("Control has invalid bounds: \(label(element))")
        }
        return CGPoint(x: point.x + dimensions.width / 2, y: point.y + dimensions.height / 2)
    }

    func menuMouse(_ element: AXUIElement, click: Bool) throws {
        let point = try center(element)
        var pid: pid_t = 0
        AXUIElementGetPid(app, &pid)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw BridgeError("CorelDRAW lost focus before menu selection") }
        var hitPID: pid_t = 0
        if let hit = globalHit(at: point) { AXUIElementGetPid(hit, &hitPID) }
        debug("Menu click hit x=\(point.x) y=\(point.y) ownerPID=\(hitPID) expectedPID=\(pid)")
        guard hitPID == pid else { throw BridgeError("CorelDRAW menu is covered or not visible at its click point. Script was not run.") }
        let types: [CGEventType] = click ? [.leftMouseDown, .leftMouseUp] : [.mouseMoved]
        for type in types {
            guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { throw BridgeError("Cannot create menu pointer event") }
            event.post(tap: .cghidEventTap)
        }
    }

    func showScripts() throws {
        if find({ string($0, kAXRoleAttribute) == kAXRowRole && label($0) == "JavaScript" }) != nil { return }
        let menuBar = try wait("CorelDRAW menu bar") {
            self.attribute(self.app, kAXMenuBarAttribute).map { $0 as! AXUIElement }
        }
        guard let window = children(menuBar).first(where: { string($0, kAXTitleAttribute) == "Window" }) else {
            throw BridgeError("English Window menu was not found")
        }
        try press(window)
        debug("Window opened", element: window)
        let inspectors = try wait("Inspectors submenu") {
            self.children(window).flatMap { self.children($0) }.first { self.string($0, kAXTitleAttribute) == "Inspectors" }
        }
        debug("Inspectors found", element: inspectors)
        try menuMouse(inspectors, click: false)
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        // Corel's custom menu returns success for AXPress while leaving the wrong
        // inspector active. Click the live menu item using its current AX bounds.
        let command = try wait("Scripts menu item") {
            self.children(inspectors).flatMap { self.children($0) }.first { self.string($0, kAXTitleAttribute) == "Scripts" }
        }
        debug("Scripts found", element: command)
        try menuMouse(command, click: true)
    }

    func run(path: String, prefix: String, beforeActivation: () throws -> Void = {}) throws -> [String: Any] {
        guard modal() == nil else { throw BridgeError("CorelDRAW has an unrelated modal dialog. Close it before running a script.") }
        try showScripts()
        // CorelDRAW 2021 exposes script rows but not its custom Load/Run toolbar buttons.
        // Refreshing User Scripts discovers the managed script and re-reads its contents.
        let javascript = try expandRow(named: "JavaScript")
        let userScripts = try expandRow(named: "User Scripts", in: javascript, refresh: true)
        _ = try wait("CodexMCP script row") {
            self.scriptRow(named: "CodexMCP", in: userScripts)
        }
        let item = try visibleScriptRow { self.scriptRow(named: "CodexMCP", in: userScripts) }
        guard Date() < deadline else { throw BridgeError("Deadline expired before script activation. Script was not run.") }
        _ = try center(item)
        var pid: pid_t = 0
        guard AXUIElementGetPid(app, &pid) == .success,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            throw BridgeError("CorelDRAW lost focus before script activation. Script was not run.")
        }
        try beforeActivation()
        runWasPressed = true
        try doubleClick(item) // Exactly one double-click; never retry activation.
        var response: [String: Any]?
        var parseFailure: Error?
        let responseElement = try wait("matching script response") {
            for element in self.elements() {
                for name in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
                    do {
                        if let parsed = try ScriptResponse.parse(self.string(element, name), prefix: prefix) {
                            self.responseReceived = true
                            response = parsed
                            return element
                        }
                    } catch { parseFailure = error; return element }
                }
            }
            return nil
        }
        _ = responseElement
        // Only dismiss the dialog that contains the exact response marker, never another alert.
        if let dialog = modal(), elements(dialog).contains(where: { element in
            [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute].contains { string(element, $0).hasPrefix(prefix) }
        }), let ok = button("OK", in: dialog) { try press(ok) }
        if let error = parseFailure { throw error }
        guard let result = response else { throw BridgeError("No matching script response") }
        return result
    }
}
