import SwiftUI

struct ContentView: View {
    @State private var state = DemoFlowState()

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color.indigo.opacity(0.9), Color.black],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    inputCard

                    if state.isCompleted {
                        completionCard
                    }
                }
                .padding(24)
            }
        }
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("AGENTMONITORING DEMO")
                .font(.caption.weight(.bold))
                .foregroundStyle(.mint)

            Text("AI가 앱을 보고\n직접 검증해요")
                .font(.largeTitle.bold())

            Text("AgentMonitoring이 이 화면을 실행하고, 입력하고, 버튼을 누른 뒤 결과를 확인합니다.")
                .font(.body)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("demo-header")
    }

    private var inputCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("검증할 메시지", systemImage: "text.cursor")
                .font(.headline)

            TextField("메시지를 입력하세요", text: $state.message)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("demo-message")

            Button {
                state.complete()
            } label: {
                Label("Simulator 검증 시작", systemImage: "play.fill")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(.mint)
            .foregroundStyle(.black)
            .accessibilityIdentifier("start-verification")
        }
        .padding(20)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }

    private var completionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("자동 검증이 끝났어요", systemImage: "checkmark.seal.fill")
                .font(.title3.bold())
                .foregroundStyle(.mint)

            Text(state.message.isEmpty ? "입력 없이 실행했습니다." : state.message)
                .foregroundStyle(.secondary)

            Text("화면과 접근성 트리를 실행 보고서에서 확인할 수 있어요.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.mint.opacity(0.12), in: RoundedRectangle(cornerRadius: 24))
        .overlay {
            RoundedRectangle(cornerRadius: 24)
                .stroke(Color.mint.opacity(0.5), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    ContentView()
}
