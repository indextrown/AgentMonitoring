import { expect, test } from '@playwright/test'

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
