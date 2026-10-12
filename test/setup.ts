for (const [key, value] of [['columns', 80], ['rows', 24]] as const) {
  Object.defineProperty(process.stdout, key, { value, configurable: true, writable: true })
}
