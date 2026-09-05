import { useEffect, useRef, useState } from 'react'
import type { AgentMonitoringBridge, TechSpecProgress } from '../../shared/types'

export function useTechSpecPlanning(projectId: string, bridge: AgentMonitoringBridge) {
  const draft = useRef(crypto.randomUUID())
  const active = useRef<{ id: string; cancelled: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<TechSpecProgress | null>(null)
  const [now, setNow] = useState(Date.now())
  const [cancelled, setCancelled] = useState(false)

  useEffect(() => {
    const unsubscribe = bridge.onTechSpecProgress((event) => {
      if (active.current?.id === event.requestId && !active.current.cancelled) setProgress(event)
    })
    return () => {
      const request = active.current
      active.current = null
      if (request) void bridge.cancelTechSpec(request.id).catch(() => undefined)
      void bridge.releaseTechSpecDraft(projectId, draft.current).catch(() => undefined)
      unsubscribe()
    }
  }, [projectId, bridge])

  useEffect(() => {
    if (!loading) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [loading])

  const run = async <T,>(operation: (ids: { requestId: string; draftId: string }) => Promise<T>): Promise<T | undefined> => {
    if (active.current) return undefined
    const request = { id: crypto.randomUUID(), cancelled: false }
    active.current = request
    const startedAt = Date.now()
    setNow(startedAt)
    setLoading(true)
    setCancelled(false)
    setProgress({ requestId: request.id, startedAt, updatedAt: startedAt, stage: 'preparing', message: '로그인·계획 모델 확인 중',
      preview: '', model: '선택 모델 확인 중', effort: '', reusedConversation: false, reusedRepository: false })
    try {
      const result = await operation({ requestId: request.id, draftId: draft.current })
      return active.current === request && !request.cancelled ? result : undefined
    } catch (error) {
      if (active.current === request && !request.cancelled) throw error
      return undefined
    } finally {
      if (active.current === request) { active.current = null; setNow(Date.now()); setLoading(false) }
    }
  }

  const cancel = async (): Promise<void> => {
    if (!active.current) return
    active.current.cancelled = true
    setCancelled(true)
    await bridge.cancelTechSpec(active.current.id)
  }

  const reset = async (): Promise<void> => {
    if (active.current) return
    const previous = draft.current
    draft.current = crypto.randomUUID()
    setProgress(null)
    setCancelled(false)
    await bridge.releaseTechSpecDraft(projectId, previous)
  }

  return { run, cancel, reset, loading, progress, cancelled, now }
}

export function TechSpecLiveProgress({ planning }: { planning: ReturnType<typeof useTechSpecPlanning> }): React.JSX.Element | null {
  const { progress, loading, now, cancelled } = planning
  if (!progress) return null
  return <section className="tech-spec-live" aria-label="테크스펙 생성 진행 상황">
    <div className="tech-spec-live-heading">
      <strong role="status">{cancelled ? loading ? '취소 처리 중' : '생성을 취소했습니다' : loading ? progress.message : '요청 종료 · 아래 최종 결과 또는 오류를 확인하세요'}</strong>
      {loading && <button className="secondary-button" type="button" disabled={cancelled} onClick={() => void planning.cancel().catch(() => undefined)}>생성 취소</button>}
    </div>
    <p>{progress.model}{progress.effort && ` · ${progress.effort}`} · 경과 {Math.max(0, Math.floor((now - progress.startedAt) / 1000))}초
      {loading && ` · 마지막 활동 ${Math.max(0, Math.floor((now - progress.updatedAt) / 1000))}초 전`}</p>
    <p>{progress.reusedConversation ? '이전 대화 이어서 진행' : '새 계획 대화'} · {progress.reusedRepository ? '저장소 파일 목록 재사용' : '저장소 변경 확인'}</p>
    {progress.preview && <details open={loading}>
      <summary>작성 중인 초안 · 아직 승인할 수 없는 미완성 내용</summary>
      <pre>{progress.preview}</pre>
    </details>}
  </section>
}
