# Inline charts

Плагин Harness Web GUI: интерактивные графики Chart.js и изолированные HTML/JS-виджеты прямо в ленте чата, плюс агентский инструмент `render_chart` для их эмита.

## Как это работает

1. Модель вызывает `render_chart(kind, spec)` (host-половина: `host/index.js`).
2. Инструмент валидирует spec и возвращает канонический envelope; он durable пишется в сессию как `tool/result`:
   - **канал рендера** — `output.presentationMeta` → `tool/result.meta` → клиентский `ToolResultNode.meta`;
   - **канал модели** — `output.render` → один text block «summary + fence-блок ```chart-json / ```chart-html».
3. Клиентская Definition (`client/index.js`) матчится на `tool/result` по meta и рисует keyed chat row: Chart.js-график или sandboxed iframe для виджета.

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

## Client (`client/index.js`, t9)

Клиентская половина рисует inline-виджеты из durable `tool/result.meta`; fence-блоки
в тексте модели не парсятся (они человекочитаемая транскрипт-форма).

**Механизм** (plugin-api-notes.md §5-C / §Implementation hints / §t13):

1. Conversation Definition `{kind:'inline-chart', target:'chat'}` регистрируется через
   `ctx.uiConversation.events.register` внутри `ctx.effect`. Матчит append-surface
   `tool/result` при presence+валидности `event.data.meta.{protocol:'dsh.inline-chart',
   version:1, kind, spec}` и `message.isError !== true`; identity контекста —
   `String(event.data.message.source.callId)` (один вызов = один виджет; replay/fork
   дают тот же id). Чужие tool results возвращают `null` и остаются штатному рендеру.
2. Keyed renderer регистрируется в слот `conversation.chat.node` с key `inline-chart`
   (`ctx.slots.inject` → `ctx.slots.register`) и получает `node.data` — декодированный
   envelope. Официальные keys (`assistant-step`, `tool-call`) не заменяются; штатная
   tool card остаётся рядом.

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

Widget монтируется только на settled durable `tool/result` (live-чанки не матчатся).

Живой resize-тест после развёртывания остаётся проверкой окружения (внешний reverse-proxy
может наложить свой CSP на страницу), но не архитектурный блокер монтажа.

## Установка

Требования: DeepSeek Harness (DSH) с Web GUI, профиль-директория на хосте.

1. Скачайте репозиторий и укажите путь к нему при установке бандла:
   ```bash
   git clone https://github.com/zznobzz/dsh-inline-charts.git
   ```
2. В DSH-агенте этого профиля выполните установку бандла из директории плагина (`plugin_manager action=install_bundle`, target — абсолютный путь к клону). Либо добавьте вручную в `cordis.patch.yml` профиля строку `insert` из `cordis.patch.yml` этого пакета и подключите пакет как зависимость профиля.
3. Перезагрузите страницу GUI. Проверка монтирования:
   - агентский инструмент `render_chart` виден в списке инструментов новой сессии;
   - в ленте чата сообщение с результатом `render_chart` показывает живой график.

Обновление: повторная установка поверх (`remove_bundle` → `install_bundle`).

## Лицензии

MIT для кода плагина. Chart.js 4.4.7 (MIT) распространяется локально в `client/vendor/`; текст лицензии — `client/vendor/CHARTJS-LICENSE.md`.

## Ограничения v1

- Виджет рисуется блоком в ленте рядом с сообщением (не между абзацами текста); в тексте остаётся CodeBlock-заглушка.
- Аутентификации маркера нет: любой инструмент с тем же envelope отрисуется (sandbox iframe обязателен).
- Обновление существующего виджета по id не поддерживается.
