import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-02T09:00:00+09:00'))
})

test('matches the dense monitoring dashboard structure', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('.brand').getByText('AgentMonitoring', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'ElmwoodOnline' })).toBeVisible()
  await expect(page.getByText('최근 24시간')).toBeVisible()
  await expect(page.getByText('시작 대비 완료 누적 추이')).toBeVisible()
  await expect(page.getByText('등록 대비 해결 누적 추이')).toBeVisible()
  await expect(page.locator('.activity-row')).toHaveCount(15)
  await expect(page.locator('.capability-summary').getByRole('button', { name: 'iOS 자동 연결' })).toBeVisible()
  await expect(page).toHaveScreenshot('dashboard.png', {
    animations: 'disabled',
    fullPage: true,
    maxDiffPixelRatio: 0.01
  })
})

test('opens search and task detail interactions', async ({ page }) => {
  await page.goto('/')
  await page.locator('.search-trigger').click()
  await expect(page.getByPlaceholder('작업, 메모, 이벤트 검색')).toBeFocused()
  await page.getByPlaceholder('작업, 메모, 이벤트 검색').fill('프로필')
  await page.locator('.search-results button').first().click()
  await expect(page.locator('.task-drawer')).toBeVisible()
  await expect(page.getByText('작업 계약')).toBeVisible()
})

test('opens the in-app guide with a real task example and pipeline', async ({ page }) => {
  await page.goto('/')

  const helpButton = page.getByRole('button', { name: '도움말' })
  await helpButton.focus()
  await helpButton.press('Enter')

  const guide = page.getByRole('dialog', { name: '처음 작업 시작하기' })
  await expect(guide).toBeVisible()
  await expect(guide.getByText('실제 Git 프로젝트 추가를 누르고 저장소 루트를 선택하세요.')).toBeVisible()
  await expect(guide.getByText('장보기 목록 화면 구현', { exact: true })).toBeVisible()
  await expect(guide.getByText('작업을 등록한 뒤 작업 상세에서 실행을 눌러야 개발이 시작돼요.')).toBeVisible()
  await expect(guide.getByText('최대 구현 3회', { exact: true })).toBeVisible()
  await expect(guide.getByText('새 격리 작업공간에 필요한 의존성을 테스트 전에 준비합니다.')).toBeVisible()
  await expect(guide.getByText('실행할 단계와 합격 조건을 고정하고 작업만 만들어요. 아직 실행하지 않아요.')).toBeVisible()
  await expect(guide).toHaveScreenshot('usage-help.png', { animations: 'disabled' })

  await page.keyboard.press('Escape')
  await expect(guide).not.toBeVisible()
})

test('keeps the in-app guide readable and closable in a compact window', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto('/')
  await page.getByRole('button', { name: '도움말' }).click()

  const guide = page.getByRole('dialog', { name: '처음 작업 시작하기' })
  const confirm = guide.getByRole('button', { name: '확인했어요' })
  await confirm.scrollIntoViewIfNeeded()
  await expect(confirm).toBeVisible()
  await confirm.click()
  await expect(guide).not.toBeVisible()
})

test('shows the task-scoped Swift runtime session target', async ({ page }) => {
  await page.goto('/?runtime=running&device=iphone')
  await page.locator('.search-trigger').click()
  await page.getByPlaceholder('작업, 메모, 이벤트 검색').fill('프로필')
  await page.locator('.search-results button').first().click()

  const runtime = page.locator('.runtime-session')
  await expect(runtime.getByText('Swift runtime')).toBeVisible()
  await expect(runtime.getByText('실행 중')).toBeVisible()
  await expect(runtime.getByText('iPhone 16 Pro', { exact: true })).toBeVisible()
  await expect(runtime.getByText('com.example.ElmwoodOnline', { exact: true })).toBeVisible()
  await expect(runtime.getByText('PID 43120', { exact: true })).toBeVisible()
  await expect(runtime.getByText('실행 보고서', { exact: true })).toBeVisible()
  await expect(runtime.getByText('복구 후 통과', { exact: true })).toBeVisible()
  await expect(runtime.getByText('판정 통과 1 · 실패 1', { exact: true })).toBeVisible()
  await expect(runtime.locator('.runtime-report-attempt')).toHaveCount(2)
  await expect(runtime.getByRole('button', { name: /Simulator 화면 증거/ })).toContainText('1.2 MB')
  await expect(runtime.getByRole('button', { name: /Simulator 접근성 트리/ })).toContainText(
    '41.8 KB'
  )
  await expect(runtime.getByRole('button', { name: /Simulator UI 조작 결과/ })).toContainText(
    '3.5 KB'
  )
  await expect(runtime.getByRole('button', { name: /Simulator Debug state·fixture/ })).toContainText(
    '8.0 KB'
  )
  await expect(runtime.getByRole('button', { name: /Runtime 인수 검증 결과/ })).toContainText(
    'runtime acceptance 3/3 통과'
  )

  const repairedAttempt = runtime.locator('.runtime-report-attempt').nth(1)
  await repairedAttempt.locator('summary').click()
  await expect(repairedAttempt.getByText('실패 · 복구됨', { exact: true })).toBeVisible()
  await expect(repairedAttempt.getByRole('button', { name: /Runtime 인수 검증 결과/ })).toContainText(
    'runtime acceptance 2/3 통과'
  )
  await expect(page).toHaveScreenshot('runtime-report.png', {
    animations: 'disabled',
    fullPage: true,
    maxDiffPixelRatio: 0.01
  })
})

test('shows repository readiness when selecting a project without tasks', async ({ page }) => {
  await page.goto('/')
  await page.locator('.project-list button').filter({ hasText: 'AgentMonitoring' }).click()

  await expect(page.getByRole('heading', { name: 'AgentMonitoring', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '첫 작업을 시작할 준비가 되었습니다' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'AI가 접근할 수 있는 영역' })).toBeVisible()
  await expect(page.getByText('현재 1개 사용 가능')).toBeVisible()
  await expect(page.getByText('코드 작업 모드', { exact: true })).toBeVisible()
  await expect(page.getByText('프로젝트 테스트를 쓰려면 검증 명령을 연결하세요')).toBeVisible()
  await expect(page.locator('.project-list button').filter({ hasText: 'AgentMonitoring' })).toHaveClass(/selected/)

  await page.locator('.project-list button').filter({ hasText: 'ElmwoodOnline' }).click()
  await expect(page.getByText('최근 24시간')).toBeVisible()
})

test('automatically connects missing iOS access areas without changing repository files', async ({ page }) => {
  await page.goto('/?workspace=empty')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()

  const capabilities = page.locator('.capability-panel')
  await expect(capabilities.getByText('iOS 앱 실행 영역을 한 번에 연결하세요')).toBeVisible()
  await capabilities.getByRole('button', { name: 'iOS 자동 연결' }).click()

  await expect(capabilities.getByText('AgentMonitoring 내부 설정')).toBeVisible()
  await expect(capabilities.locator('.capability-item.ready')).toHaveCount(5)
  await expect(capabilities.getByRole('button', { name: 'iOS 자동 연결' })).not.toBeVisible()
  await expect(capabilities.getByText('저장소 파일은 바꾸지 않습니다.', { exact: false })).not.toBeVisible()
})

test('launches, restarts, and stops a connected iOS app from the dashboard', async ({ page }) => {
  await page.goto('/?workspace=empty&contract=ios')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()

  const simulator = page.locator('.project-simulator')
  await expect(simulator.getByRole('heading', { name: 'iPhone에서 앱 바로 실행' })).toBeVisible()
  await expect(simulator.getByText('실행 준비', { exact: true })).toBeVisible()

  await simulator.getByRole('button', { name: '빌드·실행' }).click()
  await expect(simulator.getByText('실행 중', { exact: true })).toBeVisible()
  await expect(simulator.getByText('iPhone 16 Pro', { exact: true })).toBeVisible()
  await expect(simulator.getByText('com.example.Demo', { exact: true })).toBeVisible()

  await simulator.getByRole('button', { name: '재실행' }).click()
  await expect(simulator.getByText('앱을 다시 실행했습니다.', { exact: false })).toBeVisible()

  await simulator.getByRole('button', { name: '종료' }).click()
  await expect(simulator.getByText('앱 종료됨', { exact: true })).toBeVisible()
  await expect(simulator.getByRole('button', { name: '종료' })).toBeDisabled()
})

test('explains the manual fallback when iOS automatic connection cannot find Xcode', async ({ page }) => {
  await page.goto('/?workspace=empty&runtime-discovery=missing')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()
  await page.getByRole('button', { name: 'iOS 자동 연결' }).click()

  await expect(page.getByRole('alert')).toContainText('Xcode 프로젝트 또는 Workspace를 찾지 못했습니다')
  await expect(page.getByRole('alert')).toContainText('프로젝트 설정에서 직접 입력하세요')
})

test('keeps AI access visible after a project has tasks', async ({ page }) => {
  await page.goto('/')

  const summary = page.locator('.capability-summary')
  await expect(summary.getByRole('heading', { name: 'AI가 접근할 수 있는 영역' })).toBeVisible()
  await expect(summary.getByText('Code', { exact: true })).toBeVisible()
  await expect(summary.getByText('Verify', { exact: true })).toBeVisible()
  await expect(summary.getByRole('button', { name: 'iOS 자동 연결' })).toBeVisible()

  await summary.getByRole('button', { name: '전체 보기' }).click()
  await expect(page.getByRole('heading', { name: '프로젝트 설정' })).toBeVisible()
  await expect(page.getByLabel('환경 준비 명령')).toBeVisible()
  await expect(page.getByText('새 격리 작업공간을 만든 직후와 의존성 설정이 바뀐 뒤, 테스트보다 먼저 실행한다.')).toBeVisible()
  await expect(page.locator('.capability-panel').getByRole('heading', { name: 'AI가 접근할 수 있는 영역' })).toBeVisible()
  await expect(page.locator('.capability-panel').getByRole('button', { name: '다시 검사' })).toBeVisible()
})

test('retries an environment-blocked task without another implementation run', async ({ page }) => {
  await page.goto('/?environment=blocked')
  await page.locator('.search-trigger').click()
  await page.getByPlaceholder('작업, 메모, 이벤트 검색').fill('프로필')
  await page.locator('.search-results button').first().click()

  const drawer = page.locator('.task-drawer')
  await expect(drawer.getByText('환경 확인 필요', { exact: true })).toBeVisible()
  await expect(drawer.getByText('Tuist 외부 의존성이 준비되지 않았습니다.')).toBeVisible()
  await expect(drawer.getByText('코드 문제가 아니라 검증 환경을 먼저 준비해야 합니다')).toBeVisible()

  await drawer.getByRole('button', { name: '환경 준비 후 다시 검증' }).click()

  await expect(drawer.getByText('승인 대기', { exact: true })).toBeVisible()
  await expect(drawer.getByText('환경 준비를 완료했습니다.')).toBeVisible()
  await expect(drawer.getByText('프로젝트 테스트가 다시 통과했습니다.')).toBeVisible()
})

test('uses dashboard chart links and expands the complete activity history', async ({ page }) => {
  await page.goto('/')
  const activity = page.locator('.activity-card')
  await activity.getByRole('button', { name: '모두 펼치기' }).click()
  await expect(activity.locator('.activity-row')).toHaveCount(34)
  await activity.getByRole('button', { name: '접기' }).click()
  await expect(activity.locator('.activity-row')).toHaveCount(15)

  await page.getByRole('button', { name: '작업 전체' }).click()
  await expect(page.getByRole('heading', { name: '작업', exact: true })).toBeVisible()
  await page.locator('.main-nav').getByRole('button', { name: '대시보드' }).click()
  await page.getByRole('button', { name: '버그 보드' }).click()
  await expect(page.getByRole('heading', { name: '버그', exact: true })).toBeVisible()
})

test('searches notes and events in addition to tasks', async ({ page }) => {
  await page.goto('/')
  await page.locator('.search-trigger').click()
  const search = page.getByPlaceholder('작업, 메모, 이벤트 검색')

  await search.fill('프로젝트 결정 14')
  await expect(page.locator('.search-results').getByText('메모', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /프로젝트 결정 14 작업 과정/ }).click()
  await expect(page.getByRole('heading', { name: '메모' })).toBeVisible()

  await page.locator('.search-trigger').click()
  await search.fill('경계 조건 버그 해결')
  await expect(page.locator('.search-results').getByText('이벤트', { exact: true })).toBeVisible()
  await page.locator('.search-results button').filter({ hasText: '경계 조건 버그 해결' }).first().click()
  await expect(page.locator('.search-modal')).not.toBeVisible()
})

test('reopens findings and creates, edits, and deletes notes', async ({ page }) => {
  await page.goto('/')
  await page.locator('.main-nav').getByRole('button', { name: '버그' }).click()
  const finding = page.locator('.finding-card').first()
  await finding.getByRole('button', { name: '다시 열기' }).click()
  await expect(finding.getByRole('button', { name: '해결 처리' })).toBeVisible()
  await finding.getByRole('button', { name: '해결 처리' }).click()
  await expect(finding.getByRole('button', { name: '다시 열기' })).toBeVisible()

  await page.locator('.main-nav').getByRole('button', { name: /메모/ }).click()
  await page.getByRole('button', { name: '새 메모' }).click()
  await page.getByRole('dialog').getByLabel('제목').fill('운영 결정')
  await page.getByRole('dialog').getByLabel('내용').fill('실패한 검증은 승인 전에 다시 실행한다.')
  await page.getByRole('button', { name: '메모 저장' }).click()

  const note = page.locator('.note-card').filter({ hasText: '운영 결정' })
  await expect(note).toBeVisible()
  await note.getByRole('button', { name: '운영 결정 수정' }).click()
  await page.getByRole('dialog').getByLabel('제목').fill('운영 결정 수정')
  await page.getByRole('button', { name: '수정 저장' }).click()
  const updatedNote = page.locator('.note-card').filter({ hasText: '운영 결정 수정' })
  await expect(updatedNote).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await updatedNote.getByRole('button', { name: '운영 결정 수정 삭제' }).click()
  await expect(updatedNote).not.toBeVisible()
})

test('gates the workspace behind the dedicated Codex login', async ({ page }) => {
  await page.goto('/?auth=signed-out')

  await expect(page.getByRole('heading', { name: 'Codex 계정을 연결하세요' })).toBeVisible()
  await expect(page.getByText('다른 Codex 앱과 분리된 전용 로그인입니다.')).toBeVisible()
  await expect(page).toHaveScreenshot('codex-login.png', {
    animations: 'disabled',
    fullPage: true,
    maxDiffPixelRatio: 0.01
  })

  await page.getByRole('button', { name: 'ChatGPT로 계속' }).click()
  await expect(page.getByRole('heading', { name: '브라우저에서 로그인을 완료하세요' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'ElmwoodOnline' })).toBeVisible()
})

test('blocks an outdated Electron preload before unsupported features run', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 Electron/44.1.0'
    })
    ;(window as unknown as { agentMonitoring: unknown }).agentMonitoring = { apiVersion: 1 }
  })
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '앱 연결을 업데이트해야 합니다' })).toBeVisible()
  await expect(page.getByText('Electron preload는 이전 버전입니다', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: '새 연결 다시 불러오기' })).toBeVisible()
  await expect(page.getByText(/Ctrl\+C.*pnpm dev/)).toBeVisible()
})

test('starts from a real-project onboarding state without seeded data', async ({ page }) => {
  await page.goto('/?workspace=empty')

  await expect(page.getByRole('heading', { name: '프로젝트 연결' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '첫 Git 프로젝트를 연결하세요' })).toBeVisible()
  await expect(page.locator('.project-select select')).toHaveValue('')
  await expect(page.locator('.project-select select')).toBeDisabled()
  await expect(page).toHaveScreenshot('empty-workspace.png', {
    animations: 'disabled',
    fullPage: true,
    maxDiffPixelRatio: 0.01
  })

  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()
  await expect(page.getByRole('heading', { name: 'ConnectedRepository' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '첫 작업을 시작할 준비가 되었습니다' })).toBeVisible()
  await expect(page.getByText('프로젝트 테스트를 쓰려면 검증 명령을 연결하세요')).toBeVisible()
  await expect(page.getByRole('button', { name: '첫 작업 만들기' })).toBeEnabled()
  await expect(page).toHaveScreenshot('project-readiness.png', {
    animations: 'disabled',
    fullPage: true,
    maxDiffPixelRatio: 0.01
  })

  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('.command-suggestions').getByRole('button', { name: /pnpm test/ }).click()
  await expect(page.getByText('설정 완료')).toBeVisible()
  await expect(page.locator('.capability-item').filter({ hasText: 'Verify' }).getByText('지금 사용 가능')).toBeVisible()
  await expect(page.getByRole('button', { name: '첫 작업 만들기' })).toBeEnabled()
})

test('creates a manual-review task without a project test command', async ({ page }) => {
  await page.goto('/?workspace=empty')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()
  await page.getByRole('button', { name: '첫 작업 만들기' }).click()

  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('작업 제목').fill('README 문구 정리')
  await dialog.getByLabel('목표와 완료 조건').fill('README의 설치 설명을 읽기 쉽게 정리하고 링크가 유지되는지 확인해 주세요.')
  await expect(dialog.getByLabel('검증 조합')).toHaveValue('manual-review')
  await expect(dialog.getByText('자동 통과로 표시하지 않습니다.')).toBeVisible()
  await dialog.getByRole('button', { name: '검증 계획 확인하고 작업 등록' }).click()

  const drawer = page.locator('.task-drawer')
  await expect(drawer.getByText('작업별 검증 계획')).toBeVisible()
  await expect(drawer.getByText('수동 검토만', { exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: '실행' }).click()
  await expect(drawer.getByText('수동 검증 필요', { exact: true })).toBeVisible()
  await expect(drawer.getByText('자동 통과로 판정하지 않았습니다.', { exact: false })).toBeVisible()
})

test('explains dirty repositories with exact file categories and paths', async ({ page }) => {
  await page.goto('/?workspace=empty&inspection=dirty')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()

  await expect(page.getByText('원본 저장소에 커밋되지 않은 파일이 있습니다.')).toBeVisible()
  await expect(page.getByText('Git 미추적 새 파일 5개', { exact: true })).toBeVisible()
  await expect(page.locator('.change-preview code').filter({ hasText: 'fastlane/screenshots/ko/0_APP_IPHONE_65_0.png' })).toBeVisible()
  await expect(page.getByText('원본 저장소에 변경 1개가 있습니다.')).toHaveCount(0)
  await expect(page).toHaveScreenshot('project-dirty-readiness.png', {
    animations: 'disabled',
    fullPage: true,
    maxDiffPixelRatio: 0.01
  })
})

test('stages selected files and commits them from source control', async ({ page }) => {
  await page.goto('/?workspace=empty&source-control=dirty')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()
  await page.getByRole('button', { name: '소스 제어' }).click()

  await expect(page.getByRole('heading', { name: '소스 제어' })).toBeVisible()
  await expect(page.getByText('커밋되지 않은 파일')).toBeVisible()
  await expect(page.getByText('2개', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: /Projects\/Shared\/Featcher\/Project.swift$/ }).click()
  await expect(page.locator('.source-diff')).toContainText('FeatcherTests')

  await page.getByRole('button', { name: 'Projects/Shared/Featcher/Project.swift 스테이징' }).click()
  await expect(page.getByRole('button', { name: 'Projects/Shared/Featcher/Project.swift 스테이징 해제' })).toBeVisible()

  await page.getByLabel('커밋 메시지').fill('Featcher 테스트 타깃을 추가한다')
  await page.getByRole('button', { name: 'staged 1개 커밋' }).click()

  await expect(page.getByText('d4e5f6a 커밋을 만들었습니다.')).toBeVisible()
  await expect(page.getByText('1개', { exact: true })).toBeVisible()
  await expect(page.getByText('Projects/Shared/Featcher/Tests/FetcherTests.swift')).toBeVisible()
  await expect(page).toHaveScreenshot('source-control.png', {
    animations: 'disabled',
    fullPage: true,
    maxDiffPixelRatio: 0.01
  })
})

test('pushes local commits and fast-forwards remote commits from source control', async ({ page }) => {
  await page.goto('/?workspace=empty&source-remote=ahead')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()
  await page.getByRole('button', { name: '소스 제어' }).click()

  await expect(page.getByText('앞섬 2 / 뒤처짐 0')).toBeVisible()
  await page.getByRole('button', { name: '2개 커밋 Push' }).click()
  await expect(page.getByText('2개 로컬 커밋을 원격에 push했습니다.')).toBeVisible()
  await expect(page.getByText('앞섬 0 / 뒤처짐 0')).toBeVisible()

  await page.goto('/?workspace=empty&source-remote=behind')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()
  await page.getByRole('button', { name: '소스 제어' }).click()
  await expect(page.getByText('앞섬 0 / 뒤처짐 1')).toBeVisible()
  await page.getByRole('button', { name: '1개 커밋 동기화' }).click()
  await expect(page.getByText('1개 원격 커밋을 로컬에 동기화했습니다.')).toBeVisible()
  await expect(page.getByText('앞섬 0 / 뒤처짐 0')).toBeVisible()
})

test('distinguishes supported iOS runtime capabilities from planned access', async ({ page }) => {
  await page.goto('/?workspace=empty&contract=ios')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()

  await expect(page.getByText('계약 확인됨')).toBeVisible()
  await expect(page.getByText('현재 5개 사용 가능 · 1개는 프로젝트 선언 후 연결 대기')).toBeVisible()
  await expect(page.locator('.capability-item.ready')).toHaveCount(5)
  await expect(page.locator('.capability-item.declared')).toHaveCount(1)
  await expect(page.getByText('연결된 Build·Run·관찰·조작 항목은 작업별 Swift runtime에서 사용합니다. Debug state·fixture는 project.json 고급 설정입니다.')).toBeVisible()
})

test('generates, reviews, and freezes a task-scoped Simulator scenario', async ({ page }) => {
  await page.goto('/?workspace=empty&contract=ios&device=iphone')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()

  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('.command-suggestions').getByRole('button', { name: /pnpm test/ }).click()
  await page.getByRole('button', { name: '첫 작업 만들기' }).click()

  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('작업 제목').fill('장보기 항목 추가')
  await dialog
    .getByLabel('목표와 완료 조건')
    .fill('장보기 목록에서 우유를 입력하고 추가하면 목록에 우유가 표시되게 해줘.')
  await dialog.getByRole('button', { name: 'AI에게 추천받기' }).click()
  await expect(dialog.getByText('AI 추천', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('검증 조합')).toHaveValue('both')
  await dialog.getByRole('button', { name: '검증 시나리오 만들기' }).click()

  await expect(dialog.getByText('승인 전 검토')).toBeVisible()
  await expect(dialog.getByLabel('조작 1 식별자')).toHaveValue('item-input')
  await dialog.getByLabel('조작 1 식별자').fill('shopping-item-input')
  await expect(dialog.getByText(/등록하면 이 조건이 작업에 고정됩니다/)).toBeVisible()
  await dialog.getByRole('button', { name: '검증 계획 확인하고 작업 등록' }).click()

  const drawer = page.locator('.task-drawer')
  await expect(drawer.getByText('승인된 Simulator 검증')).toBeVisible()
  await expect(drawer.getByText('입력한 항목을 추가하고 목록에 표시되는지 확인합니다.')).toBeVisible()
  await expect(drawer.getByText('iPhone', { exact: true })).toBeVisible()
  await expect(drawer.getByText('조작 2단계', { exact: true })).toBeVisible()
  await expect(drawer.getByText('검증 4개', { exact: true })).toBeVisible()
  await expect(drawer.getByText(/조건 고정/)).toBeVisible()
})

test('explains and confirms publishing an approved task through a PR', async ({ page }) => {
  await page.goto('/?workspace=empty')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('.command-suggestions').getByRole('button', { name: /pnpm test/ }).click()
  await page.getByRole('button', { name: '첫 작업 만들기' }).click()
  await page.getByPlaceholder('예: 네비게이션 경로 이탈 감지 구현').fill('승인 적용 확인')
  await page
    .getByPlaceholder('구현할 동작, 제외 범위, 통과해야 할 테스트를 구체적으로 작성한다.')
    .fill('승인된 변경을 원본 저장소에 안전하게 적용하는 흐름을 확인한다.')
  await page.getByRole('button', { name: '검증 계획 확인하고 작업 등록' }).click()

  const drawer = page.locator('.task-drawer')
  await drawer.getByRole('button', { name: '실행' }).click()
  await expect(drawer.getByText('안전한 원격 게시')).toBeVisible()
  await expect(drawer.getByText('변경 내역')).toBeVisible()
  await expect(drawer.getByText('src/navigation/RouteMonitor.ts', { exact: true })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '브랜치 올리고 PR 만들기' })).toBeVisible()

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('작업 브랜치를 올리고 PR을 만듭니다')
    await dialog.accept()
  })
  await drawer.getByRole('button', { name: '브랜치 올리고 PR 만들기' }).click()
  await expect(drawer.getByText('PR 병합 대기', { exact: true })).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'GitHub PR 열기' })).toBeVisible()
  await page.getByRole('button', { name: '알림 닫기' }).click()
  await drawer.getByRole('button', { name: 'PR 상태 확인' }).click()
  await expect(drawer.getByText('완료', { exact: true })).toBeVisible()
})

test('lets each task publish directly to the remote base branch', async ({ page }) => {
  await page.goto('/?workspace=empty')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('.command-suggestions').getByRole('button', { name: /pnpm test/ }).click()
  await page.getByRole('button', { name: '첫 작업 만들기' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('작업 제목').fill('직접 게시 확인')
  await dialog.getByLabel('목표와 완료 조건').fill('검증된 변경을 원격 main에 직접 게시하고 로컬을 동기화한다.')
  await dialog.getByText('작업 시작 브랜치에 직접 올리기', { exact: true }).click()
  await dialog.getByRole('button', { name: '검증 계획 확인하고 작업 등록' }).click()

  const drawer = page.locator('.task-drawer')
  await drawer.getByRole('button', { name: '실행' }).click()
  await expect(drawer.getByRole('button', { name: 'main 브랜치에 직접 게시' })).toBeVisible()
  page.once('dialog', (confirmDialog) => confirmDialog.accept())
  await drawer.getByRole('button', { name: 'main 브랜치에 직접 게시' }).click()
  await expect(drawer.getByText('완료', { exact: true })).toBeVisible()
})

test('retries only the local sync after the remote publication already succeeded', async ({ page }) => {
  await page.goto('/?publication=local-sync')
  await page.locator('.main-nav').getByRole('button', { name: /작업/ }).click()
  await page.locator('.task-name').first().click()

  const drawer = page.locator('.task-drawer')
  await expect(drawer.getByText('원격 origin/main 게시 완료 · 로컬 동기화 대기')).toBeVisible()
  await expect(drawer.getByRole('button', { name: '로컬 동기화 다시 시도' })).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'main 브랜치에 직접 게시' })).toHaveCount(0)
  await drawer.getByRole('button', { name: '로컬 동기화 다시 시도' }).click()
  await expect(drawer.getByText('완료', { exact: true })).toBeVisible()
})

test('removes monitoring data while preserving the source-repository boundary', async ({ page }) => {
  await page.goto('/?workspace=empty')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()
  await page.locator('.folder-button').click()
  await expect(page.getByText('원본 Git 저장소는 보존됩니다.')).toBeVisible()

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('원본 저장소는 삭제하지 않습니다')
    await dialog.accept()
  })
  await page.getByRole('button', { name: '연결 삭제' }).click()
  await expect(page.getByRole('heading', { name: '첫 Git 프로젝트를 연결하세요' })).toBeVisible()
})

test('shows storage usage and runs retention-based cleanup', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '저장 공간' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '저장 공간 관리' })).toBeVisible()
  await expect(dialog.getByText('610.0 MB')).toBeVisible()
  await expect(dialog.getByText('승인·폐기 시 즉시 정리')).toBeVisible()
  await expect(dialog.getByText(/DerivedData는 완료·폐기 시 바로 삭제합니다/)).toBeVisible()
  await dialog.getByLabel('Simulator 실행 기록 보관 기간').selectOption('7')
  await dialog.getByRole('button', { name: '정책 저장' }).click()

  page.once('dialog', async (confirmation) => {
    expect(confirmation.message()).toContain('현재 보관 정책')
    await confirmation.accept()
  })
  await dialog.getByRole('button', { name: '지금 정리' }).click()
  await expect(dialog.getByText('256.0 MB 확보했습니다.')).toBeVisible()
  await expect(dialog.getByText('작업공간 1개 · 실행 기록 2개 · 브랜치 0개 정리')).toBeVisible()
})
