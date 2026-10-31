// Inlined after model.mjs by render.mjs; no requests or external modules.
const payload = JSON.parse(document.getElementById('report-data').textContent);
const model = createModel(payload.bundle, payload.report);
const $ = id => document.getElementById(id);
const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
const labels = {
  untranslated: 'Нет перевода', same_as_source: 'Совпадает с оригиналом', placeholder_mismatch: 'Плейсхолдеры',
  plural_mismatch: 'Формы множественного числа', glossary_violation: 'Нарушение глоссария', length_overflow: 'Риск переполнения',
  machine_translation_suspect: 'Неестественная формулировка', inconsistent_term: 'Несогласованный термин', suffix_harmony: 'Гармония аффиксов',
  orthography: 'Орфография', wrong_language: 'Другой язык'
};
const severityNames = { high: 'Высокая', medium: 'Средняя', low: 'Низкая' };
const stateNames = { pending: 'Без решения', accepted: 'Принято в работу', edited: 'Исправлено в работе', rejected: 'Отклонено в работе', reviewed: 'Есть проверка', stale: 'Устарело', blocked: 'Нет привязки' };
let drafts = new Map(), staleDrafts = [], reviews = { schema_version: '1.0', target_locale: model.bundle.target_locale, decisions: [] };
let checked = { applicable: [], stale: [] }, selectedId = model.cards[0]?.id, dirty = false, editingAuthor = '', pending = Promise.resolve();
let visible = [], editRevision = 0;
const message = (text, error = false) => { $('message').textContent = text; $('message').classList.toggle('error', error); };
function markDirty() { dirty = true; $('save-state').textContent = 'Есть изменения · сохраните файл решений'; }
function allWorkspace() { return createWorkspace(model, [...drafts.values(), ...staleDrafts.map(x => x.draft)], reviews); }
function applicableFor(card) { return card.entry ? checked.applicable.find(x => x.entry_id === card.entry.entry_id) : undefined; }
function isStale(card) { return staleDrafts.some(x => x.draft.key === card.finding.key) || checked.stale.some(x => x.decision.key === card.finding.key); }
function status(card) {
  if (card.blockedReason) return 'blocked';
  if (drafts.has(card.id)) return drafts.get(card.id).decision;
  if (applicableFor(card)) return 'reviewed';
  if (isStale(card)) return 'stale';
  return 'pending';
}
async function loadWorkspace(workspace) {
  const restored = await restoreWorkspace(workspace, model);
  // Commit only after the entire import has validated.
  drafts = new Map(restored.drafts.map(x => [x.card_id, x])); staleDrafts = restored.staleDrafts;
  reviews = workspace.imported_reviews; checked = restored.reviews;
}
if (payload.workspace) await loadWorkspace(payload.workspace);
if (payload.reviews) { checked = await validateReviews(payload.reviews, model); reviews = payload.reviews; }
$('save-state').textContent = payload.workspace ? 'Решения восстановлены из HTML' : 'Готов к работе';
message('Рабочие решения не создают человеческих одобрений. Сохраняйте JSON или HTML перед закрытием страницы.');
$('locale').textContent = `${model.bundle.source_locale.toUpperCase()} → ${model.bundle.target_locale.toUpperCase()}`;
if (payload.synthetic) { $('data-notice').hidden = false; $('data-notice').textContent = 'Синтетический пример · Все строки вымышлены. Находки подготовлены заранее; этот отчёт не измеряет качество детектора.'; }
// Saved HTML already contains a rendered DOM. Rebuild dynamic options once.
const allTypes = node('option', '', 'Все типы'); allTypes.value = ''; $('type-filter').replaceChildren(allTypes);
for (const type of Object.keys(labels)) { const option = node('option', '', labels[type]); option.value = type; $('type-filter').append(option); }

function renderSummary() {
  $('stat-findings').textContent = model.cards.length;
  $('stat-types').textContent = `${new Set(model.cards.map(c => c.finding.issue_type)).size} типов находок`;
  $('stat-drafts').textContent = drafts.size;
  $('stat-reviewed').textContent = checked.applicable.length;
  $('stat-corrected').textContent = checked.applicable.filter(d => d.decision !== 'rejected' && d.approved_text !== d.original_text).length;
  const processed = model.cards.filter(c => drafts.has(c.id) || applicableFor(c)).length;
  $('progress-bar').style.width = `${model.cards.length ? processed / model.cards.length * 100 : 0}%`;
  $('journal-count').textContent = `${drafts.size} рабочих · ${checked.applicable.length} проверенных · ${staleDrafts.length + checked.stale.length} устаревших`;
  const journal = $('journal'); journal.replaceChildren();
  journal.append(node('p', '', 'Кандидаты — находки алгоритма. Рабочие решения не подтверждены человеком. Импортированные reviews подтверждают решение по строке, но не отдельные типы ошибок; число подтверждённых проблем из этого формата определить нельзя.'));
  for (const d of drafts.values()) { const row = node('div', 'journal-item'); row.append(node('strong', '', `${d.key} · ${stateNames[d.decision]}`), node('span', '', `${d.proposed_text === null ? 'Предложение отклонено' : d.proposed_text}\nАвтор: ${d.author || 'не указан'}${d.note ? '\nКомментарий: ' + d.note : ''}`)); journal.append(row); }
  for (const d of checked.applicable) { const row = node('div', 'journal-item'); row.append(node('strong', '', `${d.key} · импортированное ${d.decision}`), node('span', '', `${d.approved_text ?? 'Отклонено'}\nПроверяющий: ${d.reviewer} · ${d.reviewed_at}`)); journal.append(row); }
  for (const item of [...staleDrafts.map(x => ({ key: x.draft.key, reason: x.reason })), ...checked.stale.map(x => ({ key: x.decision.key, reason: x.reason }))]) journal.append(node('div', 'journal-item stale', `${item.key} · Устаревшее / неприменимое решение\n${item.reason}\nСохранено в рабочем файле, не включается в экспорт применимых reviews.`));
}

function renderQueue() {
  const query = $('search').value.toLocaleLowerCase();
  const type = $('type-filter').value, severity = $('severity-filter').value, filter = $('status-filter').value;
  visible = model.cards.filter(c => (!type || c.finding.issue_type === type) && (!severity || c.finding.severity === severity)
    && (!filter || (filter === 'reviewed' ? Boolean(applicableFor(c)) : filter === 'stale' ? isStale(c) : status(c) === filter))
    && (!query || [c.finding.key, c.finding.source, c.finding.target, c.finding.suggestion, c.finding.evidence].join('\n').toLocaleLowerCase().includes(query)));
  const queue = $('queue'); queue.replaceChildren(); $('queue-count').textContent = `${visible.length} / ${model.cards.length}`;
  if (!visible.length) queue.append(node('p', 'empty', 'По этим фильтрам находок нет.'));
  for (const card of visible) {
    const button = node('button', 'queue-item' + (card.id === selectedId ? ' active' : ''));
    button.setAttribute('aria-pressed', String(card.id === selectedId));
    const row = node('div', 'row'); row.append(node('span', `badge ${card.finding.severity}`, severityNames[card.finding.severity]), node('span', 'state', stateNames[status(card)]));
    button.append(row, node('strong', '', labels[card.finding.issue_type]), node('span', 'excerpt', card.finding.key));
    button.addEventListener('click', async () => { await pending; selectedId = card.id; renderQueue(); renderDetail(); }); queue.append(button);
  }
}

function refreshFilters() {
  renderQueue();
  if (!visible.some(c => c.id === selectedId)) { selectedId = visible[0]?.id; renderQueue(); }
  renderDetail();
}
for (const id of ['type-filter', 'severity-filter', 'status-filter']) $(id).addEventListener('change', async () => { await pending; refreshFilters(); });
$('search').addEventListener('input', async () => { await pending; refreshFilters(); });

function field(title, text, emptyLabel) {
  const panel = node('div', 'text-panel'); panel.append(node('p', 'field-title', title), node('p', 'text-content' + (!text ? ' empty-value' : ''), text || emptyLabel)); return panel;
}
function renderDetail() {
  editRevision++;
  const detail = $('detail'); detail.replaceChildren();
  const card = model.cards.find(c => c.id === selectedId);
  if (!card) { detail.append(node('p', 'empty', model.cards.length ? 'Измените фильтры, чтобы увидеть находки.' : 'В отчёте нет находок.')); return; }
  const f = card.finding, draft = drafts.get(card.id), official = applicableFor(card);
  const top = node('div', 'card-top'), title = node('div');
  title.append(node('span', `badge ${f.severity}`, `${severityNames[f.severity]} серьёзность`), node('h2', '', labels[f.issue_type]), node('p', 'key', f.key));
  top.append(title, node('span', 'card-number', `${model.cards.indexOf(card) + 1} / ${model.cards.length}`)); detail.append(top);
  if (card.entry?.context) {
    const c = card.entry.context; const parts = [c.section, c.description, ...Object.entries(c.references ?? {}).map(([locale, text]) => `${locale}: ${text}`)].filter(Boolean);
    if (parts.length) detail.append(node('p', 'context', parts.join('\n')));
  }
  const pair = node('div', 'text-pair'); pair.append(field(`Оригинал · ${model.bundle.source_locale}`, f.source, 'Пустая строка'), field(`Текущий перевод · ${model.bundle.target_locale}`, f.target, card.entry?.target === null ? 'Ключ отсутствует в переводе' : 'Пустая строка')); detail.append(pair);
  const evidence = node('div', 'evidence'); evidence.append(node('h3', '', 'Почему нужна проверка'), node('p', '', f.evidence), node('small', 'confidence', `Уверенность алгоритма: ${Math.round(f.confidence * 100)}% · не является вероятностью без калибровки`)); detail.append(evidence);
  const suggestion = node('div', 'suggestion'); suggestion.append(node('p', 'field-title', 'Предложение'), node('p', 'text-content', f.suggestion || 'Безопасного предложения нет — нужна ручная версия.')); detail.append(suggestion);
  if (card.blockedReason) detail.append(node('div', 'blocked', `Действия заблокированы: ${card.blockedReason}`));
  if (isStale(card)) detail.append(node('div', 'blocked', 'Есть устаревшее решение. Оно сохранено в журнале и не считается проверкой текущего текста.'));
  if (official) detail.append(node('div', 'review-notice', `Импортированная проверка: ${official.decision}\n${official.reviewer} · ${official.reviewed_at}\n${official.approved_text ?? 'Предложение отклонено'}\nНовые рабочие правки не изменяют этот журнал.`));
  const editor = node('section', 'editor'); editor.append(node('h3', '', 'Рабочее решение'), node('p', 'help', 'Принять предложение, написать свою версию или отклонить. Это подготовка к проверке носителем; отметка человека не создаётся.'));
  const textLabel = node('label', '', 'Ваша версия'), text = node('textarea'); text.id = 'proposed-text'; text.spellcheck = false; text.value = draft?.proposed_text ?? f.suggestion; text.disabled = Boolean(card.blockedReason); textLabel.append(text); editor.append(textLabel);
  const fields = node('div', 'editor-fields'); const authorLabel = node('label', '', 'Автор рабочего решения'), author = node('input'); author.value = draft?.author || editingAuthor; author.placeholder = 'Имя или инициалы'; author.maxLength = 200; authorLabel.append(author);
  const noteLabel = node('label', '', 'Комментарий'), note = node('input'); note.value = draft?.note ?? ''; note.placeholder = 'Контекст для следующего редактора'; noteLabel.append(note); fields.append(authorLabel, noteLabel); editor.append(fields);
  const actions = node('div', 'actions'); const accept = node('button', 'primary', 'Принять'), edit = node('button', '', 'Сохранить правку'), reject = node('button', 'danger', 'Отклонить');
  accept.disabled = Boolean(card.blockedReason) || !f.suggestion; edit.disabled = reject.disabled = Boolean(card.blockedReason); author.disabled = note.disabled = Boolean(card.blockedReason);
  actions.append(accept, edit, reject); editor.append(actions);
  const saved = node('p', 'editor-status', draft ? `${stateNames[draft.decision]} · сохранено в рабочей сессии` : 'Изменения текста сохраняются в рабочую сессию автоматически.'); editor.append(saved); detail.append(editor);
  const revision = editRevision;
  let saveSequence = 0, localDecision = draft?.decision;
  function save(decision, refresh = false) {
    const value = text.value, memo = note.value, who = author.value; editingAuthor = who;
    localDecision = decision; const sequence = ++saveSequence; markDirty();
    pending = pending.then(async () => {
      const result = await makeDraft(card, decision, value, memo, who);
      drafts.set(card.id, result); markDirty(); renderSummary(); renderQueue();
      if (revision === editRevision && sequence === saveSequence) { saved.textContent = `${stateNames[result.decision]} · без отметки человека`; if (refresh) { text.value = result.proposed_text ?? f.suggestion; updatePreview(); } }
    }).catch(error => message(error.message, true));
  }
  accept.addEventListener('click', () => save('accepted', true)); edit.addEventListener('click', () => save('edited')); reject.addEventListener('click', () => save('rejected', true));
  text.addEventListener('input', () => { save('edited'); updatePreview(); });
  note.addEventListener('input', () => save(localDecision ?? 'edited'));
  author.addEventListener('input', () => { editingAuthor = author.value; if (localDecision) save(localDecision); });
  const preview = node('details', 'preview'); preview.open = f.issue_type === 'length_overflow'; preview.append(node('summary', '', 'Предпросмотр длины: кнопка и вкладка'), node('p', '', 'Иллюстрация риска переполнения. Размеры и шрифт игры неизвестны; этот макет не доказывает дефект в клиенте.'));
  const controls = node('div', 'preview-controls'), widthLabel = node('label', '', 'Ширина макета: '), range = node('input'); range.type = 'range'; range.min = '100'; range.max = '320'; range.value = '160'; range.setAttribute('aria-label', 'Ширина макета'); const widthText = node('span', '', '160 px'); widthLabel.append(range, widthText); controls.append(widthLabel); preview.append(controls);
  const stage = node('div', 'mock-stage'), result = node('p', 'mock-result'); const mocks = [];
  for (const [caption, className, useCurrent] of [['Текущий перевод · кнопка', 'mock-button', true], ['Рабочая версия · кнопка', 'mock-button', false], ['Рабочая версия · вкладка', 'mock-tab', false]]) { const wrap = node('div'), box = node('div', className); wrap.append(node('p', 'mock-caption', caption), box); stage.append(wrap); mocks.push({ box, useCurrent }); }
  preview.append(stage, result); detail.append(preview);
  function updatePreview() { for (const { box, useCurrent } of mocks) { box.style.width = `${range.value}px`; box.textContent = useCurrent ? f.target : text.value; box.title = box.textContent; } widthText.textContent = `${range.value} px`; requestAnimationFrame(() => { result.textContent = preview.open ? (mocks.some(x => x.box.scrollWidth > x.box.clientWidth) ? 'В выбранном макете текст выходит за границу. Проверьте в интерфейсе игры.' : 'В выбранном макете текст помещается. Это не проверка в игре.') : ''; }); }
  range.addEventListener('input', updatePreview); preview.addEventListener('toggle', updatePreview); updatePreview();
  const nav = node('div', 'nav-row'), previous = node('button', '', '← Предыдущая'), next = node('button', '', 'Следующая →');
  const position = visible.findIndex(c => c.id === card.id); previous.disabled = position <= 0; next.disabled = position < 0 || position >= visible.length - 1;
  async function move(offset) { const target = visible[position + offset]; await pending; if (target) { selectedId = target.id; renderQueue(); renderDetail(); $('detail').focus({ preventScroll: true }); } }
  previous.addEventListener('click', () => move(-1)); next.addEventListener('click', () => move(1)); nav.append(previous, next); detail.append(nav);
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function savedFile(text) { dirty = false; $('save-state').textContent = 'Файл подготовлен к сохранению'; message(text); }
$('export-workspace').addEventListener('click', async () => { await pending; download('review-workspace.json', JSON.stringify(allWorkspace(), null, 2), 'application/json'); savedFile('Рабочий файл содержит все решения, комментарии, устаревшие записи и импортированные reviews. Сохраните загрузку, затем откройте её через «Импорт решений».'); });
$('export-reviews').addEventListener('click', async () => { await pending; download('reviews.json', JSON.stringify({ schema_version: '1.0', target_locale: model.bundle.target_locale, decisions: checked.applicable }, null, 2), 'application/json'); message(`Экспортировано ${checked.applicable.length} применимых решений из импортированного журнала. Рабочие решения не превращены в человеческие проверки.`); });
$('export-html').addEventListener('click', async () => {
  await pending;
  const clone = document.documentElement.cloneNode(true);
  const snapshot = { ...payload, workspace: allWorkspace(), reviews: null };
  clone.querySelector('#report-data').textContent = JSON.stringify(snapshot).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  // Runtime rebuilds these views from the embedded snapshot when reopened.
  for (const id of ['queue', 'detail', 'journal']) clone.querySelector('#' + id).replaceChildren();
  download('review-report.html', '<!doctype html>\n' + clone.outerHTML, 'text/html'); savedFile('Самостоятельный HTML подготовлен с текущими решениями. Для передачи можно использовать этот файл без отдельного JSON.');
});
$('import-button').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  document.querySelector('main').inert = true;
  try {
    await pending;
    const data = JSON.parse(await file.text());
    if (data.kind === 'qazaq-loc-qa-workspace') {
      // Validate before asking to replace or changing any current decisions.
      await restoreWorkspace(data, model);
      if ((drafts.size || staleDrafts.length || reviews.decisions.length) && !window.confirm('Заменить текущую рабочую сессию содержимым файла? Сначала сохраните текущие решения, если они нужны.')) return;
      await loadWorkspace(data);
    } else {
      const validated = await validateReviews(data, model);
      if (reviews.decisions.length && !window.confirm('Заменить импортированный журнал reviews? Рабочие решения останутся.')) return;
      reviews = data; checked = validated;
    }
    markDirty(); renderSummary(); refreshFilters();
    message(`Импорт завершён: ${drafts.size} рабочих, ${checked.applicable.length} применимых проверок, ${staleDrafts.length + checked.stale.length} устаревших записей. Отметки человека не созданы.`);
  } catch (error) { message(`Импорт отменён, текущие решения сохранены: ${error.message}`, true); }
  finally { event.target.value = ''; document.querySelector('main').inert = false; }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
renderSummary(); refreshFilters();
