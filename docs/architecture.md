# AgentMonitoring 아키텍처

## 제품 경계

AgentMonitoring은 IDE나 범용 shell이 아니다. 기존 Git 저장소와 외부 IDE를 유지하면서 AI 작업 실행과 검증 경계를 관리하는 로컬 control plane이다.

```text
React renderer
   │ 타입이 정의된 IPC
   ▼
Electron main
   ├── SQLite event store
   ├── read-only ProjectInspector
   ├── Xcode runtime config detector
   ├── Codex runtime scenario generator
   ├── 작업 상태 머신
   └── AgentRunner
          ├── Git worktree
          ├── Codex app-server auth adapter
          ├── Codex CLI execution adapter
          ├── 허용 목록 기반 test runner
          └── iPad·iPhone Simulator runtime adapter
```

Renderer에는 Node.js 권한이 없다. 파일 선택, 외부 경로 열기, 데이터 변경, 프로세스 실행은 preload가 공개한 제한된 IPC를 통해서만 요청한다.
Sandboxed Electron preload는 패키지 환경에서도 동일하게 로드되도록 CommonJS 진입점으로 빌드하며, 패키지 스모크 테스트가 bridge 연결 신호를 검증한다.

## 프로젝트 준비 상태

작업 이력이 없는 프로젝트를 선택하면 Renderer가 제한된 `project:inspect` IPC를 호출한다. `ProjectInspector`는 Git 명령으로 현재 브랜치, commit, remote, clean/dirty 상태와 tracked 파일 목록을 읽는다. 변경 상태는 폴더 단위로 축약하지 않고 파일별로 수집해 수정·추가·삭제·이름 변경·미추적·충돌로 분류하며, Renderer에는 종류별 개수와 최대 5개의 경로를 제공한다. 파일 확장자와 알려진 manifest 이름만으로 언어·도구·검증 명령 후보를 계산한다.

프로젝트 루트에 `.agentmonitor/project.json`이 있으면 `ProjectCapabilityInspector`가 최대 64KB의 해당 파일만 추가로 읽는다. Zod의 strict schema로 version, iOS Simulator adapter, Xcode container·scheme, iPad·iPhone 기기군, 선언된 capability를 검증하며 임의 명령이나 알 수 없는 필드는 허용하지 않는다. `deviceFamily`를 생략한 기존 계약은 iPad를 기본값으로 사용한다. manifest 자체가 심볼릭 링크이거나 저장소 외부 Xcode container 경로를 가리키면 유효하지 않은 계약으로 처리한다. 오류는 프로젝트 검사 전체를 실패시키지 않고 Renderer에 진단 상태로 전달한다.

manifest가 없으면 `ProjectRuntimeConfigDetector`가 저장소 내부 `.xcworkspace`와 `.xcodeproj`를 찾는다. Git 추적 파일을 먼저 확인하고, 생성 결과가 Git에 없는 프로젝트를 위해 실제 디렉터리도 최대 깊이 4와 최대 2,000개 폴더 안에서 탐색한다. 심볼릭 링크, 숨김 폴더, 빌드 산출물과 의존성 폴더는 건너뛴다. 후보가 여러 개면 Workspace, 루트에 가까운 경로, 이름순으로 하나를 고른다.

Detector는 `xcodebuild -list -json`으로 Scheme을 확인한다. 감지 결과는 `projects.runtime_adapter_json`에 저장하며 기본 기기군은 iPhone이다. Renderer는 Build·Run·Observe·Act가 연결되지 않았을 때 **iOS 자동 연결**을 제공한다. 사용자는 프로젝트 설정에서 container, Scheme, iPhone·iPad 선택을 수정하거나 runtime을 끌 수도 있다. 이 과정은 대상 저장소에 파일을 쓰지 않는다.

Renderer는 다음 상태를 구분한다.

| 상태 | 의미 |
| --- | --- |
| `ready` | 현재 AgentMonitoring이 바로 사용할 수 있다. Code, 저장된 검증 명령, 유효한 iOS 계약의 Build·Run·Observe screen·accessibility·state, 선언형 identifier UI action·Debug fixture·runtime assertion이 해당한다. |
| `declared` | 프로젝트 계약에는 있지만 실행 adapter가 아직 연결되지 않았다. |
| `missing` | 프로젝트에서 선언하거나 설정하지 않았다. |

유효한 iOS 계약이나 자동 감지한 runtime adapter가 있으면 새 작업 화면에서 Simulator 검증을 선택할 수 있다. manifest와 자동 감지 설정이 모두 없거나 사용자가 작업에서 Simulator 검증을 끄면 기존 코드 작업 모드로 동작한다.

검증 명령 후보는 자동 저장하지 않는다. 사용자가 UI에서 후보를 확인하거나 직접 입력해야 `projects.test_command`에 저장된다. 프로젝트 테스트를 선택한 작업에서 검증 명령이 비어 있으면 Runner는 worktree 생성과 Codex 실행 전에 요청을 거절한다. Simulator 전용·수동 검토 작업은 검증 명령 없이 실행할 수 있다.

## 작업별 검증 계획과 시나리오

Renderer는 먼저 `verification-plan:recommend` IPC를 호출할 수 있다. Main process는 Codex를 read-only sandbox에서 실행하고 저장소의 테스트 구조, 프로젝트 검증 명령과 iOS 실행 연결을 근거로 검증 조합을 추천한다. 추천 결과는 실행 지시가 아니라 UI 초안이다. 사용자가 조합과 테스트 설계 방식을 확인한 뒤 작업을 등록해야 한다.

`tasks.verification_plan_json`은 다음 선택을 작업별 스냅샷으로 저장한다.

- 검증 조합: `project-tests`, `simulator-runtime`, `both`, `manual-review`
- 테스트 설계: `automatic`, `swift-testing`, `xctest`, `existing-tests`, `skip`
- Simulator 출처: `task-scenario`, `project-default`, `off`

AgentRunner는 이 계획을 실행 중에 다시 추론하지 않는다. 프로젝트 테스트를 선택했을 때만 Test Designer·Critic과 검증 명령을 실행한다. Simulator 검증을 선택했을 때만 runtime session을 실행한다. `manual-review`는 Implementer와 Reviewer만 실행하고 `awaiting_manual_validation`에서 멈춘다. `verification_result_json`에는 테스트 설계, 프로젝트 테스트, Simulator와 Reviewer의 `pending`, `running`, `passed`, `failed`, `skipped` 상태를 각각 저장한다.

Renderer는 작업 제목과 목표를 `runtime-scenario:generate` IPC로 보낸다. Main process는 앱 전용 `CODEX_HOME`으로 `codex exec`를 read-only sandbox에서 실행한다. JSON Schema가 최종 응답을 UI action과 accessibility assertion으로 제한한다. 생성기는 저장소를 읽을 수 있지만 코드를 수정할 수 없다.

사용자는 생성된 action identifier, 텍스트 입력값, assertion 이름·identifier·예상값을 작업 등록 전에 수정한다. 작업 등록 버튼이 승인 경계다. IPC는 전체 runtime 계약을 strict Zod schema로 다시 검증하고 다음 값을 `tasks`에 저장한다.

- `runtime_contract_json`: adapter, capability, action, assertion을 포함한 승인 스냅샷
- `runtime_scenario_summary`: 사람이 검토할 짧은 목적
- `runtime_scenario_approved_at`: 승인 시각

AgentRunner는 검증 계획이 `task-scenario`일 때 작업별 스냅샷을 사용하고, `project-default`일 때 원본 `project.json`을 사용한다. Test Designer, Implementer, Reviewer 프롬프트에도 같은 계약을 전달한다. Implementer는 제안된 accessibility identifier를 제품 코드에 추가할 수 있지만 승인 스냅샷은 worktree 밖 SQLite에 있으므로 수정할 수 없다. 검증 계획이 없는 기존 작업은 프로젝트 테스트를 실행한 뒤 작업 스냅샷 또는 원본 `project.json`을 읽는 종전 동작을 유지한다.

## 상태 전이

```text
queued → running → testing ─┬→ running
                            ├→ failed
                            └→ awaiting_approval → completed
running ──────────────────────→ awaiting_manual_validation → completed

queued/running/testing → stopped → running
awaiting_approval/awaiting_manual_validation/failed/stopped → discarded
```

`running → completed` 전이는 금지한다. 자동 검증 작업은 `awaiting_approval`, 수동 검토 작업은 `awaiting_manual_validation`에서 멈추고 사람이 승인해야 한다.

## 역할과 권한

| 역할 | sandbox | 변경 권한 | 책임 |
| --- | --- | --- | --- |
| Test Designer | workspace-write | 테스트 | 선택한 작업의 성공·실패·경계 조건 테스트 작성 |
| Critic | read-only | 없음 | 새 테스트 설계를 선택한 작업의 테스트 공백과 약화 가능성 검토 |
| Implementer | workspace-write | 제품 코드 | 목표 구현과 테스트 실패 수정 |
| Test Runner | 직접 실행 | 없음 | 등록된 단일 검증 명령 실행 |
| Swift Runtime | 직접 실행 | 없음 | worktree 앱 빌드, iPad·iPhone Simulator 설치·실행, Debug fixture·identifier UI 조작, 화면·접근성·앱 상태 증거 수집 |
| Reviewer | read-only | 없음 | diff, runtime 화면·접근성 구조, 회귀, 보안, 테스트 공백 보고 |
| Human | UI 승인 | 로컬 Git 적용 | 최종 승인·중단·폐기 |

`maxAttempts`는 최초 구현을 포함한 Implementer 호출 횟수다. 프로젝트 테스트나 runtime assertion이 실패하면 제한된 실패 증거를 다음 Implementer에 전달한다. 자동 검증이 통과해도 Reviewer가 명시적인 finding을 보고하면 같은 시도 한도 안에서 Reviewer 보고와 화면 증거를 다음 Implementer에 전달하고 테스트·runtime·Reviewer를 다시 실행한다. 마지막 시도에도 finding이 남으면 자동으로 승인하거나 실패 처리하지 않고, finding을 유지한 채 사람의 최종 판단을 기다린다.

## Swift runtime session

AgentRunner는 작업별 검증 계획에 Simulator가 포함되고 유효한 Build·Run 계약이 있을 때만 `IosSimulatorRuntimeAdapter`를 호출한다. `both`는 프로젝트 검증 명령이 통과한 뒤 실행하고, `simulator-runtime`은 프로젝트 검증 명령 없이 실행한다. `task-scenario`는 작업 등록 때 사람이 승인한 SQLite 스냅샷을 읽고, `project-default`는 AI가 수정할 수 있는 worktree가 아니라 사용자가 연결한 원본 checkout에서 계약을 읽는다.

```text
작업별 승인 스냅샷 또는 원본 프로젝트 계약 읽기
  → worktree 내부 Xcode container 실경로 확인
  → `simctl list devices available --json`에서 `deviceFamily`에 맞는 iPad 또는 iPhone 선택
  → `simctl bootstatus <udid> -b`
  → 작업별 DerivedData로 `xcodebuild ... build`
  → build settings에서 앱 경로와 bundle identifier 확인
  → `simctl install`
  → `simctl launch --terminate-running-process`
  → Act fixture 계약이 있으면 앱 sandbox에 UUID JSON 요청 작성·응답 검증
  → Act ui 시나리오가 있으면 번들된 UI-test driver 실행
  → 정확히 일치하는 accessibility identifier로 tap·type-text 순차 실행
  → action 결과와 Observe accessibility의 `XCUIApplication.snapshot()` 계층을 JSON으로 저장
  → Observe state 계약이 있으면 UI 조작 후 최종 Debug 상태 응답 저장
  → Observe screen 계약이면 조작 후 `simctl io <udid> screenshot`
  → Verify runtime-scenario 계약이면 assertion별 기대값·실제값 비교와 결과 JSON 저장
  → JSON을 Reviewer 프롬프트로, PNG를 `codex exec --image`로 전달
```

빌드는 `<Electron userData>/runtime-sessions/<task-id>/DerivedData`에 격리한다. `.app` 산출물의 실경로가 이 디렉터리 밖이면 설치하지 않는다. 화면 증거는 같은 session의 `evidence` 디렉터리에 UUID 파일명의 PNG로 저장한다. 일반 파일이고 1 byte 이상 25MB 이하이며 실경로가 evidence 디렉터리 안인 경우에만 기록하고 Reviewer에 첨부한다.

접근성 observer와 UI action driver는 패키지에 포함된 같은 Xcode UI-test target을 session으로 복사한 뒤 실제 bundle identifier, action JSON과 수집 여부를 테스트 plan에 주입해 실행한다. 프로젝트에 UI-test target을 추가하지 않고 앱 코드도 수정하지 않는다.

UI action 계약은 최대 20개의 `tap`·`type-text`만 허용하고 각 action의 대기 시간은 1~30초로 제한한다. XCTest query는 label·title까지 함께 찾는 편의 identifier API 대신 `identifier == ...` predicate를 사용한다. 정확히 일치하는 요소가 없거나 둘 이상이면 조작하지 않고 runtime을 실패시킨다. 결과에는 text를 되돌려 쓰지 않고 action 순서·kind·identifier·소요 시간만 기록한다. marker·base64·JSON schema·bundle identifier뿐 아니라 요청한 action 순서와 결과가 일치하는지도 다시 검증한다.

Debug bridge는 `file-v1` 프로토콜만 허용한다. `simctl get_app_container <udid> <bundle-id> data`로 확인한 앱 data container 안의 `Library/Application Support/AgentMonitoring` 고정 경로만 사용하며 manifest에서 파일 경로를 받지 않는다. Requests와 Responses 디렉터리에 UUID 파일을 쓰고 읽은 뒤 정확한 요청·응답만 제거한다. 요청은 64KB, 응답은 512KB, timeout은 1~30초로 제한하고 일반 파일·sandbox 경계·JSON schema·request ID·fixture ID·필수 state를 호스트에서 다시 검증한다. Swift helper는 요청 시각이 현재와 60초 이상 차이 나는 stale fixture를 적용하지 않는다.

패키지에 포함된 `AgentMonitoringDebugBridge.swift`는 대상 앱의 상태 제공자와 fixture 적용자를 메인 run loop의 200ms 폴링에 연결한다. 상태와 fixture payload는 JSON dictionary로 제한하고, 응답은 임시 파일을 먼저 쓴 뒤 교체하는 Foundation atomic write를 사용한다. 실행 코드는 `#if DEBUG`에만 포함되며 Release의 `start` 호출은 no-op이다.

접근성 계층은 identifier, label, title, value, placeholder, frame, enabled·selected 상태와 children을 최대 5,000개 요소·64단계·512KB로 제한한다. 검증한 결과는 최대 1MB 접근성·Debug state JSON과 최대 256KB action JSON으로 저장한다. Reviewer 입력은 접근성·Debug state 60,000자와 action 20,000자로 제한하고 전체 파일은 로컬 session에 보존한다.

runtime assertion은 작업별 승인 스냅샷이나 원본 checkout의 strict manifest에서 최대 50개를 읽는다. State assertion은 최대 16단계의 문자열·배열 인덱스 path와 `exists`·`equals`·`not-equals`만 지원한다. Accessibility assertion은 정확한 identifier의 존재 여부 또는 제한된 속성만 비교한다. Evidence assertion은 이미 검증해 저장한 화면·접근성·상태·UI action·fixture 결과의 존재만 확인한다. 임의 JSONPath·정규식·스크립트는 실행하지 않는다. 판정 결과에는 전체 state를 복제하지 않고 제한된 기대값·실제값 preview만 기록한다.

runtime assertion이 실패하면 모든 판정과 raw 증거를 먼저 보존하고 실행 중인 앱을 종료한다. 남은 `maxAttempts`가 있으면 최대 120,000자의 제한된 상태·접근성·조작·판정 JSON과 화면 PNG 경로를 다음 workspace-write Implementer 호출에 전달한다. 다음 시도는 프로젝트 검증 명령을 다시 통과한 뒤 새 runtime session에서 동일한 원본 assertion을 평가한다. Build·install·launch·observe처럼 assertion 이전 단계의 실패는 추측성 코드 수정을 막기 위해 자동 Repair하지 않는다.

runtime session은 `preparing`, `booting`, `building`, `installing`, `launching`, `acting`, `observing`, `verifying`, `running`, `failed`, `stopped` 상태를 가지며 기기 UDID·이름, bundle identifier, PID와 마지막 진단을 저장한다. 화면·접근성·UI action·Debug state·fixture·runtime verification 증거 메타데이터는 별도 레코드로 보존해 작업 상세에서 파일을 열 수 있다.

각 Runner 실행은 UUID `run_id`를 하나 만들고 Repair를 포함한 모든 runtime 시도에서 유지한다. 증거 레코드에는 `run_id`, 1부터 시작하는 task `attempt`, `captured|passed|failed` outcome과 최대 1,000자의 요약을 함께 저장한다. Renderer의 순수 집계 함수는 먼저 실행 ID, 그 안에서 시도 번호로 증거를 묶고 최신 판정, 실행·시도·복구·증거 수, 복구 후 통과 여부를 계산한다. 실제 JSON·PNG 내용은 IPC로 읽어 Renderer에 주입하지 않고 기존의 제한된 `openPath` 동작으로만 연다.

기존 SQLite의 `runtime_evidence`에는 앱 시작 시 `run_id`, `attempt`, `outcome`, `summary` 컬럼을 추가한다. 기존 행은 `legacy`, 시도 1, `captured`, 요약 없음으로 보존하므로 이전 증거를 삭제하거나 재해석하지 않는다.

선택한 기기군에 사용 가능한 Simulator가 없으면 기기를 임의로 만들지 않고 명시적인 실패로 처리한다. 화면 캡처나 접근성 observer가 실패해도 runtime 실패로 처리하며 단계와 원인을 기록한다. 실행 중인 관리 대상 앱은 작업 중단·승인·폐기, 프로젝트 제거, 정상 앱 종료 때 `simctl terminate`로 정리한다. 프로젝트 연결을 삭제하면 해당 프로젝트 작업의 정확한 runtime session 경로도 함께 제거한다.

## Git 격리

작업을 처음 실행하면 다음 규칙으로 worktree와 브랜치를 만든다.

```text
branch: agentmonitor/<task-slug>-<task-id-prefix>
path:   <Electron userData>/worktrees/<project-id>/<task-id>
```

Codex와 프로젝트 테스트는 worktree를 `cwd`로 사용하며 원본 checkout을 직접 수정하지 않는다. 사람이 `원본에 적용`을 승인하면 앱은 원본 checkout이 깨끗한지 확인하고, worktree 변경을 작업 브랜치에 커밋한 뒤 현재 로컬 브랜치에 `git merge --ff-only`로 반영한다. 원본이 dirty하거나 브랜치가 분기되었으면 상태를 `awaiting_approval`로 유지하고 적용을 중단한다.

성공한 승인에서는 격리 worktree를 정리하고 작업을 `completed`로 전환한다. 폐기는 `git worktree remove --force <exact-task-path>`만 사용하며 저장소 루트나 광범위한 경로를 대상으로 하지 않는다. 실패·중단 작업은 재실행을 위해 worktree를 유지하고, 사용자가 폐기하면 같은 정리 경로를 사용한다.

앱 시작 시 DB가 가리키는 worktree가 실제로 존재하는지 확인하고, 끊어진 포인터와 앱 관리 경로 안의 고아 디렉터리를 정리한다. 작업 브랜치는 기본적으로 로컬 감사·복구 기록으로 남긴다. 사용자가 저장 공간 화면에서 명시적으로 선택한 경우에만 완료 작업은 `git branch -d`, 폐기 작업은 `git branch -D`로 삭제하며 원격 브랜치는 건드리지 않는다.

작업이 `completed` 또는 `discarded`가 되면 앱 빌드와 접근성 observer의 DerivedData를 즉시 삭제한다. 화면 캡처, 접근성 트리, UI 조작과 인수 검증 결과는 기본 30일 보관하며 사용자는 0·7·30·90일 중 하나를 선택할 수 있다. 재실행할 수 있는 `failed`·`stopped` 작업은 DerivedData와 실행 증거를 자동 삭제하지 않는다. 프로젝트 연결을 삭제할 때는 보관 기간과 관계없이 해당 프로젝트의 runtime 자료를 모두 제거한다.

## 데이터 모델

| 테이블 | 의미 |
| --- | --- |
| `projects` | 로컬 저장소 경로, 검증 명령, 자동 감지하거나 사용자가 수정한 iOS runtime adapter |
| `tasks` | 목표, 상태, 재시도, 브랜치와 worktree, 검증 계획·단계별 결과, 사람이 승인한 runtime 계약 스냅샷 |
| `events` | 모든 관측 가능한 상태 변화와 역할 로그 |
| `findings` | 테스트·실행 실패와 Reviewer 결함 |
| `notes` | 사람의 결정과 프로젝트 문맥 |
| `runtime_sessions` | 작업별 Simulator 단계, 기기, 앱, PID와 진단 |
| `runtime_evidence` | 작업별 실행 ID·시도·판정 결과와 화면·접근성·UI action·Debug state·fixture·runtime verification 증거의 로컬 경로, MIME type, 크기와 생성 시각 |
| `app_settings` | Simulator 실행 기록 보관 기간 등 앱 전체 로컬 설정 |

대시보드의 수치와 최근 활동은 `events`, `tasks`, `findings`에서 계산한다. JSONL 원문 전체 대신 UI에 필요한 redacted 메시지만 최대 길이를 제한해 저장한다.

## 실패 정책

- Codex 프로세스 비정상 종료: 작업을 `failed`로 전환하고 high finding을 등록한다.
- Codex 단계 제한 시간 초과: 역할별 30분 후 프로세스 그룹을 종료하고 작업을 `failed`, 이벤트를 `task_timed_out`으로 기록한다.
- 검증 명령 제한 시간 초과: 45분 후 프로세스 그룹을 종료하고 작업을 `failed`, 이벤트를 `task_timed_out`으로 기록한다.
- Swift runtime 실패: 실패 단계를 session과 `runtime_failed` 이벤트에 기록하고 작업을 `failed`로 전환한다.
- 화면 캡처 실패: `observing` 단계 실패로 기록하고 실행 중인 관리 대상 앱을 정리한다.
- 접근성 트리 수집 실패: marker, base64, JSON schema, bundle identifier, 크기 검증 실패를 `observing` 단계에 기록하고 앱을 정리한다.
- UI action 실패: identifier 누락·중복, timeout, XCTest 조작 실패, 결과 계약 불일치를 `acting` 단계에 기록하고 이후 화면 조작을 중단한다.
- Debug bridge 실패: 앱 container·sandbox 경계·파일 형식·크기·JSON schema·request ID·fixture ID·timeout 검증 실패를 fixture는 `acting`, state는 `observing` 단계에 기록하고 앱을 정리한다.
- Runtime assertion 실패: 모든 assertion 결과 JSON을 먼저 저장하고 앱을 정리한다. 남은 시도가 있으면 `runtime_repair_started` 이벤트와 함께 증거를 다음 Implementer에 전달하고, 마지막 시도라면 `verifying` 단계의 high finding을 기록한다.
- 선택한 iPad·iPhone 기기군이 없음: 새 기기를 만들지 않고 Xcode에서 해당 기기를 준비하도록 안내한다.
- 테스트 실패: 출력 마지막 4,000자를 다음 Implementer에게 전달한다.
- 프로젝트 테스트를 선택했는데 검증 명령이 누락됨: worktree를 만들기 전에 실행을 거절하고 프로젝트 설정으로 안내한다. Simulator 전용·수동 검토 작업에는 검증 명령을 요구하지 않는다.
- 테스트·runtime 검증이 최대 구현 시도 횟수 안에 통과하지 못함: 작업을 `failed`로 전환한다.
- 사용자 중단: 현재 child process에 `SIGTERM`을 보내고 `stopped`로 전환한다.
- 프로세스 종료: macOS와 Linux에서는 격리된 프로세스 그룹에 `SIGTERM`을 보내고 3초 뒤에도 살아 있으면 `SIGKILL`한다.
- 앱 종료: `AgentRunner.dispose()`로 active run의 상태 전이와 이벤트 기록을 마친 다음 Codex 인증 세션과 SQLite를 닫는다.
- 앱 종료·비정상 재시작: 남아 있는 `running`·`testing` 작업과 활성 runtime session을 `stopped`로 전환하고 복구 이벤트를 기록한다. 기존 worktree는 보존해 사용자가 검토하거나 재실행할 수 있다.
- Reviewer 보고: 명시적인 `[critical|high|medium|low] 제목` 행을 finding으로 등록한다. 남은 구현 시도가 있으면 보고를 다음 Implementer에 전달한다. 다음 Reviewer가 문제를 보고하지 않으면 이전 미해결 finding을 해결 처리한다.

## 보안 경계

- `nodeIntegration`은 끄고 `contextIsolation`과 renderer sandbox를 켠다.
- Renderer navigation과 새 창 생성을 차단한다.
- IPC 입력은 Zod schema로 검증한다.
- Codex sandbox 우회 옵션을 사용하지 않는다.
- 검증 명령은 shell을 거치지 않고 허용 목록의 실행 파일만 `spawn`한다.
- Swift runtime은 manifest의 명령을 실행하지 않고 고정된 `/usr/bin/xcrun xcodebuild`, `/usr/bin/xcrun simctl`, `/usr/bin/open`과 인자 배열만 사용한다.
- 새 작업의 runtime 계약은 승인 시점에 SQLite 스냅샷으로 고정하고, 기존 manifest 계약은 원본 checkout에서 읽어 worktree 안의 에이전트 변경으로 실행 권한을 넓힐 수 없게 한다.
- Xcode container는 worktree 내부 실경로, `.app` 산출물은 작업 전용 DerivedData 내부 실경로, 화면·runtime JSON은 작업 전용 evidence 내부 실경로일 때만 허용한다.
- Debug bridge는 `simctl get_app_container`로 확인한 앱 sandbox의 Application Support 고정 하위 경로만 사용하고 manifest에서 임의 경로·명령·코드를 받지 않는다.
- 화면 증거는 Observe screen 계약에서 Reviewer의 `--image` 입력으로, 접근성·Debug state·fixture JSON은 제한된 프롬프트 문맥으로만 전달한다.
- UI action은 승인 스냅샷이나 원본 checkout의 strict manifest에 있는 최대 20개 identifier 기반 action만 실행하며 좌표, label selector, 임의 XCTest·shell 명령은 받지 않는다.
- Runtime verification은 최대 50개의 제한된 state path·접근성 속성·증거 존재 assertion만 평가하며 임의 코드나 표현식을 실행하지 않는다.
- Runtime Repair는 승인 스냅샷이나 원본 checkout의 assertion을 매 시도 다시 읽고 worktree의 manifest 변경을 합격 조건으로 사용하지 않는다.
- 프로젝트 검사는 `git status`, `git log`, `git remote`, `git ls-files`, Xcode container 목록과 고정 경로의 선언형 `.agentmonitor/project.json`만 사용한다. `.env`, Git 무시 파일, 인증 자료와 빌드 산출물 내용은 검사 응답으로 가져오지 않는다.
- 로그에서 일반적인 API token 패턴과 Bearer token을 마스킹한다.
- API 키와 Codex 인증 정보는 데이터베이스에 저장하지 않는다.
- 사용자 전역 `~/.codex`와 분리된 앱 전용 `CODEX_HOME`을 사용한다.
- 로그인은 app-server의 `account/login/start`로 시작하고 `account/login/completed` 알림으로 완료를 확정한다.
- 작업용 `codex exec`에도 같은 전용 `CODEX_HOME`과 ChatGPT 전용 인증 정책을 적용한다.
- 승인 적용은 깨끗한 원본 checkout과 fast-forward 가능 조건을 모두 만족할 때만 수행한다.
- 승인 실패 시 강제 merge, reset, stash 또는 사용자 파일 덮어쓰기를 시도하지 않는다.

## 의도적으로 남긴 제한

- 앱 재시작은 프로세스 실행을 이어받지 않고 안전한 `stopped` 상태에서 사람의 재실행 결정을 기다린다.
- 비정상 종료로 Simulator 앱이 남으면 다음 동일 bundle 실행의 `--terminate-running-process` 또는 사용자의 수동 종료로 정리한다.
- 목표 프로젝트의 고정 인수 테스트를 암호학적으로 잠그지 않는다.
- 앱 패키지 서명과 배포 채널은 구성하지 않았다.
- 분기된 작업 브랜치의 rebase나 충돌 해결은 자동화하지 않는다.

이 제한은 로컬 개인용 MVP에서 허용한다. 팀 사용이나 자동 merge를 추가하기 전에 복구 관리자, approval policy, 테스트 잠금, 서명된 감사 로그를 먼저 설계해야 한다.
