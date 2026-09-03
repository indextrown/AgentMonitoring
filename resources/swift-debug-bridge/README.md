# Swift Debug bridge

`AgentMonitoringDebugBridge.swift`를 대상 iOS 앱 target에 추가하고 Debug 상태 제공자와 fixture 적용자를 연결하세요. 실제 프로덕션 사용자 데이터나 인증 토큰은 상태에 포함하지 마세요.

```swift
#if DEBUG
try? AgentMonitoringDebugBridge.shared.start(
    stateProvider: {
        [
            "route": appStore.route.debugName,
            "selectedVesselID": appStore.selectedVesselID ?? "",
            "isNavigating": appStore.isNavigating
        ]
    },
    fixtureApplier: { fixtureID, payload in
        try appStore.applyDebugFixture(
            id: fixtureID,
            payload: payload
        )
    }
)
#endif
```

bridge는 iOS 앱 sandbox의 `Library/Application Support/AgentMonitoring` 아래에서 UUID 요청과 응답만 교환해요. AgentMonitoring은 응답을 수집한 뒤 해당 파일을 제거해요. Release 빌드에서 `start` 호출은 아무 작업도 하지 않아요.
