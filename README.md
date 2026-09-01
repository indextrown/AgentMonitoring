# AgentMonitoring

AgentMonitoring은 로컬 Git 프로젝트에서 Codex 작업자를 격리 실행하고, 테스트 설계부터 구현·검증·비평·사람 승인까지 한 화면에서 관리하는 macOS 데스크톱 앱이다.

![AgentMonitoring dashboard](./tests/e2e/dashboard.spec.ts-snapshots/dashboard-chromium-desktop-darwin.png)

## 주요 기능

- 제공된 레퍼런스와 같은 고밀도 다크 대시보드
- 프로젝트·작업·버그·메모·활동 이벤트 통합 조회
- 작업별 독립 Git worktree와 `agentmonitor/*` 브랜치
- Test Designer → Critic → Implementer → Test Runner → Reviewer 파이프라인
- `codex exec --json` 기반 실시간 JSONL 이벤트 수집
- Codex app-server 기반 앱 내 ChatGPT OAuth 로그인
- 실패한 테스트의 제한된 자가 수정 루프
- 작업 중단, 재실행, 변경 승인, worktree 폐기
- SQLite 기반 로컬 영속화와 앱 재시작 복구
- 샘플 데이터 없이 실제 Git 프로젝트로 시작하는 첫 실행 안내
- `⌘K` 통합 검색과 작업 상세 실시간 로그 drawer

## 실행 흐름

```text
작업 계약 등록
  → 테스트 설계자가 테스트 추가·보완
  → 읽기 전용 Critic이 테스트 공백 평가
  → Implementer가 기능 구현
  → 프로젝트 검증 명령 실행
      ├─ 실패: 원인 전달 후 제한된 자가 수정
      └─ 성공: 읽기 전용 Reviewer 검토
  → 사람의 최종 승인 대기
```

오케스트레이터는 LLM이 아니라 코드로 작성된 상태 머신이다. AI는 역할별 결과를 만들지만, 허용 상태 전이·재시도 횟수·sandbox·최종 승인은 앱이 통제한다.

## 기술 구성

| 영역 | 기술 |
| --- | --- |
| 데스크톱 | Electron 44, electron-vite |
| 화면 | React 19, TypeScript, Recharts, Lucide |
| 영속화 | Electron의 Node.js `node:sqlite` |
| 검증 | Vitest, Playwright |
| 에이전트 | Codex CLI 비대화형 JSONL 실행 |

자세한 경계와 상태 전이는 [아키텍처 문서](./docs/architecture.md)에 정리되어 있다.

## 요구 사항

- macOS
- Node.js 24 이상
- pnpm 11 이상
- Git
- Codex CLI

Codex CLI는 실행 경로에서 `codex` 명령을 찾을 수 있어야 한다. 앱을 처음 실행하면 로그인 화면에서 **ChatGPT로 계속**을 누르고 브라우저의 공식 OpenAI 인증을 완료한다. 별도의 API 키는 필요하지 않다.

AgentMonitoring은 사용자 전역 `~/.codex` 로그인을 가져오지 않는다. Electron `userData` 아래에 앱 전용 `CODEX_HOME`을 만들고 공식 Codex app-server의 `account/login/start` 브라우저 흐름을 사용한다. 인증 정보의 저장과 토큰 갱신은 Codex가 담당하며, 데이터베이스에는 토큰을 저장하지 않는다.

## 설치와 실행

`pnpm` 명령이 아직 없다면 Corepack을 준비한다.

```bash
npm install --global corepack@0.34.7
corepack enable
corepack install --global pnpm@11.25.0
hash -r
```

이후 프로젝트 의존성을 설치하고 Electron 앱을 실행한다.

```bash
pnpm install
pnpm dev
```

`pnpm install`의 프로젝트 `postinstall`은 Electron 실행 파일을 내려받는다. 공급망 보호를 위해 pnpm build script 허용 목록은 `pnpm-workspace.yaml`에 명시되어 있다.

프로덕션 번들을 만들려면 다음 명령을 사용한다.

```bash
pnpm build
pnpm package
```

## 사용 방법

1. 왼쪽 사이드바에서 `실제 Git 프로젝트 추가`를 누른다.
2. Git 저장소 폴더를 선택한다.
3. `프로젝트 설정`에서 검증 명령을 등록한다.
4. `새 작업`에서 목표와 완료 조건, 최대 재시도 횟수를 입력한다.
5. 작업 상세 화면에서 `실행`을 누른다.
6. 실시간 역할별 로그와 테스트 결과를 확인한다.
7. `승인 대기`에 도달하면 worktree를 열어 diff를 확인한다.
8. 변경을 승인하거나 worktree를 폐기한다.

앱은 첫 실행 시 프로젝트나 활동 데이터를 자동 생성하지 않는다. 기존 버전에 들어 있던 `is_demo=1` 샘플 레코드는 시작 과정에서 제거하며, 사용자가 등록한 실제 프로젝트와 작업 기록은 유지한다.

Electron 없이 UI만 빠르게 확인하려면 `pnpm dev:web`을 실행한다. 이 브라우저 전용 미리보기에서만 데모 데이터와 가상 상호작용을 사용하며, 실제 Git 저장소나 Codex에는 접근하지 않는다.

## 검증 명령 보안

검증 명령은 shell 문자열로 실행하지 않는다. 입력을 실행 파일과 인자로 분리한 뒤 다음 실행 파일만 직접 `spawn`한다.

```text
pnpm npm npx yarn bun xcodebuild swift cargo go
python python3 pytest make cmake gradle
```

파이프, redirect, `&&` 같은 shell 문법은 사용할 수 없다. 추가 실행 파일이 필요하면 코드의 허용 목록과 보안 테스트를 함께 수정해야 한다.

## Codex 실행 정책

- 구현 역할: `workspace-write`
- 비평·Reviewer 역할: `read-only`
- 출력: newline-delimited JSON
- 작업 위치: 앱이 만든 Git worktree
- 금지: sandbox 우회, 자동 commit, push, merge, 배포

구체적인 CLI 옵션은 [공식 OpenAI Codex 명령 문서](https://learn.chatgpt.com/docs/developer-commands?surface=cli)를 기준으로 한다.

## 테스트

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm check
```

- 단위 테스트는 상태 전이와 활동 집계를 검증한다.
- 저장소 테스트는 SQLite 재시작 후 데이터 복구를 검증한다.
- Runner 통합 테스트는 가짜 Codex와 실제 임시 Git worktree를 사용한다.
- Playwright는 1600×980 대시보드 시각 회귀와 검색·drawer 동작을 검증한다.

시각 기준 이미지를 의도적으로 갱신할 때만 다음 명령을 사용한다.

```bash
pnpm exec playwright test --update-snapshots
```

## 로컬 데이터

Electron의 `userData` 아래에 다음 데이터가 저장된다.

- `agent-monitoring.sqlite`: 프로젝트, 작업, 이벤트, 버그, 메모
- `worktrees/<project-id>/<task-id>`: 작업별 격리 Git worktree

소스 저장소의 파일 내용이나 인증 토큰을 별도 클라우드로 전송하는 백엔드는 없다. Codex 인증은 앱 전용 저장소에 격리되고 SQLite에는 기록되지 않는다. Codex가 처리하는 데이터의 정책은 로그인한 ChatGPT 계정과 조직 설정을 따른다.

## 현재 범위

이번 버전은 단일 사용자·단일 장비·Codex 한 공급자에 집중한다. 다음 기능은 포함하지 않는다.

- 내장 코드 편집기
- 자동 commit·merge·push·배포
- 원격 팀 협업
- 여러 공급자나 계정 순환
- 병렬 작업 스케줄러
- 앱 전용 자동 업데이트와 코드 서명

## 저장소 정책

이 저장소는 private 사용을 전제로 한다. 실행 로그, SQLite 파일, worktree, 빌드 결과, 환경 파일은 Git에서 제외된다. 실제 서비스 비밀값이나 고객 데이터를 fixture로 커밋하지 않는다.
