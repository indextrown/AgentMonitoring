import XCTest

final class AccessibilitySnapshotTests: XCTestCase {
    @MainActor
    func testCaptureAccessibilityTree() throws {
        let environment = ProcessInfo.processInfo.environment
        let bundleIdentifier = try XCTUnwrap(environment["AGENTMONITOR_TARGET_BUNDLE_ID"])
        let application = XCUIApplication(bundleIdentifier: bundleIdentifier)
        application.activate()
        XCTAssertTrue(
            application.wait(for: .runningForeground, timeout: 10),
            "대상 앱이 foreground 상태가 되지 않았습니다."
        )

        let snapshot = try application.snapshot()
        var nodeCount = 0
        var truncated = false
        let root = serialize(
            snapshot,
            depth: 0,
            nodeCount: &nodeCount,
            truncated: &truncated
        )
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "bundleIdentifier": bundleIdentifier,
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
            "root": root,
            "nodeCount": nodeCount,
            "truncated": truncated
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        XCTAssertLessThanOrEqual(
            data.count,
            512 * 1_024,
            "접근성 트리가 512KB 제한을 초과했습니다."
        )
        let encoded = data.base64EncodedString()

        print("AGENTMONITOR_ACCESSIBILITY_BEGIN")
        for offset in stride(from: 0, to: encoded.count, by: 6_000) {
            let start = encoded.index(encoded.startIndex, offsetBy: offset)
            let end = encoded.index(start, offsetBy: min(6_000, encoded.count - offset))
            print(String(encoded[start..<end]))
        }
        print("AGENTMONITOR_ACCESSIBILITY_END")
    }

    /// XCUIElement snapshot을 JSON 직렬화가 가능한 계층 구조로 변환합니다.
    ///
    /// - Parameters:
    ///   - snapshot: 변환할 접근성 요소 snapshot입니다.
    ///   - depth: 현재 요소의 계층 깊이입니다.
    ///   - nodeCount: 지금까지 직렬화한 요소 수입니다.
    ///   - truncated: 안전 제한으로 일부 요소를 생략했는지 나타냅니다.
    /// - Returns: 요소 속성과 하위 요소를 담은 dictionary입니다.
    @MainActor
    private func serialize(
        _ snapshot: any XCUIElementSnapshot,
        depth: Int,
        nodeCount: inout Int,
        truncated: inout Bool
    ) -> [String: Any] {
        guard depth < 64, nodeCount < 5_000 else {
            truncated = true
            return [
                "elementType": "truncated",
                "identifier": "",
                "label": "",
                "title": "",
                "enabled": false,
                "selected": false,
                "frame": ["x": 0, "y": 0, "width": 0, "height": 0],
                "truncated": true,
                "children": []
            ]
        }
        nodeCount += 1
        let frame = snapshot.frame
        var children: [[String: Any]] = []
        for child in snapshot.children {
            children.append(
                serialize(
                    child,
                    depth: depth + 1,
                    nodeCount: &nodeCount,
                    truncated: &truncated
                )
            )
            if nodeCount >= 5_000 {
                truncated = true
                break
            }
        }
        var node: [String: Any] = [
            "elementType": String(describing: snapshot.elementType),
            "identifier": bounded(snapshot.identifier),
            "label": bounded(snapshot.label),
            "title": bounded(snapshot.title),
            "enabled": snapshot.isEnabled,
            "selected": snapshot.isSelected,
            "frame": [
                "x": frame.origin.x,
                "y": frame.origin.y,
                "width": frame.size.width,
                "height": frame.size.height
            ],
            "children": children
        ]
        if let value = snapshot.value {
            node["value"] = bounded(String(describing: value))
        }
        if let placeholderValue = snapshot.placeholderValue {
            node["placeholderValue"] = bounded(placeholderValue)
        }
        return node
    }

    /// 접근성 문자열을 증거 파일의 필드 제한에 맞게 자릅니다.
    ///
    /// - Parameter value: 저장할 접근성 속성 문자열입니다.
    /// - Returns: 최대 2,000자로 제한한 문자열입니다.
    private func bounded(
        _ value: String
    ) -> String {
        String(value.prefix(2_000))
    }
}
