/**
 * inline-charts (client half): live inline rendering of `render_chart` results
 * in the Harness Web GUI chat.
 *
 * Wire v1.1 (README.md, frozen by the captain): the RENDER channel is the
 * durable `tool/result.meta` envelope `{protocol:'dsh.inline-chart', version:1,
 * kind, spec}` written by host/index.js through `output.presentationMeta`.
 * The fenced ```chart-json / ```chart-html block in model content is a
 * human-readable transcript only and is NEVER parsed for rendering.
 *
 * Mechanism (plugin-api-notes.md §5-C + §Implementation hints + §t13):
 * - a ConversationNodeDefinition (`kind:'inline-chart', target:'chat'`) matches
 *   append-surface `tool/result` events whose meta decodes to our envelope;
 *   identity = `String(event.data.message.source.callId)` (one call = one
 *   widget; replay/fork reproduce the same id);
 * - a keyed renderer registered at `conversation.chat.node` under key
 *   `inline-chart` draws `node.data`: Chart.js on a canvas, or a sandboxed
 *   iframe for HTML widgets. Official assistant-step/tool renderers are not
 *   touched; the official tool card stays visible next to the widget row.
 *
 * Chart.js is vendored as a package-local classic-script chunk
 * (`client.chartjs.js`, UMD -> window.Chart), loaded lazily through the
 * module system's documented package-local chunk protocol: require.async on a
 * `./client.chartjs.js` sibling (plugin-api-notes.md §6: no CDN at runtime).
 *
 * Registration forms follow the decoration template and ui-plan /
 * ui-workflow-run precedents; React comes from the platform seed table only.
 *
 * @module zznobzz-dsh-inline-charts/client
 */
window.__ModuleLoader__.load({ id: 'zznobzz-dsh-inline-charts', factory: (require) => {
  'use strict';

  const React = require('react');
  const h = React.createElement;

  // ---------------------------------------------------------------------------
  // Wire constants — must stay in sync with host/index.js (PROTOCOL/VERSION).
  // ---------------------------------------------------------------------------

  /** Shared protocol marker written into `tool/result.meta` by the host tool. */
  const PROTOCOL = 'dsh.inline-chart';
  /** Accepted wire version. */
  const VERSION = 1;
  /** Max serialized envelope size in UTF-8 bytes (same bound as the host). */
  const MAX_ENVELOPE_BYTES = 262144;
  /** Chart.js controller types supported for kind "chart-json" (README list). */
  const CHART_TYPES = ['bar', 'line', 'scatter', 'bubble', 'pie', 'doughnut', 'polarArea', 'radar', 'area'];
  /** Hard cap on chart-html source bytes accepted by the client renderer. */
  const MAX_HTML_BYTES = 2097152;
  /** Frame height bounds for the HTML widget container. */
  const MIN_FRAME_HEIGHT = 40;
  const MAX_FRAME_HEIGHT = 4000;

  // ---------------------------------------------------------------------------
  // Envelope decoder (pure; runs inside match/start during event dispatch).
  // ---------------------------------------------------------------------------

  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function utf8ByteLength(text) {
    try {
      return new TextEncoder().encode(text).length;
    } catch (_error) {
      // No TextEncoder (non-browser): fall back to a conservative upper bound.
      return text.length * 3;
    }
  }

  /**
   * Decode one Session event into our envelope, or classify it as ours-but-broken.
   * Deliberately strict about the marker first: foreign tool results never reach
   * deeper validation. Returns one of:
   * - `{ status: 'ignore' }` — not our protocol (ordinary tool result, other meta);
   * - `{ status: 'error', reason }` — our marker present but the payload is broken
   *   (invalid shape / unsupported version / oversize). Broken JSON itself is
   *   impossible here: meta is already structured JSON produced by Host.
   * - `{ status: 'ok', envelope }` — validated envelope.
   * @param {unknown} event - durable or transient Client event handed to Definition.match.
   * @returns {{status: string, reason?: string, envelope?: object}}
   */
  function decodeChartEvent(event) {
    if (typeof event !== 'object' || event === null) return { status: 'ignore' };
    if (event.type !== 'tool/result') return { status: 'ignore' };
    // surfaceOp check mirrors isAppendSurfaceEvent without importing dsh-session
    // at runtime: only plain appends open/update our Context.
    if (event.surfaceOp !== 'append') return { status: 'ignore' };
    const data = event.data;
    if (typeof data !== 'object' || data === null) return { status: 'ignore' };
    if (typeof data.error === 'object' && data.error !== null) return { status: 'ignore' };
    const message = data.message;
    if (typeof message !== 'object' || message === null) return { status: 'ignore' };
    if (message.role !== 'tool' || message.isError === true) return { status: 'ignore' };
    const source = message.source;
    if (typeof source !== 'object' || source === null
      || source.kind !== 'tool' || typeof source.callId !== 'string' || source.callId === '') {
      return { status: 'ignore' };
    }
    const meta = data.meta;
    // Presence gate: no meta or a foreign meta is simply not ours.
    if (typeof meta !== 'object' || meta === null) return { status: 'ignore' };
    if (meta.protocol !== PROTOCOL) return { status: 'ignore' };
    // From here on the marker matched: everything failing is OURS and broken.
    if (meta.version !== VERSION) {
      return { status: 'error', reason: 'Неподдерживаемая версия протокола графиков: ' + String(meta.version) + ' (ожидается ' + VERSION + ').' };
    }
    const reason = validateEnvelope(meta);
    if (reason !== undefined) return { status: 'error', reason };
    const serialized = safeStringify(meta);
    if (serialized === undefined) {
      return { status: 'error', reason: 'Спецификация графика не сериализуется как корректный JSON.' };
    }
    if (utf8ByteLength(serialized) > MAX_ENVELOPE_BYTES) {
      return { status: 'error', reason: 'Полезная графика превышает лимит ' + MAX_ENVELOPE_BYTES + ' UTF-8 байт.' };
    }
    return { status: 'ok', envelope: meta };
  }

  function safeStringify(value) {
    try {
      const text = JSON.stringify(value);
      return typeof text === 'string' ? text : undefined;
    } catch (_error) {
      return undefined;
    }
  }

  /**
   * Validate kind/spec of a marker-matched envelope.
   * @param {object} envelope - {protocol, version, kind, spec}.
   * @returns {string | undefined} human-readable error, or undefined when valid.
   */
  function validateEnvelope(envelope) {
    if (envelope.kind !== 'chart-json' && envelope.kind !== 'chart-html') {
      return 'Неизвестный вид графика: ' + String(envelope.kind) + '.';
    }
    const spec = envelope.spec;
    if (!isPlainObject(spec)) return 'Поле spec должно быть JSON-объектом.';
    if (envelope.kind === 'chart-html') {
      if (typeof spec.html !== 'string' || spec.html === '') return 'chart-html требует непустую строку spec.html.';
      if (utf8ByteLength(spec.html) > MAX_HTML_BYTES) {
        return 'HTML-виджет превышает лимит ' + MAX_HTML_BYTES + ' UTF-8 байт.';
      }
      return undefined;
    }
    // chart-json
    if (typeof spec.type !== 'string' || !CHART_TYPES.includes(spec.type)) {
      return 'Неподдерживаемый тип графика: ' + String(spec.type)
        + '. Допустимые: ' + CHART_TYPES.join(', ') + '.';
    }
    if (!isPlainObject(spec.data)) return 'spec.data должен быть объектом Chart.js.';
    const datasets = spec.data.datasets;
    if (!Array.isArray(datasets) || datasets.length === 0) {
      return 'spec.data.datasets должен быть непустым массивом рядов.';
    }
    for (const dataset of datasets) {
      if (!isPlainObject(dataset)) return 'Каждый ряд datasets должен быть объектом.';
      if (!Array.isArray(dataset.data)) return 'У каждого ряда datasets поле data должно быть массивом значений.';
      // Non-finite numbers would be rejected by Session.append as meta anyway
      // (isJsonValue), but a hand-crafted older event could carry them.
      for (const point of dataset.data) {
        if (typeof point === 'number' && !Number.isFinite(point)) {
          return 'spec содержит нечисловые значения (NaN/Infinity).';
        }
      }
    }
    if (spec.options !== undefined && !isPlainObject(spec.options)) {
      return 'spec.options должен быть объектом.';
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Vendored Chart.js loader: lazy package-local chunk, no CDN.
  // ---------------------------------------------------------------------------

  /** Resolved window.Chart constructor once the vendor chunk has executed. */
  let chartCtor;
  let chartLoadPromise;

  function loadChartLibrary() {
    if (chartCtor !== undefined) return Promise.resolve(chartCtor);
    if (chartLoadPromise === undefined) {
      // Documented chunk protocol: require.async on the package-local sibling
      // loads `<plugins>/zznobzz-dsh-inline-charts/client.chartjs.js?rev=<current>`
      // — the flattened package name is one path segment — as a classic
      // script which registers the sibling factory and assigns window.Chart
      // (UMD). Failures are retryable (the promise is reset).
      chartLoadPromise = require.async('./client.chartjs.js').then(
        () => {
          const ctor = typeof window !== 'undefined' ? window.Chart : undefined;
          if (typeof ctor !== 'function') throw new Error('vendor/chart.umd.js не объявил window.Chart');
          chartCtor = ctor;
          return ctor;
        },
        (cause) => {
          chartLoadPromise = undefined;
          throw cause;
        },
      );
    }
    return chartLoadPromise;
  }

  // ---------------------------------------------------------------------------
  // Widgets.
  // ---------------------------------------------------------------------------

  /** Neutral surface styling via theme tokens; literal colors only as fallbacks. */
  const rowStyle = {
    margin: '8px 0',
    padding: '12px',
    borderRadius: '12px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
    background: 'var(--dsw-alias-bg-base, rgba(128,128,128,.06))',
    boxSizing: 'border-box',
  };

  function ErrorCard(props) {
    return h('div', {
      style: rowStyle,
      role: 'alert',
      'data-inline-chart': 'error',
    }, [
      h('div', {
        key: 'title',
        style: {
          fontWeight: 600,
          marginBottom: '4px',
          color: 'var(--dsw-alias-state-error-primary, #d43c3c)',
        },
      }, 'График не отображён'),
      h('div', {
        key: 'detail',
        style: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '13px' },
      }, props.reason),
    ]);
  }

  /**
   * Chart.js widget: one independent Chart instance per node; destroyed on
   * unmount (and before any rebuild), canvas-only DOM access, no globals.
   */
  function ChartWidget(props) {
    const canvasRef = React.useRef(null);
    const [error, setError] = React.useState();
    React.useEffect(() => {
      let disposed = false;
      let chart;
      loadChartLibrary().then((Chart) => {
        if (disposed || canvasRef.current === null) return;
        try {
          chart = new Chart(canvasRef.current, {
            type: props.spec.type,
            data: props.spec.data,
            options: Object.assign({ responsive: true, maintainAspectRatio: false }, props.spec.options || {}),
          });
        } catch (cause) {
          if (!disposed) setError('Ошибка построения графика: ' + String((cause && cause.message) || cause));
        }
      }, (cause) => {
        if (!disposed) setError('Не удалось загрузить Chart.js: ' + String((cause && cause.message) || cause));
      });
      return () => {
        disposed = true;
        if (chart !== undefined) {
          try { chart.destroy(); } catch (_cause) { /* already gone */ }
        }
      };
    }, [props.spec]);
    return h('div', {
      style: Object.assign({}, rowStyle, { height: '320px' }),
      'data-inline-chart': 'chart-json',
    }, error !== undefined
      ? h(ErrorCard, { reason: error })
      : h('canvas', { ref: canvasRef, 'aria-label': 'График ' + props.spec.type, role: 'img' }));
  }

  /** CSP for the sandbox document: inline scripts/styles allowed inside the frame only, no network, no framing of others. */
  const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

  function randomNonce() {
    const webCrypto = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
    if (webCrypto !== undefined && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
    let out = '';
    while (out.length < 32) out += Math.random().toString(36).slice(2);
    return out.slice(0, 32);
  }

  /**
   * Compose the full sandbox document: CSP meta FIRST, then the bootstrap
   * resize reporter (plain DOM measurement — the frame cannot see the parent),
   * then the verbatim user document body. User HTML is appended as data after
   * all generated markup; it is never interpolated into an executable JS
   * template. The nonce rides ONLY in the bootstrap script string, which is
   * JSON-encoded there, so user content cannot read or forge it.
   * @param {string} html - spec.html (already shape- and size-validated).
   * @param {string} nonce - fresh per-mount handshake token.
   * @returns {string} complete srcdoc document.
   */
  function buildFrameDocument(html, nonce) {
    const bootstrap = '<script>(function(){'
      + 'var NONCE=' + JSON.stringify(nonce) + ';'
      + 'function measure(){'
      + 'var el=document.body;if(!el)return null;'
      + 'var r=el.getBoundingClientRect();'
      + 'return Math.ceil(Math.max(r.height,el.scrollHeight,'
      + '(document.documentElement?document.documentElement.scrollHeight:0)));'
      + '}'
      + 'function send(){try{parent.postMessage({type:"dsh-inline-chart-resize",nonce:NONCE,height:measure()},"*");}catch(e){}}'
      + 'if(typeof ResizeObserver!=="undefined"){try{new ResizeObserver(send).observe(document.documentElement||document.body);}catch(e){}}'
      + 'window.addEventListener("load",send);'
      + 'var n=0;function tick(){send();if(++n<20)setTimeout(tick,100);}'
      + 'send();setTimeout(tick,100);'
      + '})();<\/script>';
    return '<!doctype html><html><head>'
      + '<meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="' + FRAME_CSP + '">'
      + '<style>html,body{margin:0;padding:0;background:transparent}</style>'
      + '</head><body>'
      + bootstrap
      + html
      + '</body></html>';
  }

  /**
   * HTML widget: opaque-origin sandbox (`allow-scripts` WITHOUT
   * `allow-same-origin`), srcdoc generated with CSP before user content.
   * Resize arrives through postMessage guarded by (a) per-mount nonce and
   * (b) `event.source === frame.contentWindow` — origin is 'null' for a
   * sandboxed frame and authenticates nothing, so it is never used as a filter.
   * The message listener is attached per concrete frame mount and removed on
   * unmount: remounting srcdoc replaces contentWindow, and a closure over the
   * old window would silently lose resize events.
   */
  function HtmlWidget(props) {
    const frameRef = React.useRef(null);
    const [height, setHeight] = React.useState(240);
    // Fresh nonce per mount AND per srcdoc revision: every remount creates a
    // new browsing context that must introduce itself again.
    const handshake = React.useMemo(() => ({ nonce: randomNonce(), html: props.spec.html }), [props.spec.html]);
    const srcDoc = React.useMemo(
      () => buildFrameDocument(handshake.html, handshake.nonce),
      [handshake],
    );
    React.useEffect(() => {
      const frame = frameRef.current;
      if (frame === null) return undefined;
      const onMessage = (event) => {
        // Authenticate the SENDER, not the origin: opaque-origin frames report
        // origin 'null'; only the exact contentWindow of this mount passes.
        if (event.source !== frame.contentWindow) return;
        const payload = event.data;
        if (typeof payload !== 'object' || payload === null) return;
        if (payload.nonce !== handshake.nonce) return;
        if (payload.type !== 'dsh-inline-chart-resize') return;
        const next = Number(payload.height);
        if (!Number.isFinite(next)) return;
        setHeight(Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(next))));
      };
      // Listener lifetime is bound to THIS frame element: cleanup removes it
      // before the next effect run rebinds to the replaced contentWindow.
      window.addEventListener('message', onMessage);
      return () => { window.removeEventListener('message', onMessage); };
    }, [srcDoc, handshake]);
    return h('div', {
      style: Object.assign({}, rowStyle, { height: height + 'px', padding: '0', overflow: 'hidden' }),
      'data-inline-chart': 'chart-html',
    }, h('iframe', {
      ref: frameRef,
      title: 'HTML-виджет',
      srcDoc: srcDoc,
      sandbox: 'allow-scripts',
      referrerPolicy: 'no-referrer',
      style: { width: '100%', height: '100%', border: 'none', display: 'block', background: 'transparent' },
    }));
  }

  // ---------------------------------------------------------------------------
  // Node view: chooses widget/error card from node.data (the decoded envelope).
  // ---------------------------------------------------------------------------

  function InlineChartNodeView(props) {
    const node = props.node;
    const data = node !== undefined ? node.data : undefined;
    if (data === undefined) return null;
    if (data.status === 'error') return h(ErrorCard, { reason: data.reason });
    if (data.status !== 'ok') return null;
    return h(data.envelope.kind === 'chart-json' ? ChartWidget : HtmlWidget, {
      key: node.key,
      spec: data.envelope.spec,
    });
  }

  // ---------------------------------------------------------------------------
  // Conversation Definition (skeleton from plugin-api-notes.md §t13).
  // ---------------------------------------------------------------------------

  /**
   * Fold a decode outcome into Context state, or undefined when unrelated.
   * State carries the anchor seq plus the renderer-facing slice only.
   */
  function decodeToState(decoded, event) {
    if (decoded.status === 'ignore') return undefined;
    return {
      status: decoded.status,
      reason: decoded.reason,
      envelope: decoded.envelope,
      seq: typeof event.seq === 'number' ? event.seq : 0,
    };
  }

  const chartDefinition = {
    kind: 'inline-chart',
    target: 'chat',
    // Function-form matcher: we claim ONLY our envelope; every other
    // tool/result returns null and still reaches the official tool-call
    // Definition and the unmatched-event fallback untouched.
    match(event) {
      const decoded = decodeChartEvent(event);
      if (decoded.status === 'ignore') return null;
      const callId = event.data.message.source.callId;
      // One tool call = one widget context; replay/fork reuse the same id.
      return { id: String(callId), role: 'start' };
    },
    start(context, match) {
      const state = decodeToState(decodeChartEvent(match.event), match.event);
      return state === undefined
        ? { status: 'error', reason: 'Пустой результат графика.', seq: match.event.seq }
        : state;
    },
    update(context, match) {
      // A second accepted result for the same callId replaces the state
      // (v1 does not promise targeted updates, but staying consistent costs nothing).
      const state = decodeToState(decodeChartEvent(match.event), match.event);
      return state === undefined ? context.state : state;
    },
    buildViewNode(context) {
      const state = context.state;
      if (state === undefined) return null;
      const start = context.start !== undefined ? context.start : context.matches[0];
      const location = start !== undefined
        ? start.location
        : { kind: 'unresolved' };
      return {
        key: context.key,
        kind: 'inline-chart',
        id: context.id,
        target: 'chat',
        anchorSeq: start !== undefined ? start.event.seq : state.seq,
        location: location,
        visibility: 'visible',
        data: { status: state.status, reason: state.reason, envelope: state.envelope },
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Plugin face consumed by the Cordis loader.
  // ---------------------------------------------------------------------------

  return {
    // Service dependencies (export-level `inject`, NOT dsh.client.inject ordering).
    inject: ['slots', 'uiConversation'],
    apply(ctx) {
      // Definition first: without it the keyed slot entry would never receive a node.
      ctx.effect(
        () => ctx.uiConversation.events.register(chartDefinition),
        'inline-charts: conversation definition',
      );
      // Keyed renderer under our own kind; official keys stay intact.
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'inline-chart',
      }, InlineChartNodeView));
    },
  };
} });
