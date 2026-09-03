# AgentMonitoring

> 로컬 Git 저장소에서 Codex의 구현·테스트·앱 실행·자가 수정을 관리하고, 사람이 최종 변경을 승인하는 macOS control plane이에요.

AgentMonitoring은 코드를 직접 편집하는 IDE가 아니에요. 기존 IDE와 Git 작업 방식을 유지하면서, 역할별 Codex 에이전트가 격리된 작업공간에서 코드를 수정하고 검증하도록 관리해요.

Swift 프로젝트에 runtime 계약을 추가하면 코드뿐 아니라 iPhone·iPad Simulator의 화면, 접근성 트리, Debug 상태까지 AI가 확인할 수 있어요. AI는 선언된 UI를 조작하고 테스트 실패를 수정한 뒤, 모든 시도의 코드와 실행 증거를 사람에게 보고해요.

## 30초 만에 이해하기

| 단계 | AgentMonitoring이 하는 일 |
| --- | --- |
| 준비 | 로컬 Git 저장소, 작업 목표, 완료 조건을 받아요. Swift 앱은 선택적으로 runtime 계약을 연결해요. |
| 실행 | Test Designer, Critic, Implementer, Test Runner, Reviewer를 순서대로 실행해요. 모든 코드 변경은 작업별 Git worktree에서 이뤄져요. |
| 앱 검증 | 선언한 경우 iPhone·iPad Simulator에서 앱을 빌드하고 실행해요. 화면·접근성·Debug 상태를 수집하고 fixture와 UI 조작을 실행해요. |
| 자가 수정 | 프로젝트 테스트나 runtime assertion이 실패하면 실패 로그와 증거를 다음 구현 시도에 전달해요. 정해진 횟수 안에서 다시 구현하고 검증해요. |
| 승인 | 변경 파일, Git patch, 테스트 결과, 시도별 runtime 증거를 보여줘요. 사람이 승인해야 현재 로컬 브랜치에 적용해요. |

```text
로컬 Git 저장소 연결
  → 목표와 완료 조건 등록
  → 테스트 설계 → 비평 → 구현 → 프로젝트 테스트
  → 선택한 Simulator에서 앱 실행·조작·관찰·판정
  → 실패 증거를 바탕으로 자가 수정
  → 코드와 실행 보고서 리뷰
  → 사람 승인 후 현재 로컬 브랜치에 적용
```

![AgentMonitoring 대시보드](./tests/e2e/dashboard.spec.ts-snapshots/dashboard-chromium-desktop-darwin.png)

- [빠르게 시작하기](#빠르게-시작하기)
- [첫 작업 실행하기](#첫-작업-실행하기)
- [Swift 앱 연결하기](#swift-앱-연결하기)
- [에이전트 역할](#에이전트-역할)
- [실행 안전장치](#실행-안전장치)
- [개발하고 검증하기](#개발하고-검증하기)

## 지금 제공하는 기능

아래 기능은 UI 목업이 아니라 `pnpm dev`로 실행하는 Electron 앱에서 실제로 동작해요.

### 프로젝트와 계정

- Codex app-server를 통한 ChatGPT 로그인
- 로컬 Git 저장소 등록과 브랜치·변경 파일·언어·빌드 도구 검사
- Code, Build, Run, Observe, Act, Verify 기준의 AI 접근성 진단
- 프로젝트, 작업, 이벤트, 버그, 메모의 로컬 SQLite 저장과 `⌘K` 검색

### 에이전트 실행

- Test Designer, Critic, Implementer, Test Runner, Reviewer 역할 분리
- 작업별 Git worktree와 `agentmonitor/*` 브랜치 생성
- 역할별 읽기·쓰기 권한 제한
- 실시간 상태, 역할별 로그, 테스트 결과, 최근 활동 표시
- 중단·재실행, 제한 시간 초과 처리, 앱 재시작 뒤 안전한 상태 복구

### Swift 앱 runtime

- iPhone 또는 iPad Simulator 선택
- worktree의 Swift 앱 빌드·설치·실행
- 최종 화면 PNG와 XCTest 접근성 트리 수집
- accessibility identifier 기반 `tap`·`type-text`
- Debug bridge를 통한 앱 상태 조회와 fixture 적용
- 선언형 runtime assertion 판정
- 실패 증거를 이용한 제한된 자가 수정
- 실행 ID와 시도별 화면·접근성·조작·상태·판정 보고서

### 검토와 적용

- 변경 파일, 줄 증감, Git patch, Reviewer finding 표시
- 작업 worktree를 외부 IDE로 열기
- 승인된 변경만 현재 로컬 브랜치에 fast-forward 적용
- 필요 없는 작업과 worktree 폐기

## 현재 지원 범위

| 항목 | 지원 범위 |
| --- | --- |
| 운영체제 | macOS |
| 사용자와 장비 | 단일 사용자, 단일 Mac |
| AI 작업자 | Codex |
| 대상 코드 | 사용자가 연결한 로컬 Git 저장소 |
| Swift 앱 | iPhone·iPad Simulator의 Debug 빌드 |
| 변경 반영 | 사람 승인 후 현재 로컬 브랜치에만 적용 |
| 데이터 저장 | 로컬 SQLite, Git worktree, runtime 증거 파일 |

AgentMonitoring은 내장 코드 편집기, 원격 배포 도구, 자동 merge 서비스가 아니에요. 현재 제한은 [아직 지원하지 않는 기능](#아직-지원하지-않는-기능)에서 확인할 수 있어요.

## 빠르게 시작하기

### 준비할 것

- macOS
- Node.js 24 이상
- Git
- Codex CLI
- Swift runtime을 사용할 때는 Xcode와 iPhone 또는 iPad Simulator

터미널에서 `codex` 명령을 실행할 수 있어야 해요. OpenAI API 키는 필요하지 않아요.

### 1. pnpm 준비하기

`pnpm` 명령을 찾을 수 없다면 Corepack과 pnpm 11을 설치하세요.

```bash
npm install --global corepack@0.34.7
corepack enable
corepack install --global pnpm@11.25.0
hash -r
pnpm --version
```

`pnpm --version`이 `11`로 시작하면 준비가 끝나요.

### 2. 실제 앱 실행하기

저장소 루트에서 의존성을 설치하고 Electron 앱을 실행하세요.

```bash
pnpm install
pnpm dev
```

`pnpm install`은 Electron 실행 파일을 내려받아요. 실행을 허용한 패키지는 공급망 보호를 위해 `pnpm-workspace.yaml`에 명시했어요.

### 3. ChatGPT로 로그인하기

앱이 열리면 **ChatGPT로 계속**을 누르세요. 브라우저에서 OpenAI 인증을 마치면 앱으로 돌아와 실제 프로젝트를 등록할 수 있어요.

AgentMonitoring은 사용자 전역 `~/.codex` 로그인을 그대로 사용하지 않아요. Electron `userData` 아래에 앱 전용 `CODEX_HOME`을 만들고 Codex app-server의 브라우저 로그인 흐름을 사용해요. Codex가 인증 정보와 토큰 갱신을 관리하며, AgentMonitoring의 SQLite에는 토큰을 저장하지 않아요.

### 브라우저 미리보기와 구분하기

| 명령 | 용도 | 실제 Git·Codex 연결 |
| --- | --- | --- |
| `pnpm dev` | Electron 데스크톱 앱 실행 | 연결함 |
| `pnpm dev:web` | 브라우저에서 UI만 미리보기 | 연결하지 않음 |

`pnpm dev:web`은 샘플 데이터와 가상 상호작용을 사용하는 UI 데모예요. 실제 프로젝트를 등록하고 에이전트를 실행하려면 `pnpm dev`를 사용하세요.

## 첫 작업 실행하기

1. 왼쪽 사이드바에서 **실제 Git 프로젝트 추가**를 누르세요.
2. 작업할 Git 저장소 폴더를 선택하세요.
3. 프로젝트 준비 화면에서 Git 상태와 감지된 언어·빌드 도구를 확인하세요.
4. 추천 검증 명령을 적용하거나 **프로젝트 설정**에서 직접 입력하세요.
5. **새 작업**을 누르고 목표, 완료 조건, 최대 재시도 횟수를 입력하세요.
6. 작업 상세 화면에서 **실행**을 누르세요.
7. 역할별 로그, 테스트 결과, runtime 실행 보고서를 확인하세요.
8. 작업이 **승인 대기** 상태가 되면 변경 파일과 Git patch를 검토하세요.
9. 변경이 적절하면 **원본에 적용**을 누르세요. 사용하지 않으려면 worktree를 폐기하세요.

![프로젝트 준비 상태](./tests/e2e/dashboard.spec.ts-snapshots/project-readiness-chromium-desktop-darwin.png)

**원본에 적용**을 누르면 앱이 작업 브랜치의 변경을 커밋하고 현재 로컬 브랜치에 fast-forward로 반영해요. 원본 저장소에 커밋하지 않은 변경이 있거나 두 브랜치가 갈라졌다면 적용하지 않아요.

앱은 첫 실행 때 샘플 프로젝트나 활동 기록을 만들지 않아요. 이전 버전의 `is_demo=1` 샘플 레코드는 시작 과정에서 제거하고 사용자가 만든 기록은 유지해요.

## Swift 앱 연결하기

Swift runtime은 선택 기능이에요. `.agentmonitor/project.json`이 없어도 코드 구현과 프로젝트 검증 명령은 그대로 사용할 수 있어요.

앱 실행까지 자동화하려면 대상 저장소 루트에 `.agentmonitor/project.json`을 추가하세요. 아래 예시는 iPhone Simulator에서 앱을 실행하고, UI를 한 번 조작한 뒤 화면과 접근성 상태를 검증해요.

```json
{
  "version": 1,
  "adapter": {
    "kind": "ios-simulator",
    "container": "PopPang.xcworkspace",
    "scheme": "PopPang",
    "configuration": "Debug",
    "deviceFamily": "iphone"
  },
  "capabilities": {
    "build": true,
    "run": true,
    "observe": ["screen", "accessibility"],
    "act": ["ui"],
    "verify": ["test-command", "runtime-scenario"]
  },
  "runtimeScenario": {
    "actions": [
      {
        "kind": "tap",
        "identifier": "start-navigation",
        "timeoutSeconds": 10
      }
    ],
    "assertions": [
      {
        "kind": "accessibility",
        "identifier": "start-navigation",
        "property": "enabled",
        "expected": true
      },
      {
        "kind": "evidence",
        "target": "screen"
      }
    ]
  }
}
```

`container`와 `scheme`을 실제 프로젝트 값으로 바꾸세요. `deviceFamily`는 `"iphone"` 또는 `"ipad"`를 받아요. 이 값을 생략하면 기존 manifest와의 호환을 위해 `"ipad"`를 사용해요.

### 앱 내부 상태와 fixture 연결하기

화면 밖의 상태를 검증하거나 테스트 데이터를 주입하려면 Debug bridge를 연결하세요.

1. [`AgentMonitoringDebugBridge.swift`](./resources/swift-debug-bridge/AgentMonitoringDebugBridge.swift)를 대상 앱 target에 추가하세요.
2. 상태 제공자와 fixture 적용자를 연결하세요.
3. manifest에 `debugBridge`를 선언하세요.
4. `observe`에 `state`, `act`에 `fixture`를 추가하세요.

연결 코드는 [Swift Debug bridge 안내](./resources/swift-debug-bridge/README.md)에서 확인할 수 있어요. Release 빌드에서 bridge의 `start` 호출은 아무 작업도 하지 않아요.

<details>
<summary>Debug 상태·fixture·텍스트 입력을 포함한 전체 manifest 예시</summary>

```json
{
  "version": 1,
  "adapter": {
    "kind": "ios-simulator",
    "container": "PopPang.xcworkspace",
    "scheme": "PopPang",
    "configuration": "Debug",
    "deviceFamily": "iphone"
  },
  "capabilities": {
    "build": true,
    "run": true,
    "observe": ["screen", "accessibility", "state"],
    "act": ["ui", "fixture"],
    "verify": ["test-command", "runtime-scenario"]
  },
  "debugBridge": {
    "protocol": "file-v1",
    "responseTimeoutSeconds": 10
  },
  "runtimeScenario": {
    "actions": [
      {
        "kind": "tap",
        "identifier": "start-navigation",
        "timeoutSeconds": 10
      },
      {
        "kind": "type-text",
        "identifier": "destination-search",
        "text": "부산항",
        "timeoutSeconds": 10
      }
    ],
    "fixture": {
      "id": "signed-in-home",
      "payload": {
        "accountID": "fixture-user",
        "selectedTab": "home"
      }
    },
    "assertions": [
      {
        "kind": "state",
        "name": "홈 탭 유지",
        "path": ["selectedTab"],
        "operator": "equals",
        "expected": "home"
      },
      {
        "kind": "accessibility",
        "identifier": "start-navigation",
        "property": "enabled",
        "expected": true
      },
      {
        "kind": "evidence",
        "target": "screen"
      }
    ]
  }
}
```

</details>

### runtime에서 확인할 수 있는 영역

| 영역 | 선언 | 결과 |
| --- | --- | --- |
| Build | `capabilities.build` | worktree의 Swift 앱을 Debug로 빌드해요. |
| Run | `capabilities.run` | 선택한 iPhone·iPad Simulator에 설치하고 실행해요. |
| Observe screen | `observe: ["screen"]` | 최종 화면을 PNG로 저장해요. |
| Observe accessibility | `observe: ["accessibility"]` | identifier, label, value, frame, enabled·selected 상태와 하위 요소를 JSON으로 저장해요. |
| Observe state | `observe: ["state"]` | Debug bridge가 제공한 앱 내부 상태를 JSON으로 저장해요. |
| Act ui | `act: ["ui"]` | identifier가 정확히 일치하는 요소를 tap하거나 text를 입력해요. |
| Act fixture | `act: ["fixture"]` | Debug bridge를 통해 선언한 fixture를 적용해요. |
| Verify | `verify: ["runtime-scenario"]` | state·accessibility·증거 존재 assertion을 판정해요. |

manifest는 최대 64KB의 strict JSON이에요. 셸 명령, 알 수 없는 필드, 저장소 밖 Xcode container는 허용하지 않아요.

UI action은 최대 20개까지 선언할 수 있어요. `tap`과 `type-text`만 지원하며 각 action의 제한 시간은 1~30초예요. accessibility identifier가 없거나 둘 이상이면 조작을 멈추고 runtime을 실패로 기록해요. 좌표, label·title selector, 임의 XCTest 코드는 받지 않아요.

runtime assertion은 최대 50개까지 선언할 수 있어요. `state`는 제한된 path에 `exists`·`equals`·`not-equals`를 적용해요. `accessibility`는 정확한 identifier의 존재 여부나 제한된 속성을 비교해요. `evidence`는 화면·접근성·상태·UI 조작·fixture 결과가 실제로 만들어졌는지 확인해요. JSONPath, 정규식, JavaScript, shell은 실행하지 않아요.

상태 제공자에는 화면·이동·선택 상태처럼 검증에 필요한 값만 넣으세요. 인증 토큰과 고객 데이터는 넣지 마세요.

## 검증·자가 수정·보고 흐름

```text
프로젝트 검증 명령 실행
  ├─ 실패: 로그를 Implementer에게 전달하고 다시 구현
  └─ 성공: 원본 checkout의 runtime 계약 읽기
      → 선택한 Simulator 부팅
      → worktree 앱 빌드·설치·실행
      → fixture 적용 → UI 조작
      → Debug 상태·접근성 트리·화면 수집
      → runtime assertion 판정
          ├─ 실패·재시도 가능: 모든 증거를 보존하고 다시 구현
          ├─ 마지막 시도 실패: high finding과 함께 작업 종료
          └─ 통과: Reviewer 실행
```

Runtime Repair는 매 시도마다 원본 checkout의 assertion을 다시 읽어요. Implementer가 worktree의 합격 조건을 수정하거나 약화할 수 없어요. 빌드·설치·실행·관찰 단계의 실패는 추측성 수정을 막기 위해 자동 Repair하지 않고 즉시 진단해요.

작업 상세의 실행 보고서는 증거를 실행 ID와 시도 번호로 묶어요. 각 시도를 펼치면 당시 화면 PNG와 접근성·UI 조작·Debug 상태·runtime 판정 JSON을 열 수 있어요. 실패 뒤 다음 시도가 통과하면 **복구 후 통과**로 표시하고 이전 실패 증거도 보존해요.

![시도별 runtime 실행 보고서](./tests/e2e/dashboard.spec.ts-snapshots/runtime-report-chromium-desktop-darwin.png)

## 에이전트 역할

| 역할 | 책임 | 코드 수정 |
| --- | --- | --- |
| Test Designer | 성공·실패·경계 조건을 검증할 테스트를 만들어요. | 테스트만 수정 |
| Critic | 테스트가 요구사항과 실패 경로를 충분히 검증하는지 평가해요. | 수정하지 않음 |
| Implementer | 테스트와 프로젝트 규칙에 맞춰 기능을 구현하고 실패를 수정해요. | 제품 코드 수정 |
| Test Runner | 프로젝트에 등록한 검증 명령을 실행해요. | 수정하지 않음 |
| Swift Runtime | 앱을 실행·조작·관찰하고 assertion을 판정해요. | 수정하지 않음 |
| Reviewer | 최종 diff, 테스트, runtime 증거를 검토하고 finding을 남겨요. | 수정하지 않음 |

오케스트레이터는 대규모 언어 모델(LLM)이 아니라 코드로 작성한 상태 머신이에요. AI는 역할별 결과를 만들지만, 상태 전이, 재시도 횟수, sandbox, 최종 승인 여부는 앱이 통제해요. 자세한 구조는 [아키텍처 문서](./docs/architecture.md)에서 확인할 수 있어요.

## 실행 안전장치

### 원본 저장소와 격리해요

모든 에이전트는 앱이 만든 Git worktree에서 작업해요. 구현 역할은 `workspace-write`, Critic과 Reviewer는 `read-only` sandbox에서 실행해요. 에이전트는 sandbox 우회, commit, push, merge, 배포를 수행하지 않아요.

### 실행할 명령을 제한해요

검증 명령은 shell 문자열로 실행하지 않아요. 입력을 실행 파일과 인자로 나눈 뒤 아래 허용 목록에 있는 실행 파일만 직접 실행해요.

```text
pnpm npm npx yarn bun tuist xcodebuild swift cargo go
python python3 pytest make cmake gradle
```

검증 명령이 비어 있으면 작업을 시작하지 않아요. 파이프, redirect, `&&` 같은 shell 문법도 사용할 수 없어요.

Swift runtime manifest에는 명령 문자열을 넣을 수 없어요. AgentMonitoring은 고정된 `/usr/bin/xcrun xcodebuild`, `/usr/bin/xcrun simctl`, `/usr/bin/open`과 인자 배열만 실행해요. 계약은 AI가 수정할 수 없는 원본 checkout에서 읽어요.

### 사람이 마지막 변경을 승인해요

앱은 승인 전에 변경 파일과 Git patch를 보여줘요. 사용자가 **원본에 적용**을 눌러야 작업 브랜치를 커밋하고 현재 로컬 브랜치에 fast-forward로 적용해요. 자동 commit, 원격 push, PR 생성, 배포는 하지 않아요.

<details>
<summary>프로세스별 제한 시간</summary>

| 대상 | 제한 시간 |
| --- | --- |
| Codex 역할별 실행 | 30분 |
| 프로젝트 검증 명령 | 45분 |
| Simulator 조회·창 열기 | 30초 |
| iOS Simulator 부팅 | 5분 |
| Swift 앱 빌드 | 30분 |
| 앱 설치 | 2분 |
| 앱 실행 | 1분 |
| 화면 캡처 | 30초 |
| UI 조작·접근성 트리 수집 | 5분 |

</details>

사용자가 작업을 중단하거나 제한 시간을 넘기면 프로세스 그룹에 `SIGTERM`을 보내요. 3초 안에 종료되지 않으면 `SIGKILL`로 종료해요. 사용자가 중단한 작업은 `stopped`로 남아 다시 실행할 수 있어요.

Codex CLI 옵션은 [공식 OpenAI Codex 명령 문서](https://learn.chatgpt.com/docs/developer-commands?surface=cli)를 기준으로 해요.

## 로컬 데이터와 개인정보

Electron의 `userData` 아래에 다음 데이터를 저장해요.

| 경로 | 저장 내용 |
| --- | --- |
| `agent-monitoring.sqlite` | 프로젝트, 작업, 이벤트, 버그, 메모, runtime session과 증거 메타데이터 |
| `worktrees/<project-id>/<task-id>` | 작업별 Git worktree |
| `runtime-sessions/<task-id>/DerivedData` | Swift 작업별 빌드 산출물 |
| `runtime-sessions/<task-id>/evidence/*.png` | Simulator 화면 증거 |
| `runtime-sessions/<task-id>/evidence/*.json` | 접근성, UI 조작, Debug 상태·fixture, runtime 판정 증거 |

AgentMonitoring에는 저장소 파일이나 인증 토큰을 별도 클라우드로 보내는 백엔드가 없어요. Codex 인증 정보는 앱 전용 저장소에 격리하고 SQLite에 기록하지 않아요.

화면은 Reviewer의 이미지 입력으로 전송해요. 접근성·Debug 상태·fixture 결과는 길이를 제한해 Reviewer 프롬프트에 전달해요. UI action 결과에는 입력한 text를 다시 기록하지 않아요. 저장소 코드와 runtime 증거를 포함해 Codex가 처리하는 데이터에는 로그인한 ChatGPT 계정과 조직의 정책이 적용돼요.

## 개발하고 검증하기

| 명령 | 확인하는 것 |
| --- | --- |
| `pnpm typecheck` | TypeScript 타입 오류 |
| `pnpm test` | 상태 전이, 저장소, 프로젝트 검사, Runner 단위·통합 동작 |
| `pnpm test:e2e` | 대시보드 시각 회귀와 주요 사용자 흐름 |
| `pnpm test:package` | 패키지의 preload bridge·XCTest 도구·Swift Debug bridge |
| `pnpm check` | 타입 검사, 단위 테스트, 웹 프로덕션 빌드 |

시각 기준 이미지를 의도적으로 바꿀 때만 스냅샷을 갱신하세요.

```bash
pnpm exec playwright test --update-snapshots
```

프로덕션 번들은 아래 명령으로 만들고 검사할 수 있어요.

```bash
pnpm build
pnpm package
pnpm test:package
```

`pnpm test:package`는 macOS 앱을 실제로 시작해 sandboxed preload bridge와 번들된 iOS runtime 도구를 검사해요.

## 기술 구성

| 영역 | 기술 |
| --- | --- |
| 데스크톱 | Electron 44, electron-vite |
| 화면 | React 19, TypeScript, Recharts, Lucide |
| 영속화 | Electron의 Node.js `node:sqlite` |
| 검증 | Vitest, Playwright |
| 에이전트 | Codex CLI 비대화형 JSONL 실행 |
| Swift runtime | Xcode `xcodebuild`, CoreSimulator `simctl` |

## 아직 지원하지 않는 기능

- 내장 코드 편집기
- 사람 승인 없는 자동 commit·merge
- 원격 push·PR 생성·배포
- 원격 팀 협업
- 여러 AI 공급자 또는 계정 순환
- 병렬 작업 스케줄러
- 앱 자동 업데이트와 코드 서명

## 저장소 정책

이 저장소는 private 사용을 전제로 해요. 실행 로그, SQLite 파일, worktree, 빌드 결과, 환경 파일은 Git에서 제외해요. 실제 서비스 비밀값이나 고객 데이터는 fixture로 커밋하지 않아요.
