for (const [key, value] of [['columns', 80], ['rows', 24]] as const) {
  Object.defineProperty(process.stdout, key, { value, configurable: true, writable: true })
}

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'conveyor test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'conveyor test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'init.defaultBranch',
  GIT_CONFIG_VALUE_0: 'main',
  GIT_CONFIG_KEY_1: 'commit.gpgsign',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'tag.gpgsign',
  GIT_CONFIG_VALUE_2: 'false',
})
