# AgentMonitoring

> Codex가 로컬 Git 저장소에서 테스트를 설계하고 코드를 구현·검증·리뷰하도록 관리하는 macOS 앱이에요. 최종 변경은 사람이 승인해야 적용돼요.

AgentMonitoring은 코드를 직접 편집하는 IDE가 아니에요. 개발자가 작업 목표와 완료 조건을 입력하면 역할별 Codex 에이전트가 격리된 Git 작업공간(worktree)에서 코드를 작성하고 테스트해요. 사용자는 진행 상황과 최종 코드 변경(diff)을 확인한 뒤 로컬 브랜치에 적용할지 결정해요.

## 한눈에 보는 동작 방식

```text
로컬 Git 저장소 연결
  → 작업 목표와 완료 조건 입력
  → 테스트 설계 → 비평 → 구현 → 검증
  → Swift 계약이 있으면 iOS Simulator에서 앱 실행·identifier UI 조작·증거 수집
  → 코드와 runtime 결과 리뷰
  → 변경 파일과 테스트 결과 확인
  → 사람의 승인 후 현재 로컬 브랜치에 적용
```

AI가 작업을 끝냈다고 바로 원본 코드를 바꾸지는 않아요. AgentMonitoring은 작업별 worktree를 만들고, 테스트와 리뷰를 통과한 변경만 승인 대기 상태로 보내요. 사용자가 승인해야 원본 저장소에 적용해요.

## 현재 제공하는 기능

아래 기능은 UI 데모가 아니라 `pnpm dev`로 실행하는 Electron 앱에서 실제로 동작해요.

| 기능 | 지금 할 수 있는 일 |
| --- | --- |
| ChatGPT 로그인 | Codex app-server로 로그인하고 앱 전용 인증 상태를 관리해요. OpenAI API 키는 필요하지 않아요. |
| 로컬 프로젝트 연결 | 실제 Git 저장소를 등록하고 브랜치, 변경 파일, 언어, 빌드 도구, 테스트 파일을 검사해요. |
| AI 접근성 진단 | 프로젝트가 Code, Build, Run, Observe, Act, Verify 중 어느 영역을 제공하도록 구성됐는지 확인해요. |
| Swift runtime session | 계약을 연결한 Swift 앱을 작업별 worktree에서 빌드해 iPad·iPhone Simulator에 실행하고, identifier 기반 UI 조작과 화면·접근성 증거 수집을 수행해요. |
| 작업 등록 | 구현 목표, 완료 조건, 최대 자가 수정 횟수를 작업별로 저장해요. |
| 다중 역할 실행 | Test Designer, Critic, Implementer, Test Runner, Reviewer를 정해진 순서로 실행해요. |
| 테스트와 자가 수정 | 프로젝트 검증 명령을 실행하고, 실패 원인을 다음 구현 시도에 전달해 정해진 횟수만큼 다시 수정해요. |
| 격리된 코드 변경 | 작업마다 Git worktree와 `agentmonitor/*` 브랜치를 만들고 역할별 읽기·쓰기 권한을 제한해요. |
| 실시간 모니터링 | 진행 상태, 역할별 로그, 테스트 결과, 최근 활동을 대시보드와 작업 상세 화면에서 확인해요. |
| 변경 검토 | 변경 파일, 줄 증감, Git patch, Reviewer finding을 확인하고 작업 폴더를 외부 IDE로 열 수 있어요. |
| 중단과 장애 복구 | 실행을 중단하거나 다시 시작할 수 있어요. 제한 시간을 넘긴 프로세스를 종료하고 앱 재시작 뒤 중단 상태를 복구해요. |
| 사람 승인과 적용 | 승인된 변경만 커밋한 뒤 현재 로컬 브랜치에 fast-forward로 적용해요. 원하지 않는 작업은 폐기할 수 있어요. |
| 기록 관리 | 프로젝트, 작업, 이벤트, 버그, 메모를 SQLite에 저장하고 `⌘K`로 검색해요. |

## 현재 지원 범위

| 항목 | 현재 범위 |
| --- | --- |
| 운영체제 | macOS |
| 사용자와 장비 | 단일 사용자, 단일 Mac |
| AI 작업자 | Codex만 지원 |
| 대상 코드 | 사용자가 연결한 로컬 Git 저장소 |
| 앱 실행·관찰·조작 | iPad 또는 iPhone Simulator 빌드·실행, 화면 캡처, XCTest 접근성 트리 수집, identifier 기반 tap·text 입력을 지원하며 내부 상태 관찰은 아직 지원하지 않음 |
| 변경 반영 | 사람 승인 후 현재 로컬 브랜치에만 적용 |
| 데이터 저장 | 로컬 SQLite와 Git worktree |

내장 코드 편집기, 원격 push·PR 생성·배포, 팀 협업, 여러 AI 공급자, 병렬 작업 스케줄러는 아직 제공하지 않아요. 자세한 제한은 [아직 지원하지 않는 기능](#아직-지원하지-않는-기능)에서 확인할 수 있어요.

![AgentMonitoring 대시보드](./tests/e2e/dashboard.spec.ts-snapshots/dashboard-chromium-desktop-darwin.png)

- [빠르게 시작하기](#빠르게-시작하기)
- [첫 작업 실행하기](#첫-작업-실행하기)
- [에이전트 파이프라인 이해하기](#에이전트-파이프라인-이해하기)
- [실행 안전장치 확인하기](#실행-안전장치-확인하기)
- [개발하고 검증하기](#개발하고-검증하기)

## 빠르게 시작하기

### 준비할 것

- macOS
- Node.js 24 이상
- Git
- Codex CLI
- Swift runtime을 사용할 때는 Xcode와 선택한 기기군의 iPad 또는 iPhone Simulator

터미널에서 `codex` 명령을 실행할 수 있어야 해요. API 키는 필요하지 않아요. 앱을 처음 실행한 뒤 ChatGPT 계정으로 로그인하면 돼요.

### 1. pnpm 준비하기

`pnpm` 명령을 찾을 수 없다면 Corepack과 pnpm 11을 설치하세요.

```bash
npm install --global corepack@0.34.7
corepack enable
corepack install --global pnpm@11.25.0
hash -r
pnpm --version
```

`pnpm --version`이 `11`로 시작하면 준비가 끝난 거예요.

### 2. 앱 실행하기

저장소 루트에서 의존성을 설치하고 Electron 앱을 실행하세요.

```bash
pnpm install
pnpm dev
```

`pnpm install` 과정에서는 Electron 실행 파일을 내려받아요. 실행을 허용한 패키지는 공급망 보호를 위해 `pnpm-workspace.yaml`에 명시해 두었어요.

### 3. ChatGPT로 로그인하기

앱이 열리면 **ChatGPT로 계속**을 누르세요. 브라우저에서 OpenAI 인증을 마치면 앱으로 돌아와 실제 프로젝트를 등록할 수 있어요.

AgentMonitoring은 사용자 전역 `~/.codex` 로그인을 그대로 사용하지 않아요. Electron `userData` 아래에 앱 전용 `CODEX_HOME`을 만들고, Codex app-server의 브라우저 로그인 흐름을 사용해요. Codex가 인증 정보와 토큰 갱신을 관리하며, AgentMonitoring의 SQLite에는 토큰을 저장하지 않아요.

## 첫 작업 실행하기

1. 왼쪽 사이드바에서 **실제 Git 프로젝트 추가**를 누르세요.
2. 작업할 Git 저장소 폴더를 선택하세요.
3. 프로젝트 준비 화면에서 Git 변경 상태와 감지된 기술, 빌드 도구를 확인하세요.
4. 추천 검증 명령을 적용하거나 **프로젝트 설정**에서 직접 입력하세요.
5. **새 작업**을 누르고 목표, 완료 조건, 최대 재시도 횟수를 입력하세요.
6. 작업 상세 화면에서 **실행**을 누르세요.
7. 역할별 로그와 테스트 결과를 확인하세요. Build·Run 계약이 있으면 Swift runtime 상태와 실행 기기가 표시돼요. 선언된 UI 조작 결과와 화면·접근성 증거도 열어볼 수 있어요.
8. 작업이 **승인 대기** 상태가 되면 변경 파일, 줄 증감, Git patch를 검토하세요.
9. 변경이 적절하면 **원본에 적용**을 누르세요. 변경을 사용하지 않으려면 worktree를 폐기하세요.

![프로젝트 준비 상태](./tests/e2e/dashboard.spec.ts-snapshots/project-readiness-chromium-desktop-darwin.png)

**원본에 적용**을 누르면 앱이 작업 브랜치의 변경을 커밋한 뒤 현재 로컬 브랜치에 fast-forward로 반영해요. 원본 저장소에 커밋하지 않은 변경이 있거나 브랜치가 서로 갈라졌다면 적용하지 않아요.

앱은 첫 실행 때 샘플 프로젝트나 활동 기록을 만들지 않아요. 이전 버전의 `is_demo=1` 샘플 레코드는 시작 과정에서 제거하고, 사용자가 만든 실제 프로젝트와 작업 기록은 유지해요.

## AI 접근 범위 선언하기

프로젝트 준비 화면은 AI 접근 범위를 여섯 단계로 나눠 보여줘요.

| 영역 | 의미 | 현재 상태 판단 |
| --- | --- | --- |
| Code | Git이 추적하는 코드를 읽고 수정해요. | 프로젝트를 연결하면 사용 가능 |
| Build | Swift 앱을 빌드해요. | iOS 계약에서 활성화하면 사용 가능 |
| Run | 앱을 Simulator에서 실행해요. | Build와 Run을 활성화하고 선택한 iPad·iPhone Simulator가 있으면 사용 가능 |
| Observe | 화면, 접근성 구조, Debug 상태를 읽어요. | `screen`·`accessibility`는 사용 가능하며 상태 연결은 준비 중 |
| Act | UI를 조작하거나 Debug fixture를 적용해요. | `runtimeScenario.actions`의 identifier 기반 `tap`·`type-text`는 사용 가능하며 fixture 연결은 준비 중 |
| Verify | 등록한 명령으로 테스트를 실행해요. | 검증 명령을 저장하면 사용 가능 |

앱 실행 자동화를 준비하는 Swift 프로젝트는 저장소 루트에 `.agentmonitor/project.json`을 둘 수 있어요.

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
    ]
  }
}
```

이 파일에는 셸 명령을 넣을 수 없어요. 지원하는 adapter와 정해진 capability 값만 선언할 수 있고, 크기도 64KB로 제한해요. 파일이 없더라도 기존 코드 작업과 검증 명령은 그대로 사용할 수 있어요.

`deviceFamily`에는 `"ipad"` 또는 `"iphone"`을 선택할 수 있어요. 기존 manifest와의 호환을 위해 이 필드를 생략하면 `"ipad"`로 동작해요.

Build와 Run이 `true`이면 프로젝트 검증 명령이 통과한 뒤 다음 순서로 실행해요. `act`에 `ui`가 있고 `runtimeScenario.actions`가 있으면 순서대로 조작해요. `observe`에 `screen`이 있으면 조작 후 화면을, `accessibility`가 있으면 조작 후 접근성 트리를 수집해요.

```text
격리 worktree의 Xcode container 확인
  → deviceFamily에 맞는 iPad 또는 iPhone Simulator 선택·부팅
  → 작업 전용 DerivedData에 Debug 앱 빌드
  → bundle identifier와 .app 산출물 검증
  → Simulator 설치·실행
  → 번들된 XCTest driver로 identifier 기반 tap·text 입력 실행
  → action 결과와 최종 접근성 트리를 JSON으로 저장·전달
  → 최종 화면을 PNG로 캡처해 Reviewer에 첨부
  → 기기, bundle identifier, PID를 작업 runtime session에 기록
```

UI action은 최대 20단계이며 `tap`과 `type-text`만 허용해요. 각 단계는 1~30초 안에 정확히 같은 accessibility identifier를 가진 요소가 하나일 때만 실행해요. label·title·화면 좌표나 임의 XCTest 코드는 selector로 받지 않아요. action 실패, 요소 누락, identifier 중복은 runtime 실패로 기록해 잘못된 화면 조작을 중단해요.

선택한 기기군에 사용 가능한 Simulator가 없으면 자동으로 기기를 만들지 않고 작업을 실패 상태로 전환해요. Xcode에서 해당 iPad 또는 iPhone Simulator를 만든 뒤 작업을 다시 실행하세요. 접근성 증거는 identifier, label, title, value, frame, enabled·selected 상태, 하위 요소를 담아요. 내부 Debug 상태 관찰과 fixture 조작은 아직 수행하지 않아요.

접근성 계층은 Apple의 공개 [`XCUIElementSnapshotProviding.snapshot()` API](https://developer.apple.com/documentation/xcuiautomation/xcuielementsnapshotproviding/snapshot())로 수집해요. 이 앱이 대상 프로젝트의 UI-test target을 임의로 수정하지는 않아요.

## 실제 앱과 브라우저 미리보기 구분하기

| 명령 | 용도 | 실제 Git·Codex 연결 |
| --- | --- | --- |
| `pnpm dev` | Electron 데스크톱 앱을 실행해요. | 연결함 |
| `pnpm dev:web` | Electron 없이 UI를 빠르게 확인해요. | 연결하지 않음 |

`pnpm dev:web`은 브라우저 전용 데모예요. 화면 확인을 위한 샘플 데이터와 가상 상호작용만 제공하며, 실제 Git 저장소나 Codex에는 접근하지 않아요. 프로젝트를 등록하고 에이전트를 실행하려면 `pnpm dev`를 사용하세요.

## 에이전트 파이프라인 이해하기

```text
작업 목표와 완료 조건 등록
  → Test Designer가 테스트 추가·보완
  → 읽기 전용 Critic이 테스트 공백 평가
  → Implementer가 기능 구현
  → 프로젝트 검증 명령 실행
      ├─ 실패: 원인을 전달하고 정해진 횟수 안에서 다시 구현
      └─ 성공: Build·Run 계약이 있으면 선택한 iOS Simulator에 앱 실행
          ├─ Act ui 시나리오가 있으면 identifier 기반 UI 조작
          ├─ Observe accessibility 계약이 있으면 최종 접근성 트리 저장
          └─ Observe screen 계약이 있으면 최종 화면 증거 저장
  → 읽기 전용 Reviewer가 코드, runtime 결과, 첨부 화면 검토
  → 사람의 최종 승인 대기
```

| 역할 | 책임 | 코드 수정 |
| --- | --- | --- |
| Test Designer | 성공, 실패, 경계 조건을 검증할 테스트를 만들어요. | 테스트만 수정 |
| Critic | 테스트가 요구사항과 실패 경로를 충분히 검증하는지 평가해요. | 수정하지 않음 |
| Implementer | 테스트와 프로젝트 규칙을 지키며 기능을 구현해요. | 수정함 |
| Test Runner | 프로젝트에 등록된 검증 명령을 실행해요. | 수정하지 않음 |
| Swift Runtime | worktree 앱을 iPad·iPhone Simulator에 실행하고 선언된 identifier UI 조작과 화면·접근성 증거 수집을 수행해요. | 수정하지 않음 |
| Reviewer | 최종 diff와 테스트 결과를 검토하고 심각도별 finding을 남겨요. | 수정하지 않음 |

오케스트레이터는 대규모 언어 모델(LLM)이 아니라 코드로 작성한 상태 머신이에요. AI는 역할별 결과를 만들지만, 허용 상태 전이, 재시도 횟수, sandbox, 최종 승인 여부는 앱이 통제해요. 자세한 경계와 상태 전이는 [아키텍처 문서](./docs/architecture.md)에서 확인할 수 있어요.

## 실행 안전장치 확인하기

### 작업을 원본 저장소와 격리해요

모든 에이전트는 앱이 만든 Git worktree에서 작업해요. 구현 역할은 `workspace-write`, Critic과 Reviewer는 `read-only` sandbox에서 실행해요. 에이전트는 sandbox 우회, commit, push, merge, 배포를 수행하지 않아요.

### 검증 명령을 제한해요

검증 명령은 shell 문자열로 실행하지 않아요. 입력을 실행 파일과 인자로 나눈 뒤 허용 목록에 있는 실행 파일만 직접 실행해요.

```text
pnpm npm npx yarn bun tuist xcodebuild swift cargo go
python python3 pytest make cmake gradle
```

검증 명령이 비어 있으면 작업을 시작하지 않아요. 파이프, redirect, `&&` 같은 shell 문법도 사용할 수 없어요. 실행 파일을 추가하려면 코드의 허용 목록과 보안 테스트를 함께 수정해야 해요.

### Swift runtime 명령을 고정해요

runtime manifest에는 명령 문자열을 넣을 수 없어요. 계약은 에이전트가 수정하는 worktree가 아니라 원본 checkout에서 읽어요. AgentMonitoring이 `/usr/bin/xcrun xcodebuild`, `/usr/bin/xcrun simctl`, `/usr/bin/open`을 고정된 인자 배열로 직접 실행해요. Xcode container는 worktree 내부의 실제 디렉터리여야 하고, 빌드된 `.app`, 화면 PNG, 접근성·조작 JSON도 작업 전용 runtime 경로 안에 있을 때만 사용해요.

### 멈추지 않는 프로세스를 종료해요

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

사용자가 작업을 중단하거나 제한 시간을 넘기면 프로세스 그룹에 `SIGTERM`을 보내요. 3초 안에 종료되지 않으면 `SIGKILL`로 종료해요.

사용자가 중단한 작업은 `stopped`로 남아 다시 실행할 수 있어요. 제한 시간을 넘긴 작업은 `failed`로 전환하고 `task_timed_out` 이벤트와 high finding을 남겨요. 앱을 종료할 때는 실행 중인 Runner를 먼저 정리한 다음 Codex 인증 세션과 SQLite를 닫아요.

### 사람이 마지막 변경을 승인해요

앱은 승인 전에 변경 파일과 Git patch를 보여줘요. 사용자가 **원본에 적용**을 눌러야만 작업 브랜치를 커밋하고 현재 로컬 브랜치에 fast-forward로 적용해요. 자동 commit, 원격 push, PR 생성, 배포는 하지 않아요.

Codex CLI 옵션은 [공식 OpenAI Codex 명령 문서](https://learn.chatgpt.com/docs/developer-commands?surface=cli)를 기준으로 해요.

## 개발하고 검증하기

### 자주 쓰는 명령

| 명령 | 확인하는 것 |
| --- | --- |
| `pnpm typecheck` | TypeScript 타입 오류 |
| `pnpm test` | 상태 전이, 저장소, 프로젝트 검사, Runner 단위·통합 동작 |
| `pnpm test:e2e` | 대시보드 시각 회귀와 주요 사용자 흐름 |
| `pnpm test:package` | macOS 패키지의 preload bridge·XCTest observer·UI action driver |
| `pnpm check` | 타입 검사, 단위 테스트, 웹 프로덕션 빌드 |

시각 기준 이미지를 의도적으로 바꿀 때만 스냅샷을 갱신하세요.

```bash
pnpm exec playwright test --update-snapshots
```

### 프로덕션 번들 만들기

```bash
pnpm build
pnpm package
pnpm test:package
```

`pnpm test:package`는 macOS 앱을 실제로 시작해 sandboxed preload bridge가 연결되는지 확인해요. 접근성 observer와 identifier UI action driver가 앱 번들에 함께 들어갔는지도 검사해요. preload는 Electron 패키지 실행 방식에 맞춰 CommonJS로 따로 빌드해요.

## 기술 구성

| 영역 | 기술 |
| --- | --- |
| 데스크톱 | Electron 44, electron-vite |
| 화면 | React 19, TypeScript, Recharts, Lucide |
| 영속화 | Electron의 Node.js `node:sqlite` |
| 검증 | Vitest, Playwright |
| 에이전트 | Codex CLI 비대화형 JSONL 실행 |
| Swift runtime | Xcode `xcodebuild`, CoreSimulator `simctl` |

## 로컬 데이터와 개인정보

Electron의 `userData` 아래에 다음 데이터를 저장해요.

- `agent-monitoring.sqlite`: 프로젝트, 작업, 이벤트, 버그, 메모, runtime session과 화면 증거 메타데이터
- `worktrees/<project-id>/<task-id>`: 작업별 Git worktree
- `runtime-sessions/<task-id>/DerivedData`: Swift 작업별 빌드 산출물
- `runtime-sessions/<task-id>/evidence/*.png`: 작업별 Simulator 화면 증거
- `runtime-sessions/<task-id>/evidence/*.json`: 작업별 Simulator 접근성 트리와 UI 조작 결과

AgentMonitoring에는 저장소 파일이나 인증 토큰을 별도 클라우드로 전송하는 백엔드가 없어요. Codex 인증 정보는 앱 전용 저장소에 격리하고 SQLite에는 기록하지 않아요. `observe`에 `screen`을 선언하면 캡처한 화면을 Reviewer의 이미지 입력으로, `accessibility`를 선언하면 구조화한 JSON을 Reviewer 프롬프트로 전송해요. UI action 결과에는 입력한 text를 다시 기록하지 않고 kind·identifier·순서·실행 시간만 남겨요. 저장소 코드와 runtime 증거를 포함해 Codex가 처리하는 데이터에는 로그인한 ChatGPT 계정과 조직의 정책이 적용돼요.

## 아직 지원하지 않는 기능

현재 버전은 단일 사용자, 단일 장비, Codex에 집중해요. 다음 기능은 아직 지원하지 않아요.

- 내장 코드 편집기
- 사람 승인 없는 자동 commit·merge
- 원격 push·PR 생성·배포
- 원격 팀 협업
- 여러 공급자 또는 계정 순환
- 병렬 작업 스케줄러
- Simulator Debug 상태 수집과 fixture 조작
- runtime 시나리오 기반 자가 수정 루프
- 앱 자동 업데이트와 코드 서명

## 저장소 정책

이 저장소는 private 사용을 전제로 해요. 실행 로그, SQLite 파일, worktree, 빌드 결과, 환경 파일은 Git에서 제외해요. 실제 서비스 비밀값이나 고객 데이터는 fixture로 커밋하지 않아요.
