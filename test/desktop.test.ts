import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { desktopRuntimeFor, type DesktopPnpmLike } from '../src/desktop.ts'

/** A minimal Readable carrying a single string payload. */
function stringStream(text: string): NodeJS.ReadableStream {
  return Readable.from([text])
}

/** A fake Desktop package manager recording calls and echoing an outcome. */
function fakePnpm(opts?: {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  throwOnRun?: Error
  rejectDone?: Error
  signal?: NodeJS.Signals | null
}): {
  pnpm: DesktopPnpmLike
  calls: { args: readonly string[]; invokingDir: string }[]
  cancelled: { count: number }
} {
  const calls: { args: readonly string[]; invokingDir: string }[] = []
  const state = { count: 0 }
  const pnpm: DesktopPnpmLike = {
    runPlugin(args, invokingDir) {
      calls.push({ args, invokingDir })
      if (opts?.throwOnRun !== undefined) throw opts.throwOnRun
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        // Settle after the stream data events have had a chance to fire, so
        // the adapter's stdout/stderr listeners observe the payload.
        const settle = (): void => {
          if (opts?.rejectDone !== undefined) reject(opts.rejectDone)
          else resolve({ exitCode: opts?.exitCode ?? 0, signal: opts?.signal ?? null })
        }
        setImmediate(settle)
      })
      return {
        stdout: stringStream(opts?.stdout ?? ''),
        stderr: stringStream(opts?.stderr ?? ''),
        done,
        cancel() { state.count += 1 },
      }
    },
  }
  return { pnpm, calls, cancelled: state }
}

describe('desktopRuntimeFor', () => {
  it('forwards plugin args verbatim and uses the profile dir as invoking dir', async () => {
    const { pnpm, calls } = fakePnpm({ stdout: 'resolved 3 packages' })
    const runtime = desktopRuntimeFor(pnpm, '/profile/dir')
    const result = await runtime.runPlugin('ignored-profile', ['add', '@scope/pkg'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual(['add', '@scope/pkg'])
    expect(calls[0]!.invokingDir).toBe('/profile/dir')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('resolved 3 packages')
    expect(result.cancelled).toBe(false)
  })

  it('maps a non-zero exit code and stderr into the result', async () => {
    const { pnpm } = fakePnpm({ exitCode: 1, stderr: 'ENOENT' })
    const runtime = desktopRuntimeFor(pnpm, '/profile/dir')
    const result = await runtime.runPlugin('p', ['remove', 'x'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('ENOENT')
  })

  it('reports a synchronous provider rejection as exit 127', async () => {
    const { pnpm } = fakePnpm({ throwOnRun: new Error('busy') })
    const runtime = desktopRuntimeFor(pnpm, '/profile/dir')
    const result = await runtime.runPlugin('p', ['add', 'x'])
    expect(result.exitCode).toBe(127)
    expect(result.stderr).toContain('busy')
  })

  it('reports an async done rejection as exit 127', async () => {
    const { pnpm } = fakePnpm({ rejectDone: new Error('provider exploded') })
    const runtime = desktopRuntimeFor(pnpm, '/profile/dir')
    const result = await runtime.runPlugin('p', ['add', 'x'])
    expect(result.exitCode).toBe(127)
    expect(result.stderr).toContain('provider exploded')
  })

  it('cancelActive cancels the in-flight handle', async () => {
    const { pnpm, cancelled } = fakePnpm({})
    const runtime = desktopRuntimeFor(pnpm, '/profile/dir')
    const pending = runtime.runPlugin('p', ['add', 'x'])
    expect(runtime.cancelActive()).toBe(true)
    expect(cancelled.count).toBe(1)
    await pending
  })

  it('cancelActive returns false when nothing is running', () => {
    const { pnpm } = fakePnpm({})
    const runtime = desktopRuntimeFor(pnpm, '/profile/dir')
    expect(runtime.cancelActive()).toBe(false)
  })

  it('refuses new runs after dispose', async () => {
    const { pnpm, calls } = fakePnpm({})
    const runtime = desktopRuntimeFor(pnpm, '/profile/dir')
    await runtime.dispose()
    const result = await runtime.runPlugin('p', ['add', 'x'])
    expect(result.exitCode).toBe(127)
    expect(result.stderr).toContain('disposed')
    expect(calls).toHaveLength(0)
  })

  it('stays inert across unrelated owners (no cross-runtime cancel)', async () => {
    const { pnpm } = fakePnpm({})
    const a = desktopRuntimeFor(pnpm, '/profile/dir')
    const b = desktopRuntimeFor(pnpm, '/profile/dir')
    const pending = a.runPlugin('p', ['add', 'x'])
    // b owns nothing, so it must not cancel a's handle.
    expect(b.cancelActive()).toBe(false)
    await pending
  })
})
