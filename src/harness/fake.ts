import { NO_USAGE, failed, type Harness, type StageOutput, type StageResult, type StageRun } from './harness.js'

export type Script = (run: StageRun, index: number) => StageResult | StageOutput | Promise<StageResult | StageOutput>

export class FakeHarness implements Harness {
  readonly runs: StageRun[] = []

  constructor(private readonly script: Script = () => ({ outcome: 'done', summary: 'ok' })) {}

  async runStage(run: StageRun): Promise<StageOutput> {
    const index = this.runs.push(run) - 1
    const aborted = new Promise<StageOutput>((resolve) => {
      const stop = () => resolve({ result: failed('stage aborted'), usage: NO_USAGE })
      if (run.signal?.aborted) stop()
      run.signal?.addEventListener('abort', stop, { once: true })
    })
    const output = Promise.resolve(this.script(run, index)).then((value) =>
      'result' in value ? value : { result: value, usage: { inputTokens: 100, outputTokens: 10 } },
    )
    return Promise.race([output, aborted])
  }
}
