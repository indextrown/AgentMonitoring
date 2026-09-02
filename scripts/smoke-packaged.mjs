import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const outputDirectory = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
const executable = join(
  process.cwd(),
  'dist',
  outputDirectory,
  'AgentMonitoring.app',
  'Contents',
  'MacOS',
  'AgentMonitoring'
)
const smokeUserData = await mkdtemp(join(tmpdir(), 'agent-monitoring-smoke-'))
const packagedAccessibilityObserver = join(
  process.cwd(),
  'dist',
  outputDirectory,
  'AgentMonitoring.app',
  'Contents',
  'Resources',
  'ios-accessibility-observer',
  'AgentMonitoringAccessibility.xcodeproj',
  'project.pbxproj'
)

try {
  const observerStats = await stat(packagedAccessibilityObserver)
  if (!observerStats.isFile()) {
    throw new Error('패키지에 XCTest 접근성 observer가 포함되지 않았습니다.')
  }
  await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [], {
      env: {
        ...process.env,
        AGENT_MONITORING_SMOKE_TEST: '1',
        AGENT_MONITORING_SMOKE_USER_DATA: smokeUserData,
        ELECTRON_ENABLE_LOGGING: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`패키지 smoke test가 시간 안에 완료되지 않았습니다.\n${output}`))
    }, 15_000)

    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0 && output.includes('PRELOAD_BRIDGE_READY')) {
        resolvePromise()
        return
      }
      reject(new Error(`패키지 preload bridge 확인에 실패했습니다. 종료 코드: ${code}\n${output}`))
    })
  })
  console.log('Package smoke test passed: PRELOAD_BRIDGE_READY + ACCESSIBILITY_OBSERVER_READY')
} finally {
  await rm(smokeUserData, { recursive: true, force: true })
}
