const CLEAR_SCREEN = '\u001B[2J\u001B[H'

export function clearOnShrink(stdout: NodeJS.WriteStream = process.stdout) {
  let width = stdout.columns
  const listener = () => {
    if (stdout.columns < width) stdout.write(CLEAR_SCREEN)
    width = stdout.columns
  }
  stdout.prependListener('resize', listener)
  return () => {
    stdout.off('resize', listener)
  }
}

export function repaintOnDisturbance(stdout: NodeJS.WritableStream, repaint: () => void, options: { every?: number; gap?: number } = {}) {
  const every = options.every ?? 5_000
  const gap = options.gap ?? 15_000
  const clear = () => {
    stdout.write(CLEAR_SCREEN)
    repaint()
  }
  stdout.prependListener('resize', clear)
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    if (now - last > every + gap) clear()
    last = now
  }, every)
  return () => {
    stdout.off('resize', clear)
    clearInterval(timer)
  }
}
