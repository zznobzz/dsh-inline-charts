/**
 * inline-charts (host half): agent tool `render_chart` + system-prompt section.
 *
 * The tool validates a chart/widget spec and returns the canonical wire value
 * `{protocol:'dsh.inline-chart', version:1, kind, spec}`. Wire v1.1 (frozen by
 * the captain): the RENDER channel is `output.presentationMeta` -> durable
 * `tool/result.meta` -> `ToolResultNode.meta`, which the client-side Chat
 * Definition reads. `output.render` stays model-facing and human-readable: one
 * text block with a short summary plus the fenced ```chart-json / ```chart-html
 * block (satisfies the t10 fence contract and gives the model a copyable
 * transcript form). Raw user data never rides the model-content channel alone —
 * the meta envelope is authoritative for rendering.
 *
 * Registration follows host-api-notes.md §1 (ctx.tools.register + defineTool)
 * and §2 (ctx.systemPrompt.section, order 9100).
 *
 * @module @local/inline-charts/host
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** Wire protocol marker shared with the client Definition. */
export const PROTOCOL = 'dsh.inline-chart'
/** Wire protocol version emitted by this host implementation. */
export const VERSION = 1
/** Max serialized envelope size in UTF-8 bytes (client decoder uses the same bound). */
export const MAX_ENVELOPE_BYTES = 262_144
/** Chart.js controller types the client renderer supports for kind "chart-json". */
export const CHART_TYPES = Object.freeze([
  'bar', 'line', 'scatter', 'bubble', 'pie', 'doughnut', 'polarArea', 'radar', 'area',
])

/** Name of the registered prompt-section slot (unique across the composition). */
const SECTION_NAME = 'tool:render_chart'
/** Section placement: free slot between DELIVERABLE_FILE_REFERENCES (9000) and STRUCTURED_OUTPUT (9900). */
const SECTION_ORDER = 9100

/**
 * Validate and normalize a chart spec. Throws a plain Error with a clear,
 * model-readable message; the executor surfaces it as a failed tool result
 * (never as a success envelope).
 * @param kind - 'chart-json' or 'chart-html'.
 * @param spec - untrusted JSON value from the model.
 * @returns the normalized spec object safe to serialize.
 */
export function validateSpec(kind, spec) {
  if (kind !== 'chart-json' && kind !== 'chart-html') {
    throw new Error(`render_chart: unknown kind "${String(kind)}" (expected "chart-json" or "chart-html")`)
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('render_chart: spec must be a JSON object')
  }
  if (kind === 'chart-html') {
    if (typeof spec.html !== 'string' || spec.html.trim() === '') {
      throw new Error('render_chart: spec.html must be a non-empty string with the self-contained widget document')
    }
    return spec
  }
  // chart-json: Chart.js config subset — {type?, data:{labels?, datasets:[...]}, options?}
  if (spec.type !== undefined && !CHART_TYPES.includes(spec.type)) {
    throw new Error(`render_chart: spec.type "${String(spec.type)}" is not supported (expected one of: ${CHART_TYPES.join(', ')})`)
  }
  const data = spec.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('render_chart: spec.data is required and must be an object like {labels, datasets}')
  }
  if (!Array.isArray(data.datasets) || data.datasets.length === 0) {
    throw new Error('render_chart: spec.data.datasets must be a non-empty array of series objects')
  }
  for (let i = 0; i < data.datasets.length; i++) {
    const ds = data.datasets[i]
    if (ds === null || typeof ds !== 'object' || Array.isArray(ds) || !Array.isArray(ds.data)) {
      throw new Error(`render_chart: spec.data.datasets[${i}] must be an object with a numeric "data" array`)
    }
  }
  if (data.labels !== undefined && !Array.isArray(data.labels)) {
    throw new Error('render_chart: spec.data.labels must be an array when present')
  }
  return spec
}

/**
 * Escape a payload so it can never terminate the surrounding markdown fence
 * early: every backtick inside the body gets a zero-width space after it.
 * The rendered text is visually identical, but no ``` run remains for the
 * markdown parser to match as a closing delimiter (CommonMark requires runs of
 * ASCII backticks).
 * @param text - raw fence body (JSON envelope or HTML source).
 * @returns fence-safe text.
 */
export function escapeFenceBody(text) {
  return text.replace(/`/gu, '`\u200b')
}

/** Max model-facing fence body in UTF-8 bytes (full envelope limit applies to meta). */
const MAX_FENCE_BODY_BYTES = 64_000

/**
 * Build the single fenced block the model-facing content carries.
 * @param kind - 'chart-json' or 'chart-html'.
 * @param body - already-validated fence body.
 * @returns "```chart-…\n…\n```" with no trailing newline.
 */
export function buildFence(kind, body) {
  return '```' + kind + '\n' + escapeFenceBody(body) + '\n```'
}

/**
 * Short human-readable summary line for the model (chart-json: type + series
 * and point counts; chart-html: widget size). Raw numbers ride the fence block
 * below it, so the summary stays compact.
 * @param value - canonical envelope.
 * @returns one-line summary string.
 */
export function summarizeEnvelope(value) {
  if (value.kind === 'chart-html') return `HTML widget (${String(value.spec.html).length} chars)`
  const datasets = Array.isArray(value.spec.data?.datasets) ? value.spec.data.datasets : []
  const points = datasets.reduce((total, ds) => total + (Array.isArray(ds?.data) ? ds.data.length : 0), 0)
  const type = typeof value.spec.type === 'string' ? value.spec.type : 'auto'
  return `${type} chart (${datasets.length} series, ${points} points)`
}

/**
 * Project the canonical envelope to the model-facing content: exactly one text
 * block with a short summary and one correctly fenced chart-json/chart-html
 * block. The render source of truth for the GUI is the meta channel (wire
 * v1.1); this content is the transcript form the model may quote verbatim.
 * Long payloads get a truncation notice instead of a (possibly invalid) fence.
 * @param _args - validated tool arguments (unused; the value is authoritative).
 * @param value - canonical envelope {protocol, version, kind, spec}.
 * @returns one-element ContentBlock array.
 */
export function renderEnvelope(_args, value) {
  const summary = `Chart emitted: ${summarizeEnvelope(value)}. It renders inline in the chat from the tool result; do not repeat or reformat the data.`
  const body = value.kind === 'chart-html' ? String(value.spec.html) : JSON.stringify(value.spec)
  const fenceBytes = new TextEncoder().encode(body).length
  if (fenceBytes > MAX_FENCE_BODY_BYTES) {
    return [{ type: 'text', text: `${summary} (payload too large to echo here: ${fenceBytes} bytes)` }]
  }
  return [{ type: 'text', text: `${summary}\n${buildFence(value.kind, body)}` }]
}

/**
 * Build the `render_chart` tool definition.
 * @returns registry-ready ToolDefinition.
 */
export function createRenderChartTool() {
  return defineTool({
    name: 'render_chart',
    description:
      'Emit an inline interactive chart or HTML/JS widget into the chat. '
      + 'kind="chart-json": pass a Chart.js-style spec {type, data:{labels, datasets:[{label, data:[…]}]}, options} '
      + 'with EXACT numbers; kind="chart-html": pass spec={html: "<self-contained widget source>"}. '
      + 'The GUI renders it live below the message; the tool returns the fenced block for your transcript. '
      + 'Do not use mermaid blocks, data-URI images or raw HTML/SVG for charts.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['chart-json', 'chart-html'],
        description: 'chart-json: declarative Chart.js config. chart-html: self-contained HTML/JS widget.',
      },
      spec: {
        type: 'json',
        description: 'For chart-json: {type?, data:{labels?, datasets:[{data:[…]}]}, options?} (no functions). '
          + 'For chart-html: {html: string} with the full widget document. '
          + 'A JSON string of the same object is accepted and parsed.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          protocol: { type: 'string', const: PROTOCOL },
          version: { type: 'integer', const: VERSION },
          kind: { type: 'string', enum: ['chart-json', 'chart-html'] },
          spec: { type: 'json' },
        },
      },
      render: renderEnvelope,
      presentationMeta: (_args, value) => ({ ...value }),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.spec === undefined || args.spec === null) {
        throw new Error('render_chart: spec is required')
      }
      // Models often pass the whole spec as a JSON string; parse it before validation.
      let rawSpec = args.spec
      if (typeof rawSpec === 'string') {
        try {
          rawSpec = JSON.parse(rawSpec)
        } catch {
          throw new Error('render_chart: spec is not valid JSON')
        }
      }
      const spec = validateSpec(args.kind, rawSpec)
      const value = { protocol: PROTOCOL, version: VERSION, kind: args.kind, spec }
      const bytes = new TextEncoder().encode(JSON.stringify(value)).length
      if (bytes > MAX_ENVELOPE_BYTES) {
        throw new Error(`render_chart: envelope is ${bytes} UTF-8 bytes, limit is ${MAX_ENVELOPE_BYTES}; reduce the data points or widget size`)
      }
      return value
    },
  })
}

/** The short formats contract injected into the system prompt. */
export const PROMPT_CONTRACT =
  'Charts and data widgets: call render_chart with the exact numbers in spec (kind "chart-json" for a Chart.js '
  + 'config {type, data:{labels, datasets}}, kind "chart-html" for a self-contained HTML/JS widget). '
  + 'It returns one fenced ```chart-json / ```chart-html block; you may quote that block verbatim once, but never '
  + 'reformat its contents. The GUI renders these blocks as live interactive charts. Do NOT use ```mermaid, '
  + 'data:image/svg+xml URIs, base64 images, raw HTML/SVG, or tikz/pgfplots for charts — none of them render.'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'inline-charts-host'
/** Services required by this host plugin row. */
export const inject = ['tools', 'systemPrompt']

/**
 * Cordis plugin entry: registers the tool and the prompt section on the
 * mounting context (effect-scoped: both are removed when the row disposes).
 * @param ctx - Cordis context providing `tools` and `systemPrompt`.
 */
export function apply(ctx) {
  const tool = createRenderChartTool()
  ctx.effect(() => ctx.tools.register(tool), 'inline-charts: render_chart tool')
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: ({ scope, toolSet }) => ctx.tools.get('render_chart', scope, toolSet) === undefined
      ? ''
      : PROMPT_CONTRACT,
  }), 'inline-charts: prompt section')
}
