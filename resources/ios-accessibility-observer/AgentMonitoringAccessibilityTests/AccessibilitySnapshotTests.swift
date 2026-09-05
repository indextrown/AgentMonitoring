import XCTest

private struct RuntimeUIAction: Decodable {
    enum Kind: String, Decodable {
        case tap
        case typeText = "type-text"
    }

    let kind: Kind
    let identifier: String
    let text: String?
    let timeoutSeconds: Double
}

private struct RuntimeAccessibilityAssertion: Decodable {
    enum Property: String, Decodable {
        case exists
        case label
        case title
        case value
        case placeholderValue
        case elementType
        case enabled
        case selected
    }

    enum Expected: Decodable {
        case boolean(Bool)
        case string(String)

        /// JSON의 boolean 또는 string 예상값을 읽습니다.
        ///
        /// - Parameter decoder: assertion 예상값을 제공하는 decoder입니다.
        /// - Throws: 지원하지 않는 JSON 값이면 decoding 오류를 던집니다.
        init(
            from decoder: any Decoder
        ) throws {
            let container = try decoder.singleValueContainer()
            if let value = try? container.decode(Bool.self) {
                self = .boolean(value)
                return
            }
            self = .string(try container.decode(String.self))
        }
    }

    let identifier: String
    let property: Property
    let expected: Expected
}

private enum AutomationConfigurationError: LocalizedError {
    case invalidActions
    case tooManyActions
    case oversizedPayload

    var errorDescription: String? {
        switch self {
        case .invalidActions:
            "UI action 설정을 해석할 수 없습니다."
        case .tooManyActions:
            "UI action은 최대 20단계까지 실행할 수 있습니다."
        case .oversizedPayload:
            "runtime 증거가 허용 크기를 초과했습니다."
        }
    }
}

final class AccessibilitySnapshotTests: XCTestCase {
    @MainActor
    func testRunRuntimeAutomation() throws {
        let environment = ProcessInfo.processInfo.environment
        let bundleIdentifier = try XCTUnwrap(environment["AGENTMONITOR_TARGET_BUNDLE_ID"])
        let application = XCUIApplication(bundleIdentifier: bundleIdentifier)
        application.activate()
        XCTAssertTrue(
            application.wait(for: .runningForeground, timeout: 10),
            "대상 앱이 foreground 상태가 되지 않았습니다."
        )

        let actions = try decodeActions(environment: environment)
        let assertions = try decodeAssertions(environment: environment)
        var results: [[String: Any]] = []
        var failure: [String: Any]?
        for (index, action) in actions.enumerated() {
            let startedAt = Date()
            let succeeded = perform(
                action: action,
                index: index,
                application: application
            )
            if !succeeded {
                failure = [
                    "index": index,
                    "kind": action.kind.rawValue,
                    "identifier": action.identifier,
                    "completedActionCount": results.count,
                    "message": "UI action \(index + 1): identifier '\(action.identifier)' 요소를 찾지 못했거나 중복됐습니다."
                ]
                break
            }
            results.append([
                "index": index,
                "kind": action.kind.rawValue,
                "identifier": action.identifier,
                "durationMilliseconds": Date().timeIntervalSince(startedAt) * 1_000
            ])
        }

        if failure == nil, !assertions.isEmpty {
            _ = waitForAssertions(
                assertions,
                application: application,
                timeout: 15
            )
        }

        if !actions.isEmpty && failure == nil {
            try emit(
                payload: [
                    "schemaVersion": 1,
                    "bundleIdentifier": bundleIdentifier,
                    "executedAt": ISO8601DateFormatter().string(from: Date()),
                    "actionCount": actions.count,
                    "results": results
                ],
                beginMarker: "AGENTMONITOR_UI_ACTIONS_BEGIN",
                endMarker: "AGENTMONITOR_UI_ACTIONS_END",
                maximumBytes: 128 * 1_024
            )
        }

        if environment["AGENTMONITOR_CAPTURE_ACCESSIBILITY"] == "1" || failure != nil {
            let snapshot = try application.snapshot()
            var nodeCount = 0
            var truncated = false
            let root = serialize(
                snapshot,
                depth: 0,
                nodeCount: &nodeCount,
                truncated: &truncated
            )
            try emit(
                payload: [
                    "schemaVersion": 1,
                    "bundleIdentifier": bundleIdentifier,
                    "capturedAt": ISO8601DateFormatter().string(from: Date()),
                    "root": root,
                    "nodeCount": nodeCount,
                    "truncated": truncated
                ],
                beginMarker: "AGENTMONITOR_ACCESSIBILITY_BEGIN",
                endMarker: "AGENTMONITOR_ACCESSIBILITY_END",
                maximumBytes: 512 * 1_024
            )
        }
        if let failure {
            try emit(
                payload: [
                    "schemaVersion": 1,
                    "bundleIdentifier": bundleIdentifier,
                    "failedAt": ISO8601DateFormatter().string(from: Date()),
                    "failure": failure,
                    "completedActions": results
                ],
                beginMarker: "AGENTMONITOR_UI_FAILURE_BEGIN",
                endMarker: "AGENTMONITOR_UI_FAILURE_END",
                maximumBytes: 128 * 1_024
            )
        }
    }

    /// 환경 변수에 포함된 base64 JSON을 UI action 목록으로 변환합니다.
    ///
    /// - Parameter environment: XCTest process에 전달된 환경 변수입니다.
    /// - Returns: 순서대로 실행할 identifier 기반 UI action 목록입니다.
    /// - Throws: payload가 없거나 손상됐거나 허용 개수를 초과하면 오류를 던집니다.
    private func decodeActions(
        environment: [String: String]
    ) throws -> [RuntimeUIAction] {
        guard
            let encoded = environment["AGENTMONITOR_UI_ACTIONS_BASE64"],
            let data = Data(base64Encoded: encoded),
            let actions = try? JSONDecoder().decode([RuntimeUIAction].self, from: data)
        else {
            throw AutomationConfigurationError.invalidActions
        }
        guard actions.count <= 20 else {
            throw AutomationConfigurationError.tooManyActions
        }
        return actions
    }

    /// 환경 변수의 승인된 접근성 조건을 안정 상태 대기 목록으로 변환합니다.
    ///
    /// - Parameter environment: XCTest process에 전달된 환경 변수입니다.
    /// - Returns: 최종 접근성 스냅샷 전에 기다릴 assertion 목록입니다.
    /// - Throws: payload가 없거나 손상되면 decoding 오류를 던집니다.
    private func decodeAssertions(
        environment: [String: String]
    ) throws -> [RuntimeAccessibilityAssertion] {
        guard
            let encoded = environment["AGENTMONITOR_ACCESSIBILITY_ASSERTIONS_BASE64"],
            let data = Data(base64Encoded: encoded)
        else {
            throw AutomationConfigurationError.invalidActions
        }
        return try JSONDecoder().decode([RuntimeAccessibilityAssertion].self, from: data)
    }

    /// 승인된 접근성 조건이 모두 충족되거나 제한 시간이 끝날 때까지 UI 갱신을 기다립니다.
    ///
    /// - Parameters:
    ///   - assertions: 안정 상태로 판단할 접근성 조건입니다.
    ///   - application: 조건을 조회할 실행 중인 앱입니다.
    ///   - timeout: 기다릴 최대 초입니다.
    /// - Returns: 제한 시간 안에 모든 조건이 충족됐으면 `true`입니다.
    @MainActor
    private func waitForAssertions(
        _ assertions: [RuntimeAccessibilityAssertion],
        application: XCUIApplication,
        timeout: TimeInterval
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if assertions.allSatisfy({ matches(assertion: $0, application: application) }) {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        } while Date() < deadline
        return assertions.allSatisfy { matches(assertion: $0, application: application) }
    }

    /// 현재 UI 요소가 하나의 접근성 조건을 만족하는지 확인합니다.
    ///
    /// - Parameters:
    ///   - assertion: 확인할 identifier, 속성, 예상값입니다.
    ///   - application: 요소를 조회할 실행 중인 앱입니다.
    /// - Returns: 현재 UI 상태가 예상값과 같으면 `true`입니다.
    @MainActor
    private func matches(
        assertion: RuntimeAccessibilityAssertion,
        application: XCUIApplication
    ) -> Bool {
        let identifierPredicate = NSPredicate(format: "identifier == %@", assertion.identifier)
        let identifierQuery = application.descendants(matching: .any).matching(identifierPredicate)
        let labelPredicate = NSPredicate(format: "label == %@", assertion.identifier)
        let query = identifierQuery.count > 0
            ? identifierQuery
            : application.descendants(matching: .any).matching(labelPredicate)
        let element = query.firstMatch
        if assertion.property == .exists, case let .boolean(expected) = assertion.expected {
            return element.exists == expected
        }
        guard query.count == 1, element.exists else { return false }
        switch (assertion.property, assertion.expected) {
        case let (.enabled, .boolean(expected)):
            return element.isEnabled == expected
        case let (.selected, .boolean(expected)):
            return element.isSelected == expected
        case let (.label, .string(expected)):
            return element.label == expected
        case let (.title, .string(expected)):
            return element.title == expected
        case let (.value, .string(expected)):
            return String(describing: element.value ?? "") == expected
        case let (.placeholderValue, .string(expected)):
            return element.placeholderValue == expected
        case let (.elementType, .string(expected)):
            return String(describing: element.elementType) == expected
        default:
            return false
        }
    }

    /// 정확히 일치하는 accessibility identifier 요소 하나에 action을 수행합니다.
    ///
    /// - Parameters:
    ///   - action: 실행할 tap 또는 type-text action입니다.
    ///   - index: 오류 메시지와 결과에 사용할 0부터 시작하는 action 순서입니다.
    ///   - application: 요소를 조회하고 조작할 실행 중인 앱입니다.
    /// - Returns: action을 안전하게 완료했으면 `true`, 요소를 찾지 못했거나 중복이면 `false`입니다.
    @MainActor
    private func perform(
        action: RuntimeUIAction,
        index: Int,
        application: XCUIApplication
    ) -> Bool {
        let identifierPredicate = NSPredicate(format: "identifier == %@", action.identifier)
        let identifierQuery = application.descendants(matching: .any).matching(identifierPredicate)
        let labelPredicate = NSPredicate(format: "label == %@", action.identifier)
        let query = identifierQuery.count > 0
            ? identifierQuery
            : application.descendants(matching: .any).matching(labelPredicate)
        let element = query.firstMatch
        guard element.waitForExistence(timeout: action.timeoutSeconds) else {
            XCTFail("UI action \(index + 1): identifier '\(action.identifier)' 요소를 찾지 못했습니다.")
            return false
        }
        let matchCount = query.count
        guard matchCount == 1 else {
            XCTFail("UI action \(index + 1): identifier '\(action.identifier)' 요소가 \(matchCount)개여서 조작을 중단했습니다.")
            return false
        }

        switch action.kind {
        case .tap:
            element.tap()
        case .typeText:
            guard let text = action.text else {
                XCTFail("UI action \(index + 1): type-text에 text가 없습니다.")
                return false
            }
            element.tap()
            element.typeText(text)
        }
        return true
    }

    /// JSON payload를 크기 제한 안에서 marker로 구분된 base64 로그로 출력합니다.
    ///
    /// - Parameters:
    ///   - payload: JSON으로 직렬화할 runtime 결과입니다.
    ///   - beginMarker: payload 시작을 알리는 고정 marker입니다.
    ///   - endMarker: payload 끝을 알리는 고정 marker입니다.
    ///   - maximumBytes: JSON payload에 허용할 최대 byte 수입니다.
    /// - Throws: JSON 직렬화에 실패하거나 payload가 허용 크기를 초과하면 오류를 던집니다.
    private func emit(
        payload: [String: Any],
        beginMarker: String,
        endMarker: String,
        maximumBytes: Int
    ) throws {
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        guard data.count <= maximumBytes else {
            throw AutomationConfigurationError.oversizedPayload
        }
        let encoded = data.base64EncodedString()
        print(beginMarker)
        for offset in stride(from: 0, to: encoded.count, by: 6_000) {
            let start = encoded.index(encoded.startIndex, offsetBy: offset)
            let end = encoded.index(start, offsetBy: min(6_000, encoded.count - offset))
            print(String(encoded[start..<end]))
        }
        print(endMarker)
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
