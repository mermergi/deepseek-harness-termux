/**
 * Session initialization prompt as a system-prompt section.
 *
 * The shipped `@deepseek-ai/dsh-agent-instructions` reads `$DSH_HOME/AGENTS.md` — and the
 * project `AGENTS.md` / `CLAUDE.md` chain — but delivers them as a workspace-instructions
 * *reminder*: a user-role message spliced in with the turn. That is deliberate (it is how an
 * edit reaches a session that is already running), and it means the text sits after the first
 * user message rather than in the prompt the session starts from.
 *
 * This plugin registers the same user-global file as an ordinary system-prompt section. The
 * section is *global* (registered on the profile's root context), so every session of every
 * agent gets it, and its `text` is a function, so the section is re-read on each request and a
 * saved edit applies to the next request rather than the next session.
 *
 * The file is read defensively: absent, empty, unreadable and oversized all degrade to "no
 * section text" instead of failing the prompt build.
 *
 * @module @local/dsh-startup-prompt
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Plugin name; matches this package's name so the bundle row resolves. */
export const name = '@local/dsh-startup-prompt'

/** `systemPrompt` is the only service this needs: a missing one simply skips the row. */
export const inject = ['systemPrompt']

/**
 * Placement, from the harness's own registry (`SECTION_ORDERS`): 0 is the deployment persona
 * prefix and 500 the plan policy, so 100 puts the user's initialization text right after the
 * persona and ahead of everything a tool or policy section contributes.
 */
const SECTION_ORDER = 100

/** Section identity inside the prompt; `startup:` keeps it out of the harness's own names. */
const SECTION_NAME = 'startup:user-global'

/** The loader's own budget for instruction files; a larger file is truncated here too. */
const MAX_BYTES = 64 * 1024

/** @returns the user-global instruction file this section renders. */
function promptPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'AGENTS.md')
}

/**
 * @returns the file's text, or an empty string when it is absent, empty or unreadable.
 *          Called once per request, so a saved edit lands on the next one.
 */
function sectionText() {
  try {
    const file = promptPath()
    if (!statSync(file).isFile()) return ''
    const text = readFileSync(file, 'utf8').slice(0, MAX_BYTES)
    return text.trim() === '' ? '' : text
  } catch {
    return ''
  }
}

/**
 * @param ctx - profile root context; carries the injected {@link inject} services.
 */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: sectionText,
  })
}
