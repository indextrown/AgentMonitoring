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
  await expect(page.getByText('등록된 작업이 없습니다.')).toBeVisible()
})

test('explains and confirms applying an approved task to the original checkout', async ({ page }) => {
  await page.goto('/?workspace=empty')
  await page.getByRole('button', { name: '실제 Git 프로젝트 추가' }).last().click()
  await page.locator('.current-footer').getByRole('button', { name: '새 작업' }).click()
  await page.getByPlaceholder('예: 네비게이션 경로 이탈 감지 구현').fill('승인 적용 확인')
  await page
    .getByPlaceholder('구현할 동작, 제외 범위, 통과해야 할 테스트를 구체적으로 작성한다.')
    .fill('승인된 변경을 원본 저장소에 안전하게 적용하는 흐름을 확인한다.')
  await page.getByRole('button', { name: '작업 등록' }).click()

  const drawer = page.locator('.task-drawer')
  await drawer.getByRole('button', { name: '실행' }).click()
  await expect(drawer.getByText('안전한 로컬 적용')).toBeVisible()
  await expect(drawer.getByText('변경 내역')).toBeVisible()
  await expect(drawer.getByText('src/navigation/RouteMonitor.ts', { exact: true })).toBeVisible()
  await expect(drawer.getByRole('button', { name: '원본에 적용' })).toBeVisible()

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('fast-forward 방식으로 적용합니다')
    await dialog.accept()
  })
  await drawer.getByRole('button', { name: '원본에 적용' }).click()
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
