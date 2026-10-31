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
let precisionSample = null, precisionResult = null, stalePrecision = null, pendingFailure = null;
let visible = [], editRevision = 0, expertMode = payload.view === 'expert';
const message = (text, error = false) => { $('message').textContent = text; $('message').classList.toggle('error', error); };
function markDirty() { dirty = true; $('save-state').textContent = 'Есть изменения · сохраните файл решений'; }
function allWorkspace() { return createWorkspace(model, [...drafts.values(), ...staleDrafts.map(x => x.draft)], reviews, precisionSample); }
function applicableFor(card) { return card.entry ? checked.applicable.find(x => x.entry_id === card.entry.entry_id) : undefined; }
function findingVerdict(card) { return precisionResult ? precisionSample.rows.find(row => row.finding.key === card.finding.key && row.finding.issue_type === card.finding.issue_type && row.reviewed === true) : undefined; }
function conflicts() { return draftConflicts(drafts); }
function hasConflict(card) { return card.entry && conflicts().some(group => group.entry_id === card.entry.entry_id); }
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
  precisionSample = workspace.imported_precision ?? null; precisionResult = restored.precision; stalePrecision = restored.stalePrecision;
}
if (payload.workspace) await loadWorkspace(payload.workspace);
if (payload.reviews) { checked = await validateReviews(payload.reviews, model); reviews = payload.reviews; }
if (payload.precisionSample) { precisionResult = await validatePrecision(payload.precisionSample, model.report); precisionSample = payload.precisionSample; }
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
  $('stat-confirmed').textContent = precisionResult ? precisionResult.confirmed : '—';
  $('precision-state').textContent = precisionResult ? `В проверенной части: ${precisionResult.reviewed} из ${precisionResult.sample_size}` : stalePrecision ? 'Анкета устарела / неприменима' : 'Анкета не загружена';
  $('stat-reviewed').textContent = checked.applicable.length;
  $('stat-corrected').textContent = checked.applicable.filter(d => d.decision !== 'rejected' && d.approved_text !== d.original_text).length;
  const processed = model.cards.filter(c => drafts.has(c.id) || applicableFor(c)).length;
  $('progress-bar').style.width = `${model.cards.length ? processed / model.cards.length * 100 : 0}%`;
  $('journal-count').textContent = `${drafts.size} рабочих · ${checked.applicable.length} проверенных · ${staleDrafts.length + checked.stale.length} устаревших`;
  const alerts = [];
  if (conflicts().length) alerts.push(`Конфликт рабочих версий: ${conflicts().length} строк. Для одного ключа предложены разные переводы; согласуйте итоговую версию перед передачей.`);
  if (stalePrecision) alerts.push('Анкета проверки находок сохранена, но не учитывается: ' + stalePrecision.reason);
  $('session-alert').hidden = !alerts.length; $('session-alert').textContent = alerts.join('\n');
  const journal = $('journal'); journal.replaceChildren();
  journal.append(node('p', '', 'Кандидаты — находки алгоритма. Подтверждённые проблемы считаются только по импортированной анкете проверки находок. Проверенные исправления — по применимым записям reviews. Рабочие решения не создают ни одну из этих отметок.'));
  journal.append(precisionSummary());
  for (const d of drafts.values()) { const row = node('div', 'journal-item'); row.append(node('strong', '', `${d.key} · ${stateNames[d.decision]}`), node('span', '', `${d.proposed_text === null ? 'Предложение отклонено' : d.proposed_text}\nАвтор: ${d.author || 'не указан'}${d.note ? '\nКомментарий: ' + d.note : ''}`)); journal.append(row); }
  for (const d of checked.applicable) { const row = node('div', 'journal-item'); row.append(node('strong', '', `${d.key} · импортированное ${d.decision}`), node('span', '', `${d.approved_text ?? 'Отклонено'}\nПроверяющий: ${d.reviewer} · ${d.reviewed_at}`)); journal.append(row); }
  for (const item of [...staleDrafts.map(x => ({ key: x.draft.key, reason: x.reason })), ...checked.stale.map(x => ({ key: x.decision.key, reason: x.reason }))]) journal.append(node('div', 'journal-item stale', `${item.key} · Устаревшее / неприменимое решение\n${item.reason}\nСохранено в рабочем файле, не включается в экспорт применимых reviews.`));
  for (const group of conflicts()) journal.append(node('div', 'journal-item stale', `${group.key} · Конфликт рабочих версий\n${group.drafts.map(d => `${d.proposed_text === '' ? '(пустая строка)' : d.proposed_text} — ${d.author || 'автор не указан'}`).join('\n')}`));
  if (expertMode) renderExpert();
}

function precisionSummary() {
  if (!precisionResult) return node('p', '', stalePrecision ? 'Сводка подтверждённых проблем недоступна: сохранённая анкета не соответствует текущему отчёту.' : 'Подтверждённые проблемы пока не оценены. Импортируйте заполненную носителем precision-sample.json, подготовленную общей командой sample-review.');
  const p = precisionResult;
  return node('p', '', `В выборке ${p.sample_size} из ${p.population_size} уникальных находок: подтверждено ${p.confirmed}, не подтверждено ${p.rejected}, не проверено ${p.unreviewed}. ${p.complete ? 'Выборка проверена полностью.' : 'Выборка проверена частично; вывод на весь отчёт не переносится.'} ${p.population_binding === 'legacy_selected_findings_only' ? 'Старая анкета привязана только к выбранным находкам.' : 'Анкета связана с точной версией всего отчёта.'} Проверяющие: ${p.reviewers.join(', ') || 'нет заполненных ответов'}.`);
}

function renderExpert() {
  const panel = $('expert-report'); panel.replaceChildren(node('h2', '', 'Отчёт для эксперта'), node('p', 'context', 'Все находки и решения в одном документе. Исходные строки сохранены; рабочие версии ещё требуют проверки носителем.'), precisionSummary());
  const table = node('table', 'type-summary'); const caption = node('caption', '', 'Сводка по типам проблем'); table.append(caption);
  const head = node('thead'), headings = node('tr');
  for (const text of ['Тип проблемы', 'Кандидаты', 'Рабочие решения', 'Подтверждено в анкете']) { const th = node('th', '', text); th.scope = 'col'; headings.append(th); } head.append(headings); table.append(head);
  const body = node('tbody');
  for (const [type, label] of Object.entries(labels)) {
    const cards = model.cards.filter(card => card.finding.issue_type === type); if (!cards.length) continue;
    const confirmed = precisionResult ? precisionSample.rows.filter(row => row.finding.issue_type === type && row.reviewed === true && row.correct === true).length : '—';
    const row = node('tr'); for (const value of [label, cards.length, cards.filter(card => drafts.has(card.id)).length, confirmed]) row.append(node('td', '', value)); body.append(row);
  }
  table.append(body); const tableWrap = node('div', 'table-wrap'); tableWrap.append(table); panel.append(tableWrap);
  panel.append(node('h3', 'expert-heading', 'Проверенные исправления'));
  const corrections = checked.applicable.filter(d => d.decision !== 'rejected' && d.approved_text !== d.original_text);
  if (!corrections.length) panel.append(node('p', 'context', 'Применимых проверенных исправлений нет. Рабочие версии показаны ниже отдельно.'));
  for (const d of corrections) { const item = node('section', 'expert-card'); item.append(node('h3', '', d.key), field('До проверки', d.original_text, d.original_text === null ? 'Ключ отсутствовал' : 'Пустая строка'), field('Проверенная версия', d.approved_text, 'Пустая строка'), node('p', 'context', `${d.reviewer} · ${d.reviewed_at}`)); panel.append(item); }
  panel.append(node('h3', 'expert-heading', 'Полный список находок'));
  if (!model.cards.length) panel.append(node('p', 'context', 'В отчёте нет находок.'));
  for (const card of model.cards) {
    const f = card.finding, draft = drafts.get(card.id), verdict = findingVerdict(card), official = applicableFor(card);
    const item = node('section', 'expert-card'); item.append(node('span', `badge ${f.severity}`, severityNames[f.severity]), node('h3', '', `${f.key} · ${labels[f.issue_type]}`), node('p', 'context', stateNames[status(card)]));
    const pair = node('div', 'text-pair'); pair.append(field('Оригинал', f.source, 'Пустая строка'), field('Текущий перевод', f.target, card.entry?.target === null ? 'Ключ отсутствует' : 'Пустая строка')); item.append(pair);
    item.append(node('p', 'expert-evidence', f.evidence), field('Предложение', f.suggestion, 'Предложения нет'));
    if (verdict) item.append(node('p', 'review-notice', `${verdict.correct ? 'Проблема подтверждена' : 'Проблема не подтверждена'} · ${verdict.reviewer} · ${verdict.reviewed_at}${verdict.notes ? '\n' + verdict.notes : ''}`));
    if (draft) item.append(field(`Рабочее решение · ${stateNames[draft.decision]}`, draft.proposed_text, draft.decision === 'rejected' ? 'Предложение отклонено' : 'Пустая строка'), node('p', 'context', `Автор: ${draft.author || 'не указан'} · ${draft.updated_at}${draft.note ? '\n' + draft.note : ''}`));
    if (official) item.append(node('p', 'review-notice', `Импортированное решение по строке: ${official.decision} · ${official.reviewer} · ${official.reviewed_at}\n${official.approved_text ?? 'Отклонено'}`));
    if (card.blockedReason || isStale(card) || hasConflict(card)) item.append(node('p', 'blocked', [card.blockedReason, isStale(card) ? 'Есть неприменимая история решений.' : '', hasConflict(card) ? 'Есть конфликт рабочих версий этой строки.' : ''].filter(Boolean).join('\n')));
    panel.append(item);
  }
}

function setExpertView(value) {
  expertMode = value; $('review-workspace').hidden = value; $('expert-report').hidden = !value;
  $('expert-toggle').textContent = value ? 'Вернуться к карточкам' : 'Отчёт для эксперта'; $('expert-toggle').setAttribute('aria-pressed', String(value));
  if (value) renderExpert();
}

function renderQueue() {
  const query = $('search').value.toLocaleLowerCase();
  const type = $('type-filter').value, severity = $('severity-filter').value, filter = $('status-filter').value;
  visible = model.cards.filter(c => (!type || c.finding.issue_type === type) && (!severity || c.finding.severity === severity)
    && (!filter || (filter === 'reviewed' ? Boolean(applicableFor(c)) : filter === 'stale' ? isStale(c) : filter === 'confirmed' ? findingVerdict(c)?.correct === true : filter === 'dismissed' ? findingVerdict(c)?.correct === false : filter === 'conflict' ? hasConflict(c) : status(c) === filter))
    && (!query || [c.finding.key, c.finding.source, c.finding.target, c.finding.suggestion, c.finding.evidence].join('\n').toLocaleLowerCase().includes(query)));
  const queue = $('queue'); queue.replaceChildren(); $('queue-count').textContent = `${visible.length} / ${model.cards.length}`;
  if (!visible.length) queue.append(node('p', 'empty', 'По этим фильтрам находок нет.'));
  for (const card of visible) {
    const button = node('button', 'queue-item' + (card.id === selectedId ? ' active' : ''));
    button.setAttribute('aria-pressed', String(card.id === selectedId));
    const row = node('div', 'row'); row.append(node('span', `badge ${card.finding.severity}`, severityNames[card.finding.severity]), node('span', 'state', stateNames[status(card)]));
    button.append(row, node('strong', '', labels[card.finding.issue_type]), node('span', 'excerpt', card.finding.key));
    if (hasConflict(card)) button.append(node('span', 'conflict-label', 'Конфликт рабочих версий'));
    button.addEventListener('click', async () => { await pending; selectedId = card.id; renderQueue(); renderDetail(); }); queue.append(button);
  }
  updateNavigation();
}

function updateNavigation() {
  if ($('previous-card')) $('previous-card').disabled = !adjacentCardId(model.cards, visible, selectedId, -1);
  if ($('next-card')) $('next-card').disabled = !adjacentCardId(model.cards, visible, selectedId, 1);
  $('next-pending').disabled = !model.cards.some(c => !c.blockedReason && status(c) === 'pending' && c.id !== selectedId);
}

function refreshFilters() {
  renderQueue();
  if (!visible.some(c => c.id === selectedId)) { selectedId = visible[0]?.id; renderQueue(); }
  renderDetail();
}
for (const id of ['type-filter', 'severity-filter', 'status-filter']) $(id).addEventListener('change', async () => { await pending; refreshFilters(); });
$('search').addEventListener('input', async () => { await pending; refreshFilters(); });
$('reset-filters').addEventListener('click', async () => { await pending; for (const id of ['search', 'type-filter', 'severity-filter', 'status-filter']) $(id).value = ''; refreshFilters(); });
$('next-pending').addEventListener('click', async () => {
  await pending;
  const remaining = model.cards.filter(c => !c.blockedReason && status(c) === 'pending' && c.id !== selectedId);
  const next = adjacentCardId(model.cards, remaining, selectedId, 1) ?? remaining[0]?.id;
  if (next) { selectedId = next; for (const id of ['search', 'type-filter', 'severity-filter', 'status-filter']) $(id).value = ''; refreshFilters(); $('detail').focus({ preventScroll: true }); }
});
$('expert-toggle').addEventListener('click', async () => { await pending; setExpertView(!expertMode); });

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
  if (hasConflict(card)) detail.append(node('div', 'blocked', 'Для этой строки есть разные рабочие переводы в других карточках. Согласуйте одну версию; варианты сохранены в журнале.'));
  const verdict = findingVerdict(card);
  if (verdict) detail.append(node('div', 'review-notice', `${verdict.correct ? 'Проблема и её тип подтверждены' : 'Проблема не подтверждена'} в импортированной анкете\n${verdict.reviewer} · ${verdict.reviewed_at}${verdict.notes ? '\n' + verdict.notes : ''}`));
  if (official) detail.append(node('div', 'review-notice', `Импортированная проверка: ${official.decision}\n${official.reviewer} · ${official.reviewed_at}\n${official.approved_text ?? 'Предложение отклонено'}\nНовые рабочие правки не изменяют этот журнал.`));
  const editor = node('section', 'editor'); editor.append(node('h3', '', 'Рабочее решение'), node('p', 'help', 'Принять предложение, написать свою версию или отклонить. Это подготовка к проверке носителем; отметка человека не создаётся.'));
  const textLabel = node('label', '', 'Ваша версия'), text = node('textarea'); text.id = 'proposed-text'; text.spellcheck = false; text.value = draft?.proposed_text ?? f.suggestion; text.disabled = Boolean(card.blockedReason); textLabel.append(text); editor.append(textLabel);
  const fields = node('div', 'editor-fields'); const authorLabel = node('label', '', 'Автор рабочего решения'), author = node('input'); author.value = draft?.author || editingAuthor; author.placeholder = 'Имя или инициалы'; author.maxLength = 200; authorLabel.append(author);
  const noteLabel = node('label', '', 'Комментарий'), note = node('input'); note.value = draft?.note ?? ''; note.placeholder = 'Контекст для следующего редактора'; noteLabel.append(note); fields.append(authorLabel, noteLabel); editor.append(fields);
  const actions = node('div', 'actions'); const accept = node('button', 'primary', 'Принять'), edit = node('button', '', 'Сохранить правку'), reject = node('button', 'danger', 'Отклонить'), reset = node('button', '', 'Убрать рабочее решение');
  accept.disabled = Boolean(card.blockedReason) || !f.suggestion; edit.disabled = reject.disabled = Boolean(card.blockedReason); author.disabled = note.disabled = Boolean(card.blockedReason);
  reset.disabled = !draft; actions.append(accept, edit, reject, reset); editor.append(actions);
  const saved = node('p', 'editor-status', draft ? `${stateNames[draft.decision]} · сохранено в рабочей сессии` : 'Изменения текста сохраняются в рабочую сессию автоматически.'); editor.append(saved); detail.append(editor);
  const revision = editRevision;
  let saveSequence = 0, localDecision = draft?.decision;
  function save(decision, refresh = false, explicit = false) {
    const value = text.value, memo = note.value, who = author.value; editingAuthor = who;
    localDecision = decision; const sequence = ++saveSequence; markDirty();
    pending = pending.then(async () => {
      if (sequence !== saveSequence) return;
      const result = await makeDraft(card, decision, value, memo, who);
      if (sequence !== saveSequence) return;
      drafts.set(card.id, result); pendingFailure = null; markDirty(); renderSummary(); renderQueue();
      if (revision === editRevision && sequence === saveSequence) {
        reset.disabled = false; saved.textContent = `${stateNames[result.decision]} · без отметки человека`;
        if (refresh) { text.value = result.proposed_text ?? f.suggestion; updatePreview(); }
        if (explicit && !visible.some(c => c.id === card.id)) {
          selectedId = adjacentCardId(model.cards, visible, card.id, 1) ?? adjacentCardId(model.cards, visible, card.id, -1) ?? undefined;
          renderQueue(); renderDetail();
        }
      }
    }).catch(error => { pendingFailure = error; message(`Решение не сохранено: ${error.message}`, true); });
  }
  accept.addEventListener('click', () => save('accepted', true, true)); edit.addEventListener('click', () => save('edited', false, true)); reject.addEventListener('click', () => save('rejected', true, true));
  reset.addEventListener('click', async () => { await pending; drafts.delete(card.id); markDirty(); renderSummary(); refreshFilters(); message('Рабочее решение убрано. Исходные строки и импортированные человеческие проверки сохранены.'); });
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
  previous.id = 'previous-card'; next.id = 'next-card';
  async function move(offset) { await pending; const target = adjacentCardId(model.cards, visible, card.id, offset); if (target) { selectedId = target; renderQueue(); renderDetail(); $('detail').focus({ preventScroll: true }); } }
  previous.addEventListener('click', () => move(-1)); next.addEventListener('click', () => move(1)); nav.append(previous, next); detail.append(nav); updateNavigation();
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function savedFile(text) { dirty = false; $('save-state').textContent = 'Файл подготовлен к сохранению'; message(text); }
async function exportSession(action) {
  document.querySelector('main').inert = true;
  try { await pending; if (pendingFailure) throw new Error('Сначала сохраните неудавшуюся правку повторно: ' + pendingFailure.message); await action(); }
  catch (error) { message('Экспорт не выполнен: ' + error.message, true); }
  finally { document.querySelector('main').inert = false; }
}
$('export-workspace').addEventListener('click', () => exportSession(() => { download('review-workspace.json', JSON.stringify(allWorkspace(), null, 2), 'application/json'); savedFile('Рабочий файл содержит все решения, комментарии, устаревшие записи и импортированные проверки. Сохраните загрузку, затем откройте её через «Импорт решений».'); }));
$('export-reviews').addEventListener('click', () => exportSession(() => { download('reviews.json', JSON.stringify({ schema_version: '1.0', target_locale: model.bundle.target_locale, decisions: checked.applicable }, null, 2), 'application/json'); message(`Экспортировано ${checked.applicable.length} применимых решений из импортированного журнала. Рабочие решения не превращены в человеческие проверки.`); }));
$('export-html').addEventListener('click', () => exportSession(() => {
  const clone = document.documentElement.cloneNode(true);
  const snapshot = { ...payload, workspace: allWorkspace(), reviews: null, precisionSample: null, view: expertMode ? 'expert' : 'review' };
  clone.querySelector('#report-data').textContent = JSON.stringify(snapshot).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  clone.querySelector('main').inert = false;
  // Runtime rebuilds these views from the embedded snapshot when reopened.
  for (const id of ['queue', 'detail', 'journal', 'expert-report']) clone.querySelector('#' + id).replaceChildren();
  download('review-report.html', '<!doctype html>\n' + clone.outerHTML, 'text/html'); savedFile('Самостоятельный HTML подготовлен с текущими решениями. Для передачи можно использовать этот файл без отдельного JSON.');
}));
$('import-button').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  document.querySelector('main').inert = true;
  try {
    await pending;
    const data = JSON.parse(await file.text());
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('Ожидается JSON-объект: рабочая сессия, reviews или анкета проверки находок.');
    if (data.kind === 'qazaq-loc-qa-workspace') {
      // Validate before asking to replace or changing any current decisions.
      await restoreWorkspace(data, model);
      if ((drafts.size || staleDrafts.length || reviews.decisions.length || precisionSample) && !window.confirm('Заменить текущую рабочую сессию содержимым файла? Сначала сохраните текущие решения, если они нужны.')) return;
      await loadWorkspace(data); pendingFailure = null;
    } else if (data.evaluation_scope === 'human_precision_sample') {
      const validated = await validatePrecision(data, model.report);
      if (precisionSample && !window.confirm('Заменить импортированную анкету проверки находок? Рабочие решения и reviews останутся.')) return;
      precisionSample = data; precisionResult = validated; stalePrecision = null;
    } else {
      const validated = await validateReviews(data, model);
      if (reviews.decisions.length && !window.confirm('Заменить импортированный журнал reviews? Рабочие решения останутся.')) return;
      reviews = data; checked = validated;
    }
    markDirty(); renderSummary(); refreshFilters();
    message(`Импорт завершён: ${drafts.size} рабочих решений, ${checked.applicable.length} проверок строк${precisionResult ? ', подтверждено проблем в выборке: ' + precisionResult.confirmed : ''}, ${staleDrafts.length + checked.stale.length} устаревших записей. Отметки человека не созданы.`);
  } catch (error) { message(`Импорт отменён, текущие решения сохранены: ${error.message}`, true); }
  finally { event.target.value = ''; document.querySelector('main').inert = false; }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('beforeprint', renderExpert);
renderSummary(); refreshFilters(); setExpertView(expertMode);
