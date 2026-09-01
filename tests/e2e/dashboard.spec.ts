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
  await expect(drawer.getByRole('button', { name: '원본에 적용' })).toBeVisible()

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('fast-forward 방식으로 적용합니다')
    await dialog.accept()
  })
  await drawer.getByRole('button', { name: '원본에 적용' }).click()
  await expect(drawer.getByText('완료', { exact: true })).toBeVisible()
})
