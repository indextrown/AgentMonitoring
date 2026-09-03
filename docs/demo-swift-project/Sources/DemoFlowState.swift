import Foundation

struct DemoFlowState: Equatable {
    var message = ""
    var isCompleted = false

    mutating func complete() {
        isCompleted = true
    }
}
