/**
 * inline-charts (client half): live inline rendering of `render_chart` results
 * in the Harness Web GUI chat.
 *
 * Wire v1.2 (README.md, frozen by the captain after t21/t22): the RENDER
 * channel is the durable `tool/result.meta` envelope
 * `{protocol:'dsh.inline-chart', version:1, kind, spec}` written by
 * host/index.js through `output.presentationMeta`. The fenced ```chart-json /
 * ```chart-html block in model content is a human-readable transcript only
 * and is NEVER parsed for rendering.
 *
 * Mechanism (plugin-api-notes.md §Implementation hints, ui-schedule precedent):
 * - a state-only ConversationNodeDefinition (`kind:'inline-charts'`, NO target)
 *   matches append-surface `tool/result` events whose meta decodes to our
 *   envelope; Context identity is the TURN number (`String(event.data.turn)`),
 *   so one Context accumulates every chart of its Turn, deduped/replaced by the
 *   per-item callId identity (replay/fork reproduce both);
 * - the Definition publishes the accumulated list through `buildLocationData`
 *   at scope 'turn' under key 'inline-charts' (the engine requires
 *   data.key === definition.kind), i.e. into ConversationTurnDataMap;
 * - the renderer is ONE list entry in the official `conversation.chat.turnTail`
 *   slot (`id:'inline-charts.row'`): keyed `conversation.chat.node` dispatch is
 *   closed to ChatNodeKind (t21 verdict) and plain JS cannot extend it, so the
 *   custom kind never relied on here. Widgets render at the end of their closed
 *   Turn; the official tool card stays visible as usual.
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

  /** Diagnostic prefix shared by every console line of this plugin (t26). */
  const LOG = '[inline-charts]';
  console.log(LOG, 'factory executed');

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
    // v1.3: two durable carriers of a render_chart outcome.
    // - model-direct tool call: `tool/result` (surface append, envelope in
    //   data.meta, identity in data.message.source.callId);
    // - run_code PTC sub-dispatch: `tool/ptc-dispatch` (log-only, NO message/
    //   surfaceOp and NO turn field; name must be our tool, identity is
    //   data.subCallId, envelope again in data.meta). Precedent for matching
    //   both: ui-plan submittedPlan / ui-chat tool definition.
    if (event.type === 'tool/result') return decodeToolResult(event);
    if (event.type === 'tool/ptc-dispatch') return decodePtcDispatch(event);
    return { status: 'ignore' };
  }

  /**
   * Shared marker gate: presence + protocol + version + spec validation and
   * size bounds, identical for both carriers.
   * @param {unknown} meta - candidate presentation meta from the event data.
   * @returns {{status: string, reason?: string, envelope?: object}}
   */
  function decodeEnvelope(meta) {
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

  /** v1.1 branch (unchanged): model-direct `tool/result` surface append. */
  function decodeToolResult(event) {
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
    return decodeEnvelope(data.meta);
  }

  /** v1.3 branch: settled `tool/ptc-dispatch` of render_chart inside run_code. */
  function decodePtcDispatch(event) {
    const data = event.data;
    if (typeof data !== 'object' || data === null) return { status: 'ignore' };
    // PTC dispatch names its tool right on the event — unlike tool/result, the
    // identity here IS authenticated by name (plus the meta marker).
    if (data.name !== 'render_chart') return { status: 'ignore' };
    if (typeof data.error === 'object' && data.error !== null) return { status: 'ignore' };
    if (data.isError === true) return { status: 'ignore' };
    if (typeof data.subCallId !== 'string' || data.subCallId === '') return { status: 'ignore' };
    return decodeEnvelope(data.meta);
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
      // — the scoped package name is a two-segment path prefix — as a classic
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
  // Turn-tail row: one list entry per Turn; subscribes to the engine-published
  // location data ('inline-charts' under ConversationTurnDataMap) and renders
  // every widget of this Turn in anchorSeq order. Empty list -> null (the row
  // contributes nothing). Widgets keep their data-inline-chart markers for the
  // live acceptance checks.
  // ---------------------------------------------------------------------------

  function ChartTailRow(props) {
    const turn = props.turn;
    // Identity-stable subscribe/get pair per owner TurnLocation: the engine
    // keeps one data store per Turn, so its keyed source listeners survive
    // re-renders without resubscribing.
    const sources = React.useMemo(() => ({
      subscribe: (listener) => turn.data.source('inline-charts').subscribe(listener),
      get: () => {
        const value = turn.data.get('inline-charts');
        return Array.isArray(value) ? value : undefined;
      },
    }), [turn]);
    const items = React.useSyncExternalStore(sources.subscribe, sources.get);
    // Diagnostic: one compact line per actual data change (render commit), not
    // per re-render — the effect deps are the published list identity.
    React.useEffect(() => {
      console.log(LOG, 'row render', 'turn=' + turn.turn, 'n=' + (items === undefined ? 'none' : items.length));
    }, [items]);
    if (items === undefined || items.length === 0) return null;
    return h('div', {
      style: { display: 'flex', flexDirection: 'column', gap: '8px' },
      'data-inline-charts-row': String(turn.turn),
    }, items.map((item) => h(item.status === 'error' ? ErrorCard : (item.envelope.kind === 'chart-json' ? ChartWidget : HtmlWidget), {
      // callId is the stable item identity from the durable event; seq breaks
      // any theoretical duplicate id within one Turn.
      key: item.callId + ':' + item.seq,
      reason: item.reason,
      spec: item.status === 'ok' ? item.envelope.spec : undefined,
    })));
  }

  // ---------------------------------------------------------------------------
  // Conversation Definition (v1.3: state-only accumulator + buildLocationData;
  // no target, no keyed node kind — see t21 verdict / ui-schedule precedent.
  // v1.3 adds the `tool/ptc-dispatch` carrier for run_code-dispatched calls).
  // ---------------------------------------------------------------------------

  /**
   * Read the durable Turn coordinate of one accepted event.
   * `tool/result` carries data.turn directly; `tool/ptc-dispatch` has NO turn
   * field (log-only PTC payload), so its number comes from the match Location
   * resolved by the engine (`match.location.turn.turn`).
   * @param {object} event - Session event already validated by decodeChartEvent.
   * @param {object} [location] - engine-resolved Location of this match.
   * @returns {number | undefined} the Turn number, or undefined when unresolved.
   */
  function eventTurnOf(event, location) {
    const direct = event.data.turn;
    if (typeof direct === 'number' && Number.isSafeInteger(direct)) return direct;
    if (location !== undefined && (location.kind === 'turn' || location.kind === 'step')) {
      const turn = location.turn.turn;
      if (Number.isSafeInteger(turn)) return turn;
    }
    return undefined;
  }

  /**
   * Stable per-call identity of one accepted event: tool/result rides
   * message.source.callId, ptc-dispatch rides data.subCallId.
   * @param {object} event - accepted chart event (either carrier).
   * @returns {string} the call identity used for list dedupe/replacement.
   */
  function eventCallId(event) {
    if (event.type === 'tool/ptc-dispatch') return String(event.data.subCallId);
    return String(event.data.message.source.callId);
  }

  /**
   * Fold one accepted decode into the Turn's accumulated item list.
   * Identity inside the list is the tool-call id: a repeated result for
   * the same call replaces its item instead of duplicating the widget.
   * @param {object[]} items - current immutable list.
   * @param {object} decoded - decodeChartEvent outcome (status ok|error).
   * @param {object} event - the accepted chart event.
   * @returns {object[]} new list when changed, otherwise the same reference.
   */
  function foldItem(items, decoded, event) {
    const callId = eventCallId(event);
    const seq = typeof event.seq === 'number' ? event.seq : 0;
    const next = decoded.status === 'ok'
      ? { status: 'ok', callId, seq, envelope: decoded.envelope }
      : { status: 'error', callId, seq, reason: decoded.reason };
    for (let index = 0; index < items.length; index++) {
      const previous = items[index];
      if (previous.callId !== callId) continue;
      // Replay-safe replacement keeps list order; identical content keeps identity.
      if (previous.seq === next.seq && previous.status === next.status
        && (previous.envelope === next.envelope || previous.reason === next.reason)) return items;
      const copy = items.slice();
      copy[index] = next;
      return copy;
    }
    return items.concat([next]);
  }

  /**
   * Sort by anchor seq without mutating; called only when the list changed.
   * @param {object[]} items - accumulated widget items.
   * @returns {object[]} items ordered by their durable event seq.
   */
  function sortedItems(items) {
    let sorted = false;
    for (let index = 1; index < items.length; index++) {
      if (items[index].seq < items[index - 1].seq) { sorted = true; break; }
    }
    return sorted ? items.slice().sort((left, right) => left.seq - right.seq) : items;
  }

  /**
   * Compact payload-key fingerprint for diagnostics (never logs envelope
   * bodies — only the shape the decoder saw).
   * @param {object} event - candidate chart event.
   * @returns {string} short description of the discriminating fields.
   */
  function payloadShape(event) {
    const data = typeof event.data === 'object' && event.data !== null ? event.data : {};
    if (event.type === 'tool/ptc-dispatch') {
      return 'name=' + String(data.name) + ' subCallId=' + String(data.subCallId)
        + ' isError=' + String(data.isError) + ' metaKeys=' + Object.keys(data.meta || {}).join(',');
    }
    const message = typeof data.message === 'object' && data.message !== null ? data.message : {};
    const source = typeof message.source === 'object' && message.source !== null ? message.source : {};
    return 'surfaceOp=' + String(event.surfaceOp) + ' callId=' + String(source.callId)
      + ' isError=' + String(message.isError) + ' metaKeys=' + Object.keys(data.meta || {}).join(',');
  }

  const chartDefinition = {
    // The engine requires published data.key === definition.kind, so this kind
    // IS the ConversationTurnDataMap key 'inline-charts'.
    kind: 'inline-charts',
    // State-only Context: NO target and NO buildViewNode (assertDefinitionTarget
    // accepts the pair only together; ui-schedule's schedule-created proves the
    // data-only shape mounts and publishes live).
    // Function-form matcher: we claim ONLY our envelope on both carriers
    // (tool/result surface append; tool/ptc-dispatch settled run_code call);
    // every other event returns null and still reaches the official tool-call
    // Definition and the unmatched-event fallback untouched.
    match(event) {
      if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return null;
      const decoded = decodeChartEvent(event);
      if (decoded.status === 'ignore') {
        console.log(LOG, 'match miss', event.type, payloadShape(event));
        return null;
      }
      // One Context per Turn owns that Turn's whole widget list; the per-call
      // identity lives inside each item (callId / subCallId). CRITICAL: exactly
      // ONE publisher per Turn store key — two Contexts of this kind resolving
      // to the same Turn would make the engine throw 'already owned'
      // (location-index set()). ptc-dispatch carries NO turn field and match()
      // sees only the bare event, so its numeric Turn is unknowable at match
      // time. The stable grouping that never collides is the ROOT CALL: all
      // charts dispatched by one run_code program share rootCallId, and one
      // root call belongs to exactly one Turn, so id='run:'+rootCallId yields a
      // single publisher per run. Its Turn resolves from the engine-attached
      // match Location (dispatchInput indexes coordinates before handlers run;
      // refreshMatchLocations replays start() when a boundary lands later) and
      // is adopted in start/update below. A model-direct tool/result keeps the
      // numeric data.turn id — different id space, and both carriers can only
      // describe the SAME widget if the same call arrived twice, which cannot
      // cross carriers (a call is either model-direct or PTC), so no double
      // publisher exists for one chart. Two concurrent run_code programs in one
      // Turn WOULD collide on the store key; the buildLocationData self-check +
      // [inline-charts] logs surface that loudly instead of silently doubling.
      const turn = eventTurnOf(event, undefined);
      if (turn === undefined) {
        const rootCallId = event.data.rootCallId;
        if (typeof rootCallId !== 'string' || rootCallId === '') {
          console.log(LOG, 'match miss (no turn coordinate)', event.type, payloadShape(event));
          return null;
        }
      }
      const id = turn === undefined ? 'run:' + String(event.data.rootCallId) : String(turn);
      console.log(LOG, 'match hit', event.type, 'id=' + id, 'status=' + decoded.status);
      return { id, role: 'start' };
    },
    start(context, match) {
      const decoded = decodeChartEvent(match.event);
      // Turn number: durable data.turn for tool/result; for a run-rooted
      // pending Context the engine-resolved match Location once it points at a
      // Turn (refreshMatchLocations replays start() with the resolved
      // Location), otherwise undefined — publish stays suppressed (see
      // buildLocationData) so no wrong-Turn file or ownership throw happens.
      const fromEvent = eventTurnOf(match.event, match.location);
      return {
        turn: fromEvent,
        items: sortedItems(foldItem([], decoded, match.event)),
      };
    },
    update(context, match) {
      const decoded = decodeChartEvent(match.event);
      const folded = foldItem(context.state.items, decoded, match.event);
      // A pending ('run:<rootCallId>') Context adopts the Turn as soon as the
      // match Location resolves; once numeric it never changes again.
      const fromEvent = eventTurnOf(match.event, match.location);
      const turn = context.state.turn !== undefined ? context.state.turn : fromEvent;
      // Same-reference state means zero downstream re-publication.
      if (folded === context.state.items && turn === context.state.turn) return context.state;
      return { ...context.state, turn, items: sortedItems(folded) };
    },
    buildLocationData(context, scope, previous) {
      if (scope !== 'turn') return null;
      const state = context.state;
      if (state === undefined) return null;
      // v1.3 acceptance: an unresolved/pending turn publishes NOTHING (null)
      // instead of throwing or misfiling under a wrong Turn.
      if (!Number.isSafeInteger(state.turn) || state.turn < 0) {
        console.log(LOG, 'locData skip: turn unresolved id=' + context.id, 'scope=' + scope);
        return null;
      }
      // Self-check: the engine throws when data.key !== definition.kind
      // (assembler.ts:1017). Fail loudly HERE with a readable line instead.
      if (chartDefinition.kind !== 'inline-charts') {
        console.error(LOG, 'key!=kind', 'kind=' + String(chartDefinition.kind), 'expected=inline-charts');
        return null;
      }
      // Identity-stable passthrough while the list is unchanged (engine also
      // dedupes by value, but returning `previous` keeps object churn at zero).
      if (previous !== null && previous.kind === 'turn'
        && previous.turn === state.turn && previous.value === state.items) return previous;
      console.log(LOG, 'locData scope=turn', 'turn=' + state.turn, 'n=' + state.items.length);
      return { kind: 'turn', turn: state.turn, key: 'inline-charts', value: state.items };
    },
  };

  // ---------------------------------------------------------------------------
  // Plugin face consumed by the Cordis loader.
  // ---------------------------------------------------------------------------

  return {
    // Service dependencies (export-level `inject`, NOT dsh.client.inject ordering).
    inject: ['slots', 'uiConversation'],
    apply(ctx) {
      console.log(LOG, 'apply: registering definition + turnTail row');
      // Definition owns the per-Turn accumulator and publishes location data;
      // without it the tail row would read nothing.
      ctx.effect(
        () => ctx.uiConversation.events.register(chartDefinition),
        'inline-charts: conversation definition',
      );
      // One list entry in the official turnTail seat (ui-plan/ui-schedule
      // precedents); order 5 keeps it first among feature tails. The owner
      // supplies {turn, seq, openFile}; we render only when our Turn has items.
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: 'inline-charts.row',
        order: 5,
      }, ChartTailRow));
    },
  };
} });
