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
