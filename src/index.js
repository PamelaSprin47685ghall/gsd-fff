/**
 * gsd-fff: FFF-powered file search extension for pi
 *
 * Overrides built-in `find` and `grep` tools with FFF and can also replace
 * @-mention autocomplete suggestions in the interactive editor.
 *
 * SAFETY: Every handler is wrapped in try-catch. renderCall/renderResult
 * handle missing `context` gracefully. The extension NEVER crashes pi.
 */

import { CustomEditor } from '@gsd/pi-coding-agent'
import { Text } from '@gsd/pi-tui'
import { Type } from '@sinclair/typebox'
import { buildQuery } from './query.js'

// ---------------------------------------------------------------------------
// Module-level fff-node lazy loader
// ---------------------------------------------------------------------------

let _fffNodeModule = null
let _fffNodeLoadError = null

async function ensureFffNodeModule() {
  if (_fffNodeModule) return _fffNodeModule
  if (_fffNodeLoadError) throw _fffNodeLoadError
  try {
    _fffNodeModule = await import('@ff-labs/fff-node')
    return _fffNodeModule
  } catch (err) {
    _fffNodeLoadError = new Error(
      'Missing dependency: @ff-labs/fff-node. Run `npm install` in the gsd-fff directory.',
      { cause: err },
    )
    throw _fffNodeLoadError
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GREP_LIMIT = 20
const DEFAULT_FIND_LIMIT = 30
const GREP_MAX_LINE_LENGTH = 500
const MENTION_MAX_RESULTS = 20

const VALID_MODES = ['tools-and-ui', 'tools-only', 'override']

const FFF_TOOL_NAMES = {
  grep: 'ffgrep',
  find: 'fffind',
  multiGrep: 'fff-multi-grep',
}
const OVERRIDE_TOOL_NAMES = {
  grep: 'grep',
  find: 'find',
  multiGrep: 'multi_grep',
}

function resolveToolNames(mode) {
  return mode === 'override' ? OVERRIDE_TOOL_NAMES : FFF_TOOL_NAMES
}

// ---------------------------------------------------------------------------
// Cursor store
// ---------------------------------------------------------------------------

const cursorCache = new Map()
let cursorCounter = 0

function storeCursor(cursor) {
  const id = `fff_c${++cursorCounter}`
  cursorCache.set(id, cursor)
  if (cursorCache.size > 200) {
    const first = cursorCache.keys().next().value
    if (first) cursorCache.delete(first)
  }
  return id
}

function getCursor(id) {
  return cursorCache.get(id)
}

const findCursorCache = new Map()
let findCursorCounter = 0

function storeFindCursor(cursor) {
  const id = `${++findCursorCounter}`
  findCursorCache.set(id, cursor)
  if (findCursorCache.size > 200) {
    const first = findCursorCache.keys().next().value
    if (first) findCursorCache.delete(first)
  }
  return id
}

function getFindCursor(id) {
  return findCursorCache.get(id)
}

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function truncateLine(line, max = GREP_MAX_LINE_LENGTH) {
  const trimmed = line.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`
}

const HOT_FRECENCY = 25
const WARM_FRECENCY = 20

function fffFileAnnotation(item) {
  try {
    const git = item.gitStatus
    if (git && git !== 'clean' && git !== 'unknown' && git !== '') {
      return `  [${git} in git]`
    }
    const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0
    if (frecency >= HOT_FRECENCY) return '  [VERY often touched file]'
    if (frecency >= WARM_FRECENCY) return '  [often touched file]'
  } catch {
    // best effort
  }
  return ''
}

function formatGrepOutput(result) {
  try {
    if (!result?.items?.length) return 'No matches found'
    const lines = []
    let currentFile = ''
    for (const match of result.items) {
      if (!match) continue
      if (match.relativePath !== currentFile) {
        if (lines.length > 0) lines.push('')
        currentFile = match.relativePath
        lines.push(`${currentFile}${fffFileAnnotation(match)}`)
      }
      match.contextBefore?.forEach((line, i) => {
        const lineNum = match.lineNumber - match.contextBefore.length + i
        lines.push(` ${lineNum}- ${truncateLine(line)}`)
      })
      lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`)
      match.contextAfter?.forEach((line, i) => {
        const lineNum = match.lineNumber + 1 + i
        lines.push(` ${lineNum}- ${truncateLine(line)}`)
      })
    }
    return lines.join('\n')
  } catch {
    return '(error formatting grep output)'
  }
}

const FIND_WEAK_SAMPLE_SIZE = 5

function weakScoreThreshold(pattern) {
  const perfect = (pattern || '').length * 12
  return Math.floor((perfect * 50) / 100)
}

function formatFindOutput(result, limit, pattern) {
  try {
    if (!result?.items?.length) {
      return { output: 'No files found matching pattern', weak: false, shownCount: 0 }
    }
    const topScore = result.scores?.[0]?.total ?? 0
    const weak = topScore < weakScoreThreshold(pattern)
    const effective = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit
    const shown = result.items.slice(0, effective)
    return {
      output: shown
        .map((p) => (p ? `${p.relativePath}${fffFileAnnotation(p)}` : ''))
        .filter(Boolean)
        .join('\n'),
      weak,
      shownCount: shown.length,
    }
  } catch {
    return { output: '(error formatting find output)', weak: false, shownCount: 0 }
  }
}

// ---------------------------------------------------------------------------
// Mention autocomplete helpers
// ---------------------------------------------------------------------------

function extractAtPrefix(textBeforeCursor) {
  const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/)
  return match?.[1] ?? null
}

function buildAtCompletionValue(path) {
  return path.includes(' ') ? `@"${path}"` : `@${path}`
}

function createFffMentionProvider(getItems) {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      try {
        const currentLine = lines?.[cursorLine] || ''
        const prefix = extractAtPrefix(currentLine.slice(0, cursorCol))
        if (!prefix || options?.signal?.aborted) return null
        const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1)
        const items = await getItems(query, options.signal)
        return options.signal.aborted || !items?.length ? null : { items, prefix }
      } catch {
        return null
      }
    },
    applyCompletion(_lines, cursorLine, cursorCol, item, prefix) {
      try {
        const currentLine = _lines?.[cursorLine] || ''
        const before = currentLine.slice(0, cursorCol - prefix.length)
        const after = currentLine.slice(cursorCol)
        const newLine = before + item.value + after
        const newCursorCol = cursorCol - prefix.length + item.value.length
        return {
          lines: [..._lines.slice(0, cursorLine), newLine, ..._lines.slice(cursorLine + 1)],
          cursorLine,
          cursorCol: newCursorCol,
        }
      } catch {
        return { lines: _lines, cursorLine, cursorCol }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Safe render helpers — context may be undefined (pi calls without 3rd arg)
// ---------------------------------------------------------------------------

function safeText(theme, context) {
  return context?.lastComponent ?? new Text('', 0, 0)
}

function safeRenderTextResult(result, options, theme, context, maxLines = 15) {
  try {
    const text = safeText(theme, context)
    const output = result?.content?.find((c) => c?.type === 'text')?.text?.trim() ?? ''
    if (!output) {
      text.setText(theme?.fg?.('muted', 'No output') ?? 'No output')
      return text
    }
    const lines = output.split('\n')
    const displayLines = lines.slice(0, options?.expanded ? lines.length : maxLines)
    let content = `\n${displayLines.map((line) => theme?.fg?.('toolOutput', line) ?? line).join('\n')}`
    if (lines.length > displayLines.length) {
      content += (theme?.fg?.('muted', `\n... (${lines.length - displayLines.length} more lines)`) ?? `\n... (${lines.length - displayLines.length} more lines)`)
    }
    text.setText(content)
    return text
  } catch {
    const text = new Text('', 0, 0)
    text.setText('(render error)')
    return text
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function fffExtension(pi) {
  let finder = null
  let finderCwd = null
  let finderPromise = null
  let activeCwd = process.cwd()

  let currentMode =
    pi.getFlag?.('fff-mode') ??
    process.env.PI_FFF_MODE ??
    'tools-and-ui'

  const toolNames = resolveToolNames(currentMode)

  const frecencyDbPath =
    pi.getFlag?.('fff-frecency-db') ??
    process.env.FFF_FRECENCY_DB ??
    undefined
  const historyDbPath =
    pi.getFlag?.('fff-history-db') ??
    process.env.FFF_HISTORY_DB ??
    undefined

  function getMode() { return currentMode }
  function setMode(mode) { currentMode = mode }

  function shouldEnableMentions() {
    return currentMode !== 'tools-only'
  }

  async function ensureFinder(cwd) {
    if (finder && !finder.isDestroyed && finderCwd === cwd) return finder
    if (finderPromise) return finderPromise

    finderPromise = (async () => {
      if (finder && !finder.isDestroyed) {
        try { finder.destroy() } catch { /* ignore */ }
        finder = null
        finderCwd = null
      }
      const mod = await ensureFffNodeModule()
      const result = mod.FileFinder.create({
        basePath: cwd,
        frecencyDbPath,
        historyDbPath,
        aiMode: true,
      })
      if (!result.ok) throw new Error(`Failed to create FFF file finder: ${result.error}`)
      finder = result.value
      finderCwd = cwd
      try { await finder.waitForScan(15000) } catch { /* scan timeout is non-fatal */ }
      return finder
    })().finally(() => { finderPromise = null })

    return finderPromise
  }

  function destroyFinder() {
    if (finder && !finder.isDestroyed) {
      try { finder.destroy() } catch { /* ignore */ }
      finder = null
      finderCwd = null
    }
  }

  async function getMentionItems(query, signal) {
    try {
      if (signal?.aborted) return []
      const f = await ensureFinder(activeCwd).catch(() => null)
      if (!f || signal?.aborted) return []
      const result = f.mixedSearch(query, { pageSize: MENTION_MAX_RESULTS })
      if (!result?.ok) return []
      return (result.value?.items || []).slice(0, MENTION_MAX_RESULTS).map((mixed) => {
        if (!mixed?.item) return null
        if (mixed.type === 'directory') {
          return { value: buildAtCompletionValue(mixed.item.relativePath), label: mixed.item.dirName, description: mixed.item.relativePath }
        }
        return { value: buildAtCompletionValue(mixed.item.relativePath), label: mixed.item.fileName, description: mixed.item.relativePath }
      }).filter(Boolean)
    } catch { return [] }
  }

  class FffEditor extends CustomEditor {
    baseProvider = undefined

    setAutocompleteProvider(provider) {
      this.baseProvider = provider
      const mentionProvider = createFffMentionProvider(getMentionItems)
      const compositeProvider = {
        getSuggestions: async (lines, cursorLine, cursorCol, options) => {
          try {
            const r = await mentionProvider.getSuggestions(lines, cursorLine, cursorCol, options)
            if (r) return r
            return this.baseProvider?.getSuggestions?.(lines, cursorLine, cursorCol, options) ?? null
          } catch { return null }
        },
        applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
          try {
            if (prefix?.startsWith('@')) return mentionProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
            return this.baseProvider?.applyCompletion?.(lines, cursorLine, cursorCol, item, prefix) ?? { lines, cursorLine, cursorCol }
          } catch { return { lines, cursorLine, cursorCol } }
        },
      }
      super.setAutocompleteProvider(compositeProvider)
    }
  }

  function applyEditorMode(ctx) {
    try {
      if (!shouldEnableMentions()) {
        ctx?.ui?.setEditorComponent?.(undefined)
      } else {
        ctx?.ui?.setEditorComponent?.(
          (tui, theme, keybindings) => new FffEditor(tui, theme, keybindings),
        )
      }
    } catch { /* editor mode is best-effort */ }
  }

  // --- Flags ---

  try { pi.registerFlag?.('fff-mode', { description: 'FFF mode: tools-and-ui | tools-only | override', type: 'string' }) } catch {}
  try { pi.registerFlag?.('fff-frecency-db', { description: 'Path to the frecency database (overrides FFF_FRECENCY_DB env)', type: 'string' }) } catch {}
  try { pi.registerFlag?.('fff-history-db', { description: 'Path to the query history database (overrides FFF_HISTORY_DB env)', type: 'string' }) } catch {}

  pi.on?.('session_start', async (_event, ctx) => {
    try {
      activeCwd = ctx?.cwd || process.cwd()
      await ensureFinder(activeCwd)
      applyEditorMode(ctx)
    } catch (e) {
      try { ctx?.ui?.notify?.(`FFF init failed: ${e instanceof Error ? e.message : String(e)}`, 'error') } catch {}
    }
  })

  pi.on?.('session_shutdown', async () => {
    destroyFinder()
  })

  // --- grep tool ---

  const grepSchema = Type.Object({
    pattern: Type.String({ description: 'Search pattern (literal text or regex)' }),
    path: Type.Optional(Type.String({ description: 'Repo-relative path constraint.' })),
    exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: 'Exclude paths.' })),
    caseSensitive: Type.Optional(Type.Boolean({ description: 'Force case-sensitive matching.' })),
    context: Type.Optional(Type.Number({ description: 'Context lines before+after each match' })),
    limit: Type.Optional(Type.Number({ description: `Max matches (default ${DEFAULT_GREP_LIMIT})` })),
    cursor: Type.Optional(Type.String({ description: 'Pagination cursor from previous result' })),
  })

  pi.registerTool({
    name: toolNames.grep,
    label: toolNames.grep,
    description: `Grep file contents. Smart-case, auto-detects regex vs literal, git-aware. Default limit ${DEFAULT_GREP_LIMIT}.`,
    promptSnippet: 'Grep contents',
    promptGuidelines: [
      "Prefer bare identifiers as patterns.",
      "Use path for include ('src/', '*.ts') and exclude for noise ('test/,*.min.js').",
      "caseSensitive: true when you need exact case (smart-case otherwise).",
      "After 1-2 greps, read the top match instead of more greps.",
    ],
    parameters: grepSchema,

    async execute(_toolCallId, params, signal) {
      try {
        if (signal?.aborted) return { content: [{ type: 'text', text: '(aborted)' }], details: {} }
        const f = await ensureFinder(activeCwd)
        const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT)
        const query = buildQuery(params.path, params.pattern, params.exclude, activeCwd)
        const hasRegexSyntax = params.pattern !== params.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        let mode = hasRegexSyntax ? 'regex' : 'plain'
        if (mode === 'regex') { try { new RegExp(params.pattern) } catch { mode = 'plain' } }

        const p = params.pattern.trim()
        const isWildcardOnly = hasRegexSyntax && /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(p)
        if (isWildcardOnly) {
          return { content: [{ type: 'text', text: `Pattern '${params.pattern}' matches everything — grep needs a concrete substring or identifier.` }], details: { totalMatched: 0, totalFiles: 0 } }
        }

        const smartCase = params.caseSensitive !== true
        const grepResult = f.grep(query, {
          mode, smartCase, maxMatchesPerFile: Math.min(effectiveLimit, 50),
          cursor: (params.cursor ? getCursor(params.cursor) : null) ?? null,
          beforeContext: params.context ?? 0, afterContext: params.context ?? 0, classifyDefinitions: true,
        })
        if (!grepResult?.ok) throw new Error(grepResult?.error || 'grep failed')

        let result = grepResult.value
        let fuzzyNotice = null
        if (!result?.items?.length && !params.cursor && mode !== 'regex') {
          try {
            const fuzzy = f.grep(params.pattern, { mode: 'fuzzy', smartCase, maxMatchesPerFile: Math.min(effectiveLimit, 50), cursor: null, beforeContext: 0, afterContext: 0, classifyDefinitions: true })
            if (fuzzy?.ok && fuzzy.value?.items?.length) { fuzzyNotice = '0 exact matches. Maybe you meant this?'; result = fuzzy.value }
          } catch { /* fuzzy fallback best-effort */ }
        }

        let output = formatGrepOutput(result)
        const notices = []
        if (result?.regexFallbackError) notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`)
        if (result?.nextCursor) notices.push(`Continue with cursor="${storeCursor(result.nextCursor)}"`)
        if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`
        if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`
        return { content: [{ type: 'text', text: output }], details: { totalMatched: result?.totalMatched ?? 0, totalFiles: result?.totalFiles ?? 0 } }
      } catch (err) {
        return { content: [{ type: 'text', text: `FFfgrep error: ${err instanceof Error ? err.message : String(err)}` }], details: {} }
      }
    },

    renderCall(args, theme, context) {
      try {
        const text = safeText(theme, context)
        const pattern = args?.pattern ?? ''
        const fpath = args?.path ?? '.'
        let c = (theme?.fg?.('toolTitle', theme.bold(toolNames.grep)) ?? toolNames.grep) + ' ' + (theme?.fg?.('accent', `/${pattern}/`) ?? `/${pattern}/`) + (theme?.fg?.('toolOutput', ` in ${fpath}`) ?? ` in ${fpath}`)
        if (args?.limit !== undefined) c += (theme?.fg?.('toolOutput', ` limit ${args.limit}`) ?? ` limit ${args.limit}`)
        if (args?.cursor) c += (theme?.fg?.('muted', ' (page)') ?? ' (page)')
        text.setText(c)
        return text
      } catch { const t = new Text('', 0, 0); t.setText(''); return t }
    },

    renderResult(result, options, theme, context) {
      return safeRenderTextResult(result, options, theme, context, 15)
    },
  })

  // --- find tool ---

  const findSchema = Type.Object({
    pattern: Type.String({ description: 'Fuzzy filename search and glob search. Frecency-ranked, git-aware.' }),
    path: Type.Optional(Type.String({ description: 'Repo-relative path constraint.' })),
    exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: 'Exclude paths.' })),
    limit: Type.Optional(Type.Number({ description: `Max results per page (default ${DEFAULT_FIND_LIMIT})` })),
    cursor: Type.Optional(Type.String({ description: 'Pagination cursor from previous result' })),
  })

  pi.registerTool({
    name: toolNames.find,
    label: toolNames.find,
    description: `Fuzzy path search and glob search. Frecency-ranked, git-aware. Default limit ${DEFAULT_FIND_LIMIT}.`,
    promptSnippet: 'Find files by path or glob',
    promptGuidelines: [
      'Matches the WHOLE path, not just the filename.',
      "Keep queries to 1-2 terms; extra words narrow.",
      "Use for paths, not content.",
      "For exact path matches use a glob in `path`.",
      "To list everything inside a directory, pass path: 'dir/**'.",
      "Use exclude: 'test/,*.min.js' to cut noise.",
    ],
    parameters: findSchema,

    async execute(_toolCallId, params, signal) {
      try {
        if (signal?.aborted) return { content: [{ type: 'text', text: '(aborted)' }], details: {} }
        const f = await ensureFinder(activeCwd)
        const resumed = params.cursor ? getFindCursor(params.cursor) : undefined
        const effectiveLimit = resumed ? resumed.pageSize : Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT)
        const query = resumed ? resumed.query : buildQuery(params.path, params.pattern, params.exclude, activeCwd)
        const pattern = resumed ? resumed.pattern : params.pattern
        const pageIndex = resumed?.nextPageIndex ?? 0
        const searchResult = f.fileSearch(query, { pageIndex, pageSize: effectiveLimit })
        if (!searchResult?.ok) throw new Error(searchResult?.error || 'find failed')
        const result = searchResult.value
        const formatted = formatFindOutput(result, effectiveLimit, pattern)
        let output = formatted.output
        const shownSoFar = pageIndex * effectiveLimit + (result?.items?.length ?? 0)
        const hasMore = (result?.items?.length ?? 0) >= effectiveLimit && (result?.totalMatched ?? 0) > shownSoFar
        const notices = []
        if (formatted.weak && formatted.shownCount > 0) notices.push(`Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result?.totalMatched ?? 0}.`)
        if (!formatted.weak && hasMore) {
          const remaining = (result?.totalMatched ?? 0) - shownSoFar
          const cursorId = storeFindCursor({ query, pattern, pageSize: effectiveLimit, nextPageIndex: pageIndex + 1 })
          notices.push(`${remaining} more match${remaining === 1 ? '' : 'es'} available. cursor="${cursorId}" to continue`)
        }
        if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`
        return { content: [{ type: 'text', text: output }], details: { totalMatched: result?.totalMatched ?? 0, totalFiles: result?.totalFiles ?? 0, pageIndex, hasMore } }
      } catch (err) {
        return { content: [{ type: 'text', text: `FFfind error: ${err instanceof Error ? err.message : String(err)}` }], details: {} }
      }
    },

    renderCall(args, theme, context) {
      try {
        const text = safeText(theme, context)
        const pattern = args?.pattern ?? ''
        const fpath = args?.path ?? '.'
        let c = (theme?.fg?.('toolTitle', theme.bold(toolNames.find)) ?? toolNames.find) + ' ' + (theme?.fg?.('accent', pattern) ?? pattern) + (theme?.fg?.('toolOutput', ` in ${fpath}`) ?? ` in ${fpath}`)
        if (args?.limit !== undefined) c += (theme?.fg?.('toolOutput', ` (limit ${args.limit})`) ?? ` (limit ${args.limit})`)
        if (args?.cursor) c += (theme?.fg?.('muted', ' (page)') ?? ' (page)')
        text.setText(c)
        return text
      } catch { const t = new Text('', 0, 0); t.setText(''); return t }
    },

    renderResult(result, options, theme, context) {
      return safeRenderTextResult(result, options, theme, context, 20)
    },
  })

  // --- multi_grep tool ---
  const enableMultiGrep = process.env.PI_FFF_MULTIGREP === '1'

  if (enableMultiGrep) {
    try {
      const multiGrepSchema = Type.Object({
        patterns: Type.Array(Type.String(), { description: 'Literal patterns (OR).' }),
        constraints: Type.Optional(Type.String({ description: "File filter, e.g. '*.{ts,tsx} !test/'" })),
        context: Type.Optional(Type.Number({ description: 'Context lines before+after' })),
        limit: Type.Optional(Type.Number({ description: `Max matches (default ${DEFAULT_GREP_LIMIT})` })),
        cursor: Type.Optional(Type.String({ description: 'Pagination cursor' })),
      })

      pi.registerTool({
        name: toolNames.multiGrep,
        label: toolNames.multiGrep,
        description: 'Search file contents for ANY of multiple literal patterns (OR, SIMD Aho-Corasick).',
        promptSnippet: 'Multi-pattern OR content search',
        promptGuidelines: ['Use when searching for several identifiers at once.', 'Include all naming-convention variants.', 'Patterns are literal. Use constraints for file filters.'],
        parameters: multiGrepSchema,

        async execute(_toolCallId, params, signal) {
          try {
            if (signal?.aborted) return { content: [{ type: 'text', text: '(aborted)' }], details: {} }
            if (!params.patterns?.length) return { content: [{ type: 'text', text: 'patterns array must have at least 1 element' }], details: {} }
            const f = await ensureFinder(activeCwd)
            const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT)
            const grepResult = f.multiGrep({
              patterns: params.patterns, constraints: params.constraints,
              maxMatchesPerFile: Math.min(effectiveLimit, 50), smartCase: true,
              cursor: (params.cursor ? getCursor(params.cursor) : null) ?? null,
              beforeContext: params.context ?? 0, afterContext: params.context ?? 0,
            })
            if (!grepResult?.ok) throw new Error(grepResult?.error || 'multi-grep failed')
            const result = grepResult.value
            let output = formatGrepOutput(result)
            const notices = []
            if ((result?.items?.length ?? 0) >= effectiveLimit) notices.push(`${effectiveLimit}+ matches (refine patterns)`)
            if (result?.nextCursor) notices.push(`More available. cursor="${storeCursor(result.nextCursor)}" to continue`)
            if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`
            return { content: [{ type: 'text', text: output }], details: { totalMatched: result?.totalMatched ?? 0, totalFiles: result?.totalFiles ?? 0, patterns: params.patterns } }
          } catch (err) {
            return { content: [{ type: 'text', text: `FFF multi-grep error: ${err instanceof Error ? err.message : String(err)}` }], details: {} }
          }
        },

        renderCall(args, theme, context) {
          try {
            const text = safeText(theme, context)
            const patterns = args?.patterns ?? []
            const constraints = args?.constraints
            let c = (theme?.fg?.('toolTitle', theme.bold(toolNames.multiGrep)) ?? toolNames.multiGrep) + ' ' + (theme?.fg?.('accent', patterns.map((p) => `"${p}"`).join(', ')) ?? patterns.map((p) => `"${p}"`).join(', '))
            if (constraints) c += (theme?.fg?.('toolOutput', ` (${constraints})`) ?? ` (${constraints})`)
            if (args?.cursor) c += (theme?.fg?.('muted', ' (page)') ?? ' (page)')
            text.setText(c)
            return text
          } catch { const t = new Text('', 0, 0); t.setText(''); return t }
        },

        renderResult(result, options, theme, context) {
          return safeRenderTextResult(result, options, theme, context, 15)
        },
      })
    } catch { /* multi-grep registration best-effort */ }
  }

  // --- commands ---

  pi.registerCommand('fff-mode', {
    description: 'Show or set FFF mode: /fff-mode [tools-and-ui | tools-only | override]',
    handler: async (args, ctx) => {
      try {
        const arg = (args || '').trim()
        if (!arg) {
          const mode = getMode()
          const flag = pi.getFlag?.('fff-mode') ?? 'unset'
          const env = process.env.PI_FFF_MODE ?? 'unset'
          try { ctx?.ui?.notify?.(`Current mode: '${mode}'\nFlag: ${flag}, Env: ${env}`, 'info') } catch {}
          return
        }
        if (!VALID_MODES.includes(arg)) {
          try { ctx?.ui?.notify?.(`Usage: /fff-mode [${VALID_MODES.join(' | ')}]`, 'warning') } catch {}
          return
        }
        const newMode = arg
        const oldMode = getMode()
        setMode(newMode)
        applyEditorMode(ctx)
        const note = (oldMode === 'override') !== (newMode === 'override') ? ' (tool name change requires restart)' : ''
        try { ctx?.ui?.notify?.(`Mode changed: '${oldMode}' → '${newMode}'${note}`, 'info') } catch {}
      } catch { /* best-effort */ }
    },
  })

  pi.registerCommand('fff-health', {
    description: 'Show FFF file finder health and status',
    handler: async (_args, ctx) => {
      try {
        if (!finder || finder.isDestroyed) {
          try { ctx?.ui?.notify?.('FFF not initialized', 'warning') } catch {}
          return
        }
        const health = finder.healthCheck()
        if (!health?.ok) {
          try { ctx?.ui?.notify?.(`Health check failed: ${health?.error || 'unknown'}`, 'error') } catch {}
          return
        }
        const h = health.value
        const lines = [
          `FFF v${h?.version || '?'}`,
          `Mode: ${getMode()}`,
          `Git: ${h?.git?.repositoryFound ? `yes (${h.git.workdir ?? 'unknown'})` : 'no'}`,
          `Picker: ${h?.filePicker?.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : 'not initialized'}`,
          `Frecency: ${h?.frecency?.initialized ? 'active' : 'disabled'}`,
          `Query tracker: ${h?.queryTracker?.initialized ? 'active' : 'disabled'}`,
        ]
        try {
          const progress = finder.getScanProgress()
          if (progress?.ok) lines.push(`Scanning: ${progress.value?.isScanning ? 'yes' : 'no'} (${progress.value?.scannedFilesCount ?? 0} files)`)
        } catch { /* best-effort */ }
        try { ctx?.ui?.notify?.(lines.join('\n'), 'info') } catch {}
      } catch { /* best-effort */ }
    },
  })

  pi.registerCommand('fff-rescan', {
    description: 'Trigger FFF to rescan files',
    handler: async (_args, ctx) => {
      try {
        if (!finder || finder.isDestroyed) {
          try { ctx?.ui?.notify?.('FFF not initialized', 'warning') } catch {}
          return
        }
        const result = finder.scanFiles()
        if (!result?.ok) {
          try { ctx?.ui?.notify?.(`Rescan failed: ${result?.error || 'unknown'}`, 'error') } catch {}
          return
        }
        try { ctx?.ui?.notify?.('FFF rescan triggered', 'info') } catch {}
      } catch { /* best-effort */ }
    },
  })
}
