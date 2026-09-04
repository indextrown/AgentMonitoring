export class GitOperationCoordinator {
  private readonly activeProjects = new Set<string>()

  async runExclusive<Result>(
    projectId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    if (this.activeProjects.has(projectId)) {
      throw new Error('이 프로젝트에서 다른 Git 작업이 진행 중입니다. 완료된 뒤 다시 시도하세요.')
    }

    this.activeProjects.add(projectId)
    try {
      return await operation()
    } finally {
      this.activeProjects.delete(projectId)
    }
  }
}
