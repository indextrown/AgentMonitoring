import Foundation

/// Debug 빌드에서 AgentMonitoring과 앱 내부 상태를 JSON 파일로 교환합니다.
@MainActor
public final class AgentMonitoringDebugBridge: NSObject {
    public typealias StateProvider = () throws -> [String: Any]
    public typealias FixtureApplier = (_ fixtureID: String, _ payload: [String: Any]) throws -> Void

    public static let shared = AgentMonitoringDebugBridge()

#if DEBUG
    private static let maximumRequestBytes = 64 * 1_024
    private static let maximumResponseBytes = 512 * 1_024
    private var timer: Timer?
    private var requestDirectory: URL?
    private var responseDirectory: URL?
    private var stateProvider: StateProvider?
    private var fixtureApplier: FixtureApplier?
#endif

    private override init() {
        super.init()
    }

    /// 요청 폴링을 시작하고 상태 제공자와 fixture 적용자를 연결합니다.
    ///
    /// Release 빌드에서는 아무 파일도 읽거나 쓰지 않습니다.
    ///
    /// - Parameters:
    ///   - stateProvider: 앱의 현재 상태를 JSON dictionary로 반환하는 Debug 전용 closure입니다.
    ///   - fixtureApplier: 식별자와 JSON payload를 받아 테스트 상태를 적용하는 Debug 전용 closure입니다.
    /// - Throws: Debug bridge 디렉터리를 준비하지 못하면 오류를 던집니다.
    public func start(
        stateProvider: StateProvider? = nil,
        fixtureApplier: FixtureApplier? = nil
    ) throws {
#if DEBUG
        stop()
        let fileManager = FileManager.default
        guard let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            throw BridgeError.missingApplicationSupportDirectory
        }
        let root = applicationSupport.appendingPathComponent(
            "AgentMonitoring",
            isDirectory: true
        )
        let requests = root.appendingPathComponent(
            "Requests",
            isDirectory: true
        )
        let responses = root.appendingPathComponent(
            "Responses",
            isDirectory: true
        )
        try fileManager.createDirectory(
            at: requests,
            withIntermediateDirectories: true
        )
        try fileManager.createDirectory(
            at: responses,
            withIntermediateDirectories: true
        )
        self.requestDirectory = requests
        self.responseDirectory = responses
        self.stateProvider = stateProvider
        self.fixtureApplier = fixtureApplier
        pollRequests()
        let timer = Timer(
            timeInterval: 0.2,
            target: self,
            selector: #selector(pollRequests),
            userInfo: nil,
            repeats: true
        )
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
#else
        _ = stateProvider
        _ = fixtureApplier
#endif
    }

    /// Debug bridge의 요청 폴링을 중단합니다.
    public func stop() {
#if DEBUG
        timer?.invalidate()
        timer = nil
        requestDirectory = nil
        responseDirectory = nil
        stateProvider = nil
        fixtureApplier = nil
#endif
    }

#if DEBUG
    @objc
    private func pollRequests() {
        guard let requestDirectory else {
            return
        }
        let files = (try? FileManager.default.contentsOfDirectory(
            at: requestDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        for requestURL in files
            .filter({ $0.pathExtension == "json" })
            .sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            process(requestURL: requestURL)
        }
    }

    /// 요청 파일 하나를 검증하고 fixture 적용 또는 상태 수집 결과를 기록합니다.
    ///
    /// - Parameter requestURL: AgentMonitoring이 앱 sandbox에 작성한 요청 JSON 경로입니다.
    private func process(
        requestURL: URL
    ) {
        let requestID = requestURL.deletingPathExtension().lastPathComponent
        do {
            guard UUID(uuidString: requestID) != nil else {
                throw BridgeError.invalidRequest
            }
            let data = try Data(contentsOf: requestURL)
            guard data.count > 0, data.count <= Self.maximumRequestBytes else {
                throw BridgeError.invalidRequestSize
            }
            guard
                let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                request["schemaVersion"] as? Int == 1,
                request["requestId"] as? String == requestID,
                let createdAtSource = request["createdAt"] as? String,
                let createdAt = ISO8601DateFormatter().date(from: createdAtSource),
                let captureState = request["captureState"] as? Bool
            else {
                throw BridgeError.invalidRequest
            }
            let requestAge = Date().timeIntervalSince(createdAt)
            guard requestAge >= -5, requestAge <= 60 else {
                throw BridgeError.expiredRequest
            }

            var fixtureResult: Any = NSNull()
            if let fixture = request["fixture"] as? [String: Any] {
                guard
                    let fixtureID = fixture["id"] as? String,
                    Self.isValidFixtureID(fixtureID),
                    let payload = fixture["payload"] as? [String: Any],
                    let fixtureApplier
                else {
                    throw BridgeError.fixtureUnavailable
                }
                try fixtureApplier(fixtureID, payload)
                fixtureResult = [
                    "id": fixtureID,
                    "appliedAt": Self.timestamp()
                ]
            } else if !(request["fixture"] is NSNull) {
                throw BridgeError.invalidRequest
            }

            var response: [String: Any] = [
                "schemaVersion": 1,
                "requestId": requestID,
                "completedAt": Self.timestamp(),
                "fixture": fixtureResult
            ]
            if captureState {
                guard let stateProvider else {
                    throw BridgeError.stateProviderUnavailable
                }
                let state = try stateProvider()
                guard JSONSerialization.isValidJSONObject(state) else {
                    throw BridgeError.invalidState
                }
                response["state"] = state
            }
            try write(
                response: response,
                requestID: requestID
            )
        } catch {
            try? write(
                response: [
                    "schemaVersion": 1,
                    "requestId": requestID,
                    "completedAt": Self.timestamp(),
                    "fixture": NSNull(),
                    "error": ["message": Self.bounded(error.localizedDescription)]
                ],
                requestID: requestID
            )
        }
        try? FileManager.default.removeItem(at: requestURL)
    }

    /// 응답 JSON을 UUID 파일명으로 원자적으로 기록합니다.
    ///
    /// - Parameters:
    ///   - response: fixture 결과와 선택적 앱 상태를 담은 JSON dictionary입니다.
    ///   - requestID: 요청과 응답을 연결하는 UUID 문자열입니다.
    /// - Throws: 응답이 JSON이 아니거나 크기 제한을 넘거나 파일 쓰기에 실패하면 오류를 던집니다.
    private func write(
        response: [String: Any],
        requestID: String
    ) throws {
        guard let responseDirectory else {
            throw BridgeError.bridgeNotStarted
        }
        guard JSONSerialization.isValidJSONObject(response) else {
            throw BridgeError.invalidResponse
        }
        let data = try JSONSerialization.data(
            withJSONObject: response,
            options: [.sortedKeys]
        )
        guard data.count > 0, data.count <= Self.maximumResponseBytes else {
            throw BridgeError.invalidResponseSize
        }
        try data.write(
            to: responseDirectory.appendingPathComponent("\(requestID).json"),
            options: [.atomic]
        )
    }

    /// 오류 메시지를 bridge 응답 크기에 맞게 제한합니다.
    ///
    /// - Parameter value: 응답에 기록할 오류 설명입니다.
    /// - Returns: 최대 2,000자로 제한한 문자열입니다.
    private static func bounded(
        _ value: String
    ) -> String {
        String(value.prefix(2_000))
    }

    /// fixture 식별자가 manifest와 같은 안전한 문자 집합을 사용하는지 확인합니다.
    ///
    /// - Parameter value: 검사할 fixture 식별자입니다.
    /// - Returns: 길이와 허용 문자 조건을 모두 만족하면 `true`입니다.
    private static func isValidFixtureID(
        _ value: String
    ) -> Bool {
        guard !value.isEmpty, value.count <= 128 else {
            return false
        }
        return value.utf8.allSatisfy {
            (65...90).contains($0) ||
                (97...122).contains($0) ||
                (48...57).contains($0) ||
                [46, 95, 45].contains($0)
        }
    }

    /// bridge JSON에 사용할 ISO 8601 시각을 만듭니다.
    ///
    /// - Returns: 현재 시각의 ISO 8601 문자열입니다.
    private static func timestamp() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    private enum BridgeError: LocalizedError {
        case missingApplicationSupportDirectory
        case bridgeNotStarted
        case invalidRequest
        case invalidRequestSize
        case expiredRequest
        case fixtureUnavailable
        case stateProviderUnavailable
        case invalidState
        case invalidResponse
        case invalidResponseSize

        var errorDescription: String? {
            switch self {
            case .missingApplicationSupportDirectory:
                "Application Support 디렉터리를 찾을 수 없습니다."
            case .bridgeNotStarted:
                "Debug bridge가 시작되지 않았습니다."
            case .invalidRequest:
                "Debug bridge 요청 계약이 올바르지 않습니다."
            case .invalidRequestSize:
                "Debug bridge 요청 크기가 허용 범위를 벗어났습니다."
            case .expiredRequest:
                "Debug bridge 요청 시각이 허용 범위를 벗어났습니다."
            case .fixtureUnavailable:
                "fixture 적용자가 없거나 fixture payload가 올바르지 않습니다."
            case .stateProviderUnavailable:
                "앱 상태 제공자가 연결되지 않았습니다."
            case .invalidState:
                "앱 상태가 JSON dictionary로 직렬화되지 않습니다."
            case .invalidResponse:
                "Debug bridge 응답을 JSON으로 직렬화할 수 없습니다."
            case .invalidResponseSize:
                "Debug bridge 응답이 512KB 제한을 초과했습니다."
            }
        }
    }
#endif
}
