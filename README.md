# Inline charts

Плагин Harness Web GUI: интерактивные графики Chart.js и изолированные HTML/JS-виджеты прямо в ленте чата, плюс агентский инструмент `render_chart` для их эмита.

## Как это работает

1. Модель вызывает `render_chart(kind, spec)` (host-половина: `host/index.js`).
2. Инструмент валидирует spec и возвращает канонический envelope; он durable пишется в сессию как `tool/result`:
   - **канал рендера** — `output.presentationMeta` → `tool/result.meta` → клиентский `ToolResultNode.meta`;
   - **канал модели** — `output.render` → один text block «summary + fence-блок ```chart-json / ```chart-html».
3. Клиентская Definition (`client.js`, вне этой host-задачи) матчится на `tool/result` по meta и рисует keyed chat row: Chart.js-график или sandboxed iframe для виджета.

Секция системного промта `tool:render_chart` (order 9100) обязывает модель строить графики этим инструментом и запрещает mermaid, data URI и сырой HTML/SVG.

## Wire contract v1.1 (единый документ сверки host ↔ client)

Канал данных для рендера — **meta**, не текст. Fence-блоки в model content — человекочитаемая транскрипт-форма, парсить её для рендера нельзя.

### Канонический value (валидируется output.schema инструмента)

```json
{
  "protocol": "dsh.inline-chart",
  "version": 1,
  "kind": "chart-json",
  "spec": {
    "type": "line",
    "data": { "labels": ["Q1", "Q2"], "datasets": [{ "label": "Ряд", "data": [1, 3] }] },
    "options": { "responsive": true }
  }
}
```

Ветка HTML: тот же envelope, `kind: "chart-html"`, `spec: { "html": "<!doctype html>…" }` (полная строка sandbox-документа, не URL и не путь).

### Durable форма события

- `tool/result.message.content` = ровно один `{ type:"text", text: <summary + fence> }`. Fence: ```` ```chart-json\n<JSON.stringify(spec)>\n``` ```` или ```` ```chart-html\n<spec.html>\n``` ````; каждый backtick в теле экранирован zero-width space после символа, поэтому тело не может закрыть fence. При теле > 64 КБ fence не эхомится — только summary (без битого markdown).
- `tool/result.meta` = полный envelope `{protocol, version, kind, spec}` — authoritative источник рендера.
- Ограничение host: serialized envelope ≤ 262 144 UTF-8 байт, иначе понятная ошибка инструмента (success envelope не эмитится).

### Правила match для клиентской Definition

Матчить `event.type === 'tool/result'` при:

1. `isAppendSurfaceEvent(event)`;
2. `event.data.message.isError !== true` и нет `event.data.error`;
3. presence+валидность `event.data.meta.{protocol==='dsh.inline-chart', version===1, kind∈{'chart-json','chart-html'}, spec object}`; для `chart-html` дополнительно `typeof spec.html === 'string'`; для `chart-json` — `spec.data.datasets` непустой массив;
4. identity контекста: `String(event.data.message.source.callId)` (один вызов = один виджет; replay/fork дают тот же id).

Имя инструмента из result event недоступно — это форматный протокол. **Accepted risk v1:** любой инструмент, проставивший такой meta, будет отрисован; аутентификации источника нет, HTML-sandbox обязателен даже при совпадении marker.

### Аргументы инструмента (модель их передаёт, protocol/version добавляет host)

| параметр | тип | обязательный | описание |
|---|---|---|---|
| `kind` | `"chart-json" \| "chart-html"` | да | declarative Chart.js config или self-contained виджет |
| `spec` | JSON (любой) | да | chart-json: `{type?, data:{labels?, datasets:[{data:[…]}]}, options?}` без функций; chart-html: `{html: string}` |

Поддерживаемые `spec.type`: bar, line, scatter, bubble, pie, doughnut, polarArea, radar, area.

## Структура пакета

```
plugins/inline-charts/
├── host/index.js           # инструмент render_chart + секция промта (t10)
├── client/index.js         # Definition + Chat row (t9, ui-engineer) — см. «Client» ниже
├── client/client.chartjs.js# vendored Chart.js v4.4.7 UMD как package-local chunk (t9)
├── client/vendor/chart.umd.js       # исходный UMD-бандл + заметка о лицензии
├── client/vendor/CHARTJS-LICENSE.md # MIT license notice (redistribution)
├── package.json            # exports/dsh.bundle.patch/dsh.client (t11, integrator)
├── cordis.patch.yml        # insert строк host+client (t11, integrator)
├── locale/en.json          # meta.title / meta.description
├── locale/ru.json
└── icon.svg                # (t11, integrator)
```

## Client (`client/index.js`, t9 → v1.2 в t23)

Клиентская половина рисует inline-виджеты из durable `tool/result.meta`; fence-блоки
в тексте модели не парсятся (они человекочитаемая транскрипт-форма).

**Механизм v1.2** (вердикт t21: keyed слот `conversation.chat.node` закры таблицой
`ChatNodeKind` — plain-JS плагин не может добавить свой kind; прецеденты ui-schedule /
ui-plan):

1. State-only Conversation Definition `{kind:'inline-charts'}` (БЕЗ target/buildViewNode)
   регистрируется через `ctx.uiConversation.events.register` внутри `ctx.effect`.
   Матчит append-surface `tool/result` при presence+валидности
   `event.data.meta.{protocol:'dsh.inline-chart', version:1, kind, spec}` и
   `message.isError !== true`. Identity Context'а — **номер turn'а**
   (`String(event.data.turn)`): один Context накапливает все графики своего turn'а,
   а identity отдельного вызова (`callId`) сохраняется внутри элемента списка и служит
   ключом дедупликации/замены (replay/fork воспроизводят и то, и другое). Чужие tool
   results возвращают `null` и остаются штатному рендеру.
2. Definition публикует накопленный список через `buildLocationData(scope:'turn')`
   под ключом `'inline-charts'` (движок требует `data.key === definition.kind`) в
   `ConversationTurnDataMap` — type-only расширение через `declare module` в TS-проектах;
   для plain JS контракт тот же: значение — массив элементов
   `{status:'ok', callId, seq, envelope}` или `{status:'error', callId, seq, reason}`,
   отсортированный по `seq` (anchorSeq).
3. Renderer — ОДИН list entry официального слота `conversation.chat.turnTail`
   (`ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({name,
   id:'inline-charts.row', order:5}, ChartTailRow))`). Компонент получает owner
   `{turn, seq, openFile}`, подписывается на `turn.data.source('inline-charts')`
   (identity-stable источник движка) и рисует виджеты своего turn'а списком в порядке
   anchorSeq; пустой/отсутствующий список → `null` (строка не видна). Размещение —
   в конце закрытого turn'а, рядом со штатными действиями; официальные renderers
   не заменяются, tool card остаётся.

**Важно про rev-skew:** после переустановки бандла браузер может держать старый
`client.js?rev=<старый>` — живая приёмка обязана делаться после reload страницы
(иначе Slots.listSubTree покажет предыдущий монтаж). Это операционное требование,
не архитектурный блокер.

**chart-json**: `spec {type,data,options?}` → canvas + `new Chart(...)` в `useEffect`;
cleanup всегда `chart.destroy()`. Каждый виджет — независимый инстанс (несколько
графиков в одном сообщении не конфликтуют). Типы: bar, line, scatter, bubble, pie,
doughnut, polarArea, radar, area; `options` поверх дефолтов `responsive:true,
maintainAspectRatio:false`.

**Chart.js без CDN**: локальный бандл `client/vendor/chart.umd.js` (v4.4.7, MIT —
`CHARTJS-LICENSE.md`) распространяется как package-local classic-script chunk
`client/client.chartjs.js` и грузится лениво документированным протоколом
`require.async('./client.chartjs.js')` (packages/client/modules system.ts). В рантайме
сеть не требуется. **Требование к интегратору (t11):** включить `client/chart.umd.js`
и оба файла чанка в `files`/exports бандла — список должен содержать
`client/index.js`, `client/client.chartjs.js`, `client/vendor/chart.umd.js`,
`client/vendor/CHARTJS-LICENSE.md`; для packed-установки проверить реальный packed file
list (для directory-установки `files` не фильтрует — файлы должны физически лежать в
каталоге).

**chart-html**: полная строка документа рендерится в iframe `srcdoc` с
`sandbox="allow-scripts"` БЕЗ `allow-same-origin` (opaque origin: домен чата не
заражается, хранилище/DOM GUI недоступны; прецедент — официальный
ui-sidebar-documentpreview/HtmlBody.tsx). Внутри frame действует жёсткая CSP
(`default-src 'none'`, inline scripts/styles разрешены только в sandbox-документе,
`connect-src 'none'`, network/frames/forms запрещены). Resize — postMessage с handshake:
parent слушает `message` строго в useEffect по mount/unmount конкретного frame
(remount srcdoc меняет contentWindow — замыкание на старое окно молча теряет события),
фильтрует по `event.source === iframe.contentWindow` (НЕ по origin — у sandboxed iframe
origin `'null'` ничего не аутентифицирует) плюс одноразовый nonce, перегенерируемый на
каждый remount. Высота ограничена 40–4000 px.

**Заглушки ошибок** (аккуратная карточка role=alert, чат не ломается): битый/невалидный
spec (тип вне списка, пустой datasets, NaN/Infinity, `spec.html` не строка), неподдерживаемая
версия протокола, payload выше лимитов (envelope > 262 144 UTF-8 байт — как host; html >
2 MiB). Отсутствие meta / чужая meta / isError / result error — игнор (штатный tool row).

Widget монтируется только на settled durable `tool/result` (live-чанки не матчатся);
в v1.2 строка turnTail появляется под закрытым turn'ом — для незавершённого turn'а
данные уже накапливаются, но row рендерится, когда движок показывает tail (после end turn'а).

Живой resize-тест после развёртывания остаётся проверкой окружения (внешний reverse-proxy
может наложить свой CSP на страницу), но не архитектурный блокер монтажа.

## Статус установки

Ничего не устанавливалось в профиль. Установка — через `plugin_manager install_bundle` интегратором (t11), после чего рекомендуется живая сверка Tool/Service faces через `cordis_inspect_query` (см. host-api-notes.md §6).
