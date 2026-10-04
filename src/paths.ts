export function expandPath(path: string, context: { home: string; project: string }) {
  return path.replace(/^~(?=$|\/)/, context.home).replaceAll('{project}', context.project.replaceAll('/', '-'))
}
