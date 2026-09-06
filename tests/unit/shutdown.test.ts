import { describe, expect, it } from 'vitest'
import { shutdownResources } from '../../electron/main/shutdown'

describe('shutdownResources', () => {
  it('waits for the runner before closing authentication and storage', async () => {
    const order: string[] = []
    let releaseRunner = (): void => undefined
    const runnerReleased = new Promise<void>((resolvePromise) => {
      releaseRunner = resolvePromise
    })
    const shutdown = shutdownResources({
      projectSimulator: { dispose: async () => { order.push('simulator') } },
      runner: {
        dispose: async () => {
          order.push('runner:start')
          await runnerReleased
          order.push('runner:done')
        }
      },
      codexAuth: { dispose: async () => { order.push('auth') } },
      store: { close: () => { order.push('store') } }
    })

    await Promise.resolve()
    expect(order).toEqual(['simulator', 'runner:start'])
    releaseRunner()
    await shutdown
    expect(order).toEqual(['simulator', 'runner:start', 'runner:done', 'auth', 'store'])
  })

  it('still closes authentication and storage when runner disposal fails', async () => {
    const order: string[] = []
    const shutdown = shutdownResources({
      runner: { dispose: async () => { order.push('runner'); throw new Error('runner failure') } },
      codexAuth: { dispose: async () => { order.push('auth') } },
      store: { close: () => { order.push('store') } }
    })

    await expect(shutdown).rejects.toThrow('runner failure')
    expect(order).toEqual(['runner', 'auth', 'store'])
  })

  it('cleans up the remaining resources even when planning disposal fails', async () => {
    const order: string[] = []
    await expect(shutdownResources({
      planning: { dispose: async () => { order.push('planning'); throw new Error('planning failure') } },
      projectSimulator: { dispose: async () => { order.push('simulator') } },
      runner: { dispose: async () => { order.push('runner') } },
      codexAuth: { dispose: async () => { order.push('auth') } },
      store: { close: () => { order.push('store') } }
    })).rejects.toThrow('planning failure')
    expect(order).toEqual(['planning', 'simulator', 'runner', 'auth', 'store'])
  })
})
