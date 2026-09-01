# AgentMonitoring 아키텍처

## 제품 경계

AgentMonitoring은 IDE나 범용 shell이 아니다. 기존 Git 저장소와 외부 IDE를 유지하면서 AI 작업 실행과 검증 경계를 관리하는 로컬 control plane이다.

```text
React renderer
   │ 타입이 정의된 IPC
   ▼
Electron main
   ├── SQLite event store
   ├── 작업 상태 머신
   └── AgentRunner
          ├── Git worktree
          ├── Codex app-server auth adapter
          ├── Codex CLI execution adapter
          └── 허용 목록 기반 test runner
```

Renderer에는 Node.js 권한이 없다. 파일 선택, 외부 경로 열기, 데이터 변경, 프로세스 실행은 preload가 공개한 제한된 IPC를 통해서만 요청한다.

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
| Human | UI 승인 | 상태 전이 | 최종 승인·중단·폐기 |

## Git 격리

작업을 처음 실행하면 다음 규칙으로 worktree와 브랜치를 만든다.

```text
branch: agentmonitor/<task-slug>-<task-id-prefix>
path:   <Electron userData>/worktrees/<project-id>/<task-id>
```

Codex와 프로젝트 테스트는 worktree를 `cwd`로 사용한다. 원본 checkout은 수정하지 않는다. 폐기는 `git worktree remove --force <exact-task-path>`만 사용하며 저장소 루트나 광범위한 경로를 대상으로 하지 않는다.

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
- 테스트 실패: 출력 마지막 4,000자를 다음 Implementer에게 전달한다.
- 재시도 한도 초과: 작업을 `failed`로 전환한다.
- 사용자 중단: 현재 child process에 `SIGTERM`을 보내고 `stopped`로 전환한다.
- 앱 종료: SQLite 이벤트와 task 상태는 남는다. 실행 중 프로세스 자동 복구는 후속 범위다.

## 보안 경계

- `nodeIntegration`은 끄고 `contextIsolation`과 renderer sandbox를 켠다.
- Renderer navigation과 새 창 생성을 차단한다.
- IPC 입력은 Zod schema로 검증한다.
- Codex sandbox 우회 옵션을 사용하지 않는다.
- 검증 명령은 shell을 거치지 않고 허용 목록의 실행 파일만 `spawn`한다.
- 로그에서 일반적인 API token 패턴과 Bearer token을 마스킹한다.
- API 키와 Codex 인증 정보는 데이터베이스에 저장하지 않는다.
- 사용자 전역 `~/.codex`와 분리된 앱 전용 `CODEX_HOME`을 사용한다.
- 로그인은 app-server의 `account/login/start`로 시작하고 `account/login/completed` 알림으로 완료를 확정한다.
- 작업용 `codex exec`에도 같은 전용 `CODEX_HOME`과 ChatGPT 전용 인증 정책을 적용한다.

## 의도적으로 남긴 제한

- 실행 중 앱이 강제 종료되면 orphan worktree를 수동으로 확인해야 한다.
- Reviewer 보고를 구조화된 finding으로 자동 분해하지 않는다.
- 목표 프로젝트의 고정 인수 테스트를 암호학적으로 잠그지 않는다.
- 앱 패키지 서명과 배포 채널은 구성하지 않았다.

이 제한은 로컬 개인용 MVP에서 허용한다. 팀 사용이나 자동 merge를 추가하기 전에 복구 관리자, approval policy, 테스트 잠금, 서명된 감사 로그를 먼저 설계해야 한다.
