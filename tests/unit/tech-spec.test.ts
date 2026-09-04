import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildTaskTechSpecContext } from '../../electron/main/runner'
import { AppStore } from '../../electron/main/store'
import { buildGeneratedTechSpec } from '../../electron/main/tech-spec-generator'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('optional task tech specs', () => {
  it('normalizes generated output and assigns the requested revision', () => {
    const generated = buildGeneratedTechSpec(
      {
        summary: '네비게이션 경로 이탈 감지의 구현 경계를 정리했습니다.',
        markdown: `${'# 목표\n\n경로 이탈을 감지하고 사용자에게 알려야 합니다.\n\n'.repeat(3)}## 검증\n\n경계값을 확인합니다.`,
        openQuestions: ['이탈 거리의 기본 임계값은 얼마인가요?'],
        changeSummary: '최초 구현 범위와 검증 전략을 정리했습니다.'
      },
      3
    )

    expect(generated).toMatchObject({
      version: 1,
      revision: 3,
      openQuestions: ['이탈 거리의 기본 임계값은 얼마인가요?']
    })
  })

  it('rejects an incomplete generated document', () => {
    expect(() => buildGeneratedTechSpec(
      {
        summary: '너무 짧은 문서',
        markdown: '# 목표',
        openQuestions: [],
        changeSummary: '초안을 만들었습니다.'
      },
      1
    )).toThrow()
  })

  it('persists only the approved task snapshot and exposes it to agents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-tech-spec-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'test.sqlite')
    const store = new AppStore(databasePath)
    const project = store.addProject('Swift app', join(directory, 'SwiftApp'))
    const draft = {
      version: 1 as const,
      revision: 2,
      summary: '오프라인 재시도 정책을 포함한 구현 명세입니다.',
      markdown: `${'# 목표\n\n오프라인에서도 요청을 보존하고 연결 복구 후 재시도합니다.\n\n'.repeat(3)}## 검증\n\n재시도 횟수와 사용자 안내를 확인합니다.`,
      openQuestions: []
    }
    const task = store.createTask(
      project.id,
      '오프라인 재시도 구현',
      '네트워크가 끊겨도 요청을 보존하고 복구 후 다시 전송한다.',
      3,
      null,
      null,
      { version: 1, mode: 'manual-review', testDesign: 'skip', runtimeSource: 'off' },
      'pull-request',
      draft
    )

    expect(task.techSpec).toMatchObject(draft)
    expect(task.techSpec?.approvedAt).toBeTruthy()
    expect(buildTaskTechSpecContext(task)).toContain('사람이 구현 전에 승인한 테크스펙 revision 2')
    expect(buildTaskTechSpecContext(task)).toContain('오프라인에서도 요청을 보존')
    store.close()

    const reopened = new AppStore(databasePath)
    expect(reopened.getTask(task.id).techSpec).toEqual(task.techSpec)
    reopened.close()
  })

  it('keeps the agent context empty when the optional tech spec is skipped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-tech-spec-skip-'))
    temporaryDirectories.push(directory)
    const store = new AppStore(join(directory, 'test.sqlite'))
    const project = store.addProject('Plain project', join(directory, 'Plain'))
    const task = store.createTask(project.id, '간단한 수정', '기존 문구를 더 명확하게 수정한다.', 1)

    expect(task.techSpec).toBeNull()
    expect(buildTaskTechSpecContext(task)).toBe('')
    store.close()
  })
})
