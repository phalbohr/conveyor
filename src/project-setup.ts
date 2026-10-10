import type { Board, LinkedProject } from './board/board.js'
import type { Config } from './config.js'
import { SettingsDocument } from './settings-editor.js'

export type ProjectGap = { linked: LinkedProject[] }

export async function projectGap(board: Board, config: Config): Promise<ProjectGap | undefined> {
  if (config.board.provider !== 'github' || config.board.github_project) return undefined
  return { linked: await board.linkedProjects() }
}

export function projectGapLine(gap: ProjectGap) {
  if (gap.linked.length === 1) {
    const [project] = gap.linked
    return `The repository is linked to GitHub project ${project?.number} (${project?.title}), but board.github_project is not set, so the board shows no columns (conveyor board update sets it)`
  }
  if (gap.linked.length > 1) {
    return `The repository is linked to several GitHub projects (${gap.linked.map((project) => `${project.number} ${project.title}`).join(', ')}); choose one: conveyor config set board.github_project <number>`
  }
  return 'The repository has no GitHub project, so there is no board with columns (conveyor board update creates one and links it)'
}

export async function setUpProject(board: Board, config: Config, settings: string): Promise<{ number?: number; message?: string }> {
  const gap = await projectGap(board, config)
  if (!gap) return {}
  if (gap.linked.length > 1) return { message: projectGapLine(gap) }
  const project = gap.linked[0] ?? (await board.createProject(`${config.board.project.split('/')[1] ?? config.board.project} conveyor`))
  const doc = new SettingsDocument(settings)
  doc.set('board.github_project', String(project.number))
  const saved = doc.save()
  if (!saved.ok) throw new Error(saved.errors.join('; '))
  return {
    number: project.number,
    message: `${gap.linked.length ? 'Uses the linked' : 'Created and linked the'} GitHub project ${project.number} (${project.url}) and set board.github_project. In the project, choose the Board layout and "Column by: Conveyor" once.`,
  }
}
