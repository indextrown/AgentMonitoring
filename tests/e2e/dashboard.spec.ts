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
