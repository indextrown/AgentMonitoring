interface DisposableRunner {
  dispose: () => Promise<void>
}

interface DisposableAuth {
  dispose: () => Promise<void>
}

interface ClosableStore {
  close: () => void
}

interface DisposableProjectSimulator {
  dispose: () => Promise<void>
}

export async function shutdownResources(resources: {
  planning?: DisposableRunner | null
  projectSimulator?: DisposableProjectSimulator | null
  runner: DisposableRunner | null
  codexAuth: DisposableAuth | null
  store: ClosableStore | null
}): Promise<void> {
  try {
    try { if (resources.planning) await resources.planning.dispose() }
    finally { await resources.projectSimulator?.dispose() }
  } finally {
    try {
      await resources.runner?.dispose()
    } finally {
      try {
        await resources.codexAuth?.dispose()
      } finally {
        resources.store?.close()
      }
    }
  }
}
