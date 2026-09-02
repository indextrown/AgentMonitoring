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
   ├── 작업 상태 머신
   └── AgentRunner
          ├── Git worktree
          ├── Codex app-server auth adapter
          ├── Codex CLI execution adapter
          └── 허용 목록 기반 test runner
```

Renderer에는 Node.js 권한이 없다. 파일 선택, 외부 경로 열기, 데이터 변경, 프로세스 실행은 preload가 공개한 제한된 IPC를 통해서만 요청한다.
Sandboxed Electron preload는 패키지 환경에서도 동일하게 로드되도록 CommonJS 진입점으로 빌드하며, 패키지 스모크 테스트가 bridge 연결 신호를 검증한다.

## 프로젝트 준비 상태

작업 이력이 없는 프로젝트를 선택하면 Renderer가 제한된 `project:inspect` IPC를 호출한다. `ProjectInspector`는 Git 명령으로 현재 브랜치, commit, remote, clean/dirty 상태와 tracked 파일 목록을 읽는다. 변경 상태는 폴더 단위로 축약하지 않고 파일별로 수집해 수정·추가·삭제·이름 변경·미추적·충돌로 분류하며, Renderer에는 종류별 개수와 최대 5개의 경로를 제공한다. 파일 확장자와 알려진 manifest 이름만으로 언어·도구·검증 명령 후보를 계산하며 소스나 설정 파일 내용을 앱으로 가져오지 않는다.

검증 명령 후보는 자동 저장하지 않는다. 사용자가 UI에서 후보를 확인하거나 직접 입력해야 `projects.test_command`에 저장된다. 검증 명령이 비어 있으면 Runner는 worktree 생성과 Codex 실행 전에 요청을 거절한다.

## 상태 전이

```text
queued → running → testing ─┬→ running
                            ├→ failed
                            └→ awaiting_approval → completed

queued/running/testing → stopped → running
awaiting_approval/failed/stopped → discarded
```

`running → completed` 전이는 금지한다. 자동 단계는 반드시 `awaiting_approval`에서 멈추고 사람이 승인해야 한다.

## 역할과 권한

| 역할 | sandbox | 변경 권한 | 책임 |
| --- | --- | --- | --- |
| Test Designer | workspace-write | 테스트 | 성공·실패·경계 조건 테스트 작성 |
| Critic | read-only | 없음 | 테스트 공백과 약화 가능성 검토 |
| Implementer | workspace-write | 제품 코드 | 목표 구현과 테스트 실패 수정 |
| Test Runner | 직접 실행 | 없음 | 등록된 단일 검증 명령 실행 |
| Reviewer | read-only | 없음 | diff, 회귀, 보안, 테스트 공백 보고 |
| Human | UI 승인 | 로컬 Git 적용 | 최종 승인·중단·폐기 |

## Git 격리

작업을 처음 실행하면 다음 규칙으로 worktree와 브랜치를 만든다.

```text
branch: agentmonitor/<task-slug>-<task-id-prefix>
path:   <Electron userData>/worktrees/<project-id>/<task-id>
```

Codex와 프로젝트 테스트는 worktree를 `cwd`로 사용하며 원본 checkout을 직접 수정하지 않는다. 사람이 `원본에 적용`을 승인하면 앱은 원본 checkout이 깨끗한지 확인하고, worktree 변경을 작업 브랜치에 커밋한 뒤 현재 로컬 브랜치에 `git merge --ff-only`로 반영한다. 원본이 dirty하거나 브랜치가 분기되었으면 상태를 `awaiting_approval`로 유지하고 적용을 중단한다.

성공한 승인에서는 격리 worktree를 정리하고 작업을 `completed`로 전환한다. 폐기는 `git worktree remove --force <exact-task-path>`만 사용하며 저장소 루트나 광범위한 경로를 대상으로 하지 않는다. 작업 브랜치는 승인 후에도 로컬 감사 기록으로 남기며 원격 push는 수행하지 않는다.

## 데이터 모델

| 테이블 | 의미 |
| --- | --- |
| `projects` | 로컬 저장소 경로와 검증 명령 |
| `tasks` | 목표, 상태, 재시도, 브랜치와 worktree |
| `events` | 모든 관측 가능한 상태 변화와 역할 로그 |
| `findings` | 테스트·실행 실패와 Reviewer 결함 |
| `notes` | 사람의 결정과 프로젝트 문맥 |

대시보드의 수치와 최근 활동은 `events`, `tasks`, `findings`에서 계산한다. JSONL 원문 전체 대신 UI에 필요한 redacted 메시지만 최대 길이를 제한해 저장한다.

## 실패 정책

- Codex 프로세스 비정상 종료: 작업을 `failed`로 전환하고 high finding을 등록한다.
- Codex 단계 제한 시간 초과: 역할별 30분 후 프로세스 그룹을 종료하고 작업을 `failed`, 이벤트를 `task_timed_out`으로 기록한다.
- 검증 명령 제한 시간 초과: 45분 후 프로세스 그룹을 종료하고 작업을 `failed`, 이벤트를 `task_timed_out`으로 기록한다.
- 테스트 실패: 출력 마지막 4,000자를 다음 Implementer에게 전달한다.
- 검증 명령 누락: worktree를 만들기 전에 실행을 거절하고 프로젝트 설정으로 안내한다.
- 재시도 한도 초과: 작업을 `failed`로 전환한다.
- 사용자 중단: 현재 child process에 `SIGTERM`을 보내고 `stopped`로 전환한다.
- 프로세스 종료: macOS와 Linux에서는 격리된 프로세스 그룹에 `SIGTERM`을 보내고 3초 뒤에도 살아 있으면 `SIGKILL`한다.
- 앱 종료: `AgentRunner.dispose()`로 active run의 상태 전이와 이벤트 기록을 마친 다음 Codex 인증 세션과 SQLite를 닫는다.
- 앱 종료·비정상 재시작: 남아 있는 `running`·`testing` 작업을 `stopped`로 전환하고 복구 이벤트를 기록한다. 기존 worktree는 보존해 사용자가 검토하거나 재실행할 수 있다.
- Reviewer 보고: 명시적인 `[critical|high|medium|low] 제목` 행을 finding으로 등록하고 다음 검토 전에 같은 작업의 기존 미해결 finding을 해결 처리한다.

## 보안 경계

- `nodeIntegration`은 끄고 `contextIsolation`과 renderer sandbox를 켠다.
- Renderer navigation과 새 창 생성을 차단한다.
- IPC 입력은 Zod schema로 검증한다.
- Codex sandbox 우회 옵션을 사용하지 않는다.
- 검증 명령은 shell을 거치지 않고 허용 목록의 실행 파일만 `spawn`한다.
- 프로젝트 검사는 `git status`, `git log`, `git remote`, `git ls-files`만 사용하며 `.env`, Git 무시 파일, 인증 자료와 빌드 산출물 내용을 검사 응답으로 가져오지 않는다.
- 로그에서 일반적인 API token 패턴과 Bearer token을 마스킹한다.
- API 키와 Codex 인증 정보는 데이터베이스에 저장하지 않는다.
- 사용자 전역 `~/.codex`와 분리된 앱 전용 `CODEX_HOME`을 사용한다.
- 로그인은 app-server의 `account/login/start`로 시작하고 `account/login/completed` 알림으로 완료를 확정한다.
- 작업용 `codex exec`에도 같은 전용 `CODEX_HOME`과 ChatGPT 전용 인증 정책을 적용한다.
- 승인 적용은 깨끗한 원본 checkout과 fast-forward 가능 조건을 모두 만족할 때만 수행한다.
- 승인 실패 시 강제 merge, reset, stash 또는 사용자 파일 덮어쓰기를 시도하지 않는다.

## 의도적으로 남긴 제한

- 앱 재시작은 프로세스 실행을 이어받지 않고 안전한 `stopped` 상태에서 사람의 재실행 결정을 기다린다.
- 목표 프로젝트의 고정 인수 테스트를 암호학적으로 잠그지 않는다.
- 앱 패키지 서명과 배포 채널은 구성하지 않았다.
- 분기된 작업 브랜치의 rebase나 충돌 해결은 자동화하지 않는다.

이 제한은 로컬 개인용 MVP에서 허용한다. 팀 사용이나 자동 merge를 추가하기 전에 복구 관리자, approval policy, 테스트 잠금, 서명된 감사 로그를 먼저 설계해야 한다.
