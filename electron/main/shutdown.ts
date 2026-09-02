interface DisposableRunner {
  dispose: () => Promise<void>
}

interface DisposableAuth {
  dispose: () => Promise<void>
}

interface ClosableStore {
  close: () => void
}

export async function shutdownResources(resources: {
  runner: DisposableRunner | null
  codexAuth: DisposableAuth | null
  store: ClosableStore | null
}): Promise<void> {
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
