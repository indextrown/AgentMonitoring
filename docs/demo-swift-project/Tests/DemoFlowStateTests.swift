import XCTest
@testable import AgentMonitoringDemo

final class DemoFlowStateTests: XCTestCase {
    func testInitialStateIsReady() {
        let state = DemoFlowState()

        XCTAssertEqual(state.message, "")
        XCTAssertFalse(state.isCompleted)
    }

    func testCompleteMarksFlowAsCompleted() {
        var state = DemoFlowState(message: "AgentMonitoring 연결 완료")

        state.complete()

        XCTAssertTrue(state.isCompleted)
        XCTAssertEqual(state.message, "AgentMonitoring 연결 완료")
    }
}
