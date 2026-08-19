/**
 * Desktop-host adapter: bridge a desktop host's generation-scoped package
 * manager to the market's PluginCommandRuntime without any runtime import
 * of the desktop packages. The host supplies `desktopPnpm` only when the
 * market mounts inside a desktop shell; the adapter stays inert in an
 * ordinary host boot because that path never constructs it.
 * @module dsh-featured-plugins/desktop
 */

/** Structural subset of a desktop host's public `desktopPnpm` contract. */
export interface DesktopPnpmLike {
  runPlugin(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): {
    readonly stdout: NodeJS.ReadableStream
    readonly stderr: NodeJS.ReadableStream
    readonly done: Promise<{
      readonly exitCode: number | null
      readonly signal: NodeJS.Signals | null
    }>
    cancel(): void
  }
}

/** Structural subset of a desktop host's public `desktopProfiles` contract. */
export interface DesktopProfilesLike {
  readonly current: {
    readonly name: string
    readonly dir: string
  }
}

/** Outcome of one Desktop package operation, aligned with the spawn layer. */
export interface DesktopOpResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  cancelled: boolean
}

/** Captures one in-flight Desktop operation for cancellation. */
interface ActiveDesktopOp {
  readonly handle: ReturnType<DesktopPnpmLike['runPlugin']>
  readonly owner: symbol
}

/** A routed command runtime the HTTP layer can drive and cancel. */
export interface DesktopCommandRuntime {
  runPlugin(_profile: string, pluginArgs: readonly string[]): Promise<DesktopOpResult>
  cancelActive(): boolean
  dispose(): Promise<void>
}

/**
 * Wrap Desktop's packaged pnpm as the market's command runtime. The Desktop
 * provider already scopes the working directory to the active profile, so the
 * adapter forwards plugin args verbatim and treats the invoking directory as
 * the profile directory.
 * @param pnpm - the Host's `desktopPnpm` service.
 * @param profileDir - absolute path of the active Desktop profile.
 * @returns a {@link DesktopCommandRuntime} backed by the packaged pnpm.
 */
export function desktopRuntimeFor(
  pnpm: DesktopPnpmLike,
  profileDir: string,
): DesktopCommandRuntime {
  const owner = Symbol('dsh-featured-plugins desktop runtime')
  let active: ActiveDesktopOp | null = null
  let closed = false

  const fail = (message: string): DesktopOpResult => ({
    exitCode: 127,
    timedOut: false,
    stdout: '',
    stderr: message,
    cancelled: false,
  })

  return {
    async runPlugin(_profile, pluginArgs) {
      if (closed) return fail('dsh-featured-plugins: Desktop package runtime is disposed')
      const controller = new AbortController()
      let handle: ReturnType<DesktopPnpmLike['runPlugin']>
      try {
        handle = pnpm.runPlugin([...pluginArgs], profileDir, controller.signal)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
      active = { handle, owner }
      let stdout = ''
      let stderr = ''
      handle.stdout.on('data', (chunk: string | Buffer) => { stdout = (stdout + chunk.toString()).slice(-256 * 1024) })
      handle.stderr.on('data', (chunk: string | Buffer) => { stderr = (stderr + chunk.toString()).slice(-64 * 1024) })
      try {
        const outcome = await handle.done
        return {
          exitCode: outcome.exitCode,
          timedOut: false,
          stdout,
          stderr,
          cancelled: false,
        }
      } catch (error) {
        return fail(`${stderr}${stderr === '' ? '' : '\n'}${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (active?.owner === owner) active = null
        controller.abort()
      }
    },
    cancelActive() {
      if (active?.owner !== owner) return false
      active.handle.cancel()
      return true
    },
    async dispose() {
      closed = true
      if (active?.owner === owner) active.handle.cancel()
    },
  }
}
