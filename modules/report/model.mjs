// Shared by the self-contained browser report and the Node test runner.
// Drafts are working choices, never attestations of human review.
import { validatePrecision } from './precision.mjs';

const DECISIONS = new Set(['accepted', 'edited', 'rejected']);
const HASH = /^[a-f0-9]{64}$/;
const FINDING_FIELDS = ['key', 'issue_type', 'severity', 'source', 'target', 'evidence', 'suggestion', 'confidence', 'reviewed_by_human'];
const REVIEW_FIELDS = ['key', 'entry_id', 'decision', 'original_text', 'approved_text', 'source_hash', 'original_hash', 'approved_hash', 'reviewer', 'reviewed_at', 'reviewed_by_human'];
const DRAFT_FIELDS = ['card_id', 'key', 'entry_id', 'source_hash', 'original_hash', 'suggestion_hash', 'decision', 'proposed_text', 'proposed_hash', 'note', 'updated_at', 'author'];

function insist(condition, message) {
  if (!condition) throw new Error(message);
}

function exactObject(value, fields, label) {
  insist(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: ожидается объект`);
  const keys = Object.keys(value);
  insist(keys.length === fields.length && fields.every(field => Object.hasOwn(value, field)), `${label}: неверный набор полей`);
}

function isText(value) { return typeof value === 'string'; }
function isNullableText(value) { return value === null || isText(value); }
function isHash(value) { return isText(value) && HASH.test(value); }
function isNullableHash(value) { return value === null || isHash(value); }
function validLocale(value) {
  if (!isText(value) || value.length < 2) return false;
  try { return Intl.getCanonicalLocales(value.replaceAll('_', '-')).length === 1; }
  catch { return false; }
}

// Match the repository's ajv-formats full date-time validator, including offsets.
// Date.parse alone silently accepts 30 February and rejects some allowed offsets.
function validDateTime(value) {
  if (!isText(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})[tT\s](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(?:[zZ]|([+-])(\d{2})(?::?(\d{2}))?)$/.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi, s, sign, oh, om] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1])) return false;
  const hour = Number(h), minute = Number(mi), second = Number(s);
  const offsetHour = Number(oh ?? 0), offsetMinute = Number(om ?? 0), direction = sign === '-' ? -1 : 1;
  if (offsetHour > 23 || offsetMinute > 59) return false;
  if (hour <= 23 && minute <= 59 && second < 60) return true;
  const utcMinute = minute - offsetMinute * direction;
  const utcHour = hour - offsetHour * direction - (utcMinute < 0 ? 1 : 0);
  return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61;
}

/** SHA-256 of exact UTF-8, deliberately preserving whitespace and Unicode form. */
export async function sha256(value) {
  if (value === null) return null;
  insist(isText(value), 'Для SHA-256 ожидается строка или null');
  insist(globalThis.crypto?.subtle, 'Браузер не поддерживает локальный SHA-256 (Web Crypto). Откройте отчёт в современном браузере.');
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Inputs have already passed the official schemas at the render boundary. */
export function createModel(bundle, report) {
  const byKey = new Map();
  for (const entry of bundle.entries) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, []);
    byKey.get(entry.key).push(entry);
  }
  const counts = new Map();
  const cards = report.map(finding => {
    const snapshot = 'finding:' + JSON.stringify(FINDING_FIELDS.map(field => finding[field]));
    const occurrence = (counts.get(snapshot) ?? 0) + 1;
    counts.set(snapshot, occurrence);
    const id = snapshot + ':' + occurrence;
    const candidates = byKey.get(finding.key) ?? [];
    let blockedReason = null;
    let entry = null;
    if (!candidates.length) blockedReason = 'Ключ отсутствует в bundle; требуется согласованный контекст.';
    else if (candidates.length > 1) blockedReason = 'Ключ имеет несколько вхождений. Сначала разрешите неоднозначный дубль.';
    else if (candidates[0].source !== finding.source || (candidates[0].target ?? '') !== finding.target) {
      blockedReason = 'Тексты находки не совпадают с bundle; требуется актуальный отчёт.';
    } else entry = candidates[0];
    return { id, finding, entry, blockedReason, candidates };
  });
  return { bundle, report, cards };
}

function findEntry(model, key, entryId) {
  const candidates = model.bundle.entries.filter(entry => entry.key === key);
  if (candidates.length > 1) return { reason: 'Ключ имеет несколько вхождений; требуется разрешение дублей.' };
  const entry = candidates[0];
  if (!entry || entry.entry_id !== entryId) return { reason: 'В текущем bundle отсутствует это вхождение ключа.' };
  return { entry };
}

/** Validate official reviews without creating, changing or trusting attestations. */
export async function validateReviews(reviews, model) {
  exactObject(reviews, ['schema_version', 'target_locale', 'decisions'], 'reviews');
  insist(reviews.schema_version === '1.0', 'reviews: неизвестная версия схемы');
  insist(validLocale(reviews.target_locale), 'reviews: неверная локаль');
  insist(reviews.target_locale === model.bundle.target_locale, 'Локаль журнала не совпадает с локалью bundle.');
  insist(Array.isArray(reviews.decisions), 'reviews: decisions должен быть массивом');
  const ids = new Set(), applicable = [], stale = [];
  for (const decision of reviews.decisions) {
    exactObject(decision, REVIEW_FIELDS, 'reviews.decision');
    const d = decision;
    insist(isText(d.key) && d.key.length > 0 && isText(d.entry_id) && d.entry_id.length > 0, 'reviews: пустой key или entry_id');
    insist(!ids.has(d.entry_id), 'reviews: повторное решение для entry_id ' + d.entry_id);
    ids.add(d.entry_id);
    insist(DECISIONS.has(d.decision), 'reviews: неизвестное решение');
    insist(isNullableText(d.original_text) && isNullableText(d.approved_text), 'reviews: неверный тип текста');
    insist(isHash(d.source_hash) && isNullableHash(d.original_hash) && isNullableHash(d.approved_hash), 'reviews: неверный формат хэша');
    insist(isText(d.reviewer) && d.reviewer.trim().length > 0, 'reviews: проверяющий должен быть указан явно');
    insist(validDateTime(d.reviewed_at), 'reviews: неверная дата проверки с часовым поясом');
    insist(d.reviewed_by_human === true, 'reviews: требуется существующая явная отметка проверки');
    insist(d.original_hash === await sha256(d.original_text) && d.approved_hash === await sha256(d.approved_text), 'reviews: хэш не совпадает с точным текстом');
    insist(d.decision === 'rejected' ? d.approved_text === null : d.approved_text !== null, 'reviews: текст не соответствует виду решения');
    let reason = null;
    const located = findEntry(model, d.key, d.entry_id);
    if (located.reason) reason = located.reason;
    else if (d.source_hash !== located.entry.source_hash) reason = 'Исходный текст изменился после проверки.';
    else if (d.original_text !== located.entry.target || d.original_hash !== located.entry.target_hash) reason = 'Исходный перевод изменился после проверки.';
    if (reason) stale.push({ decision, reason });
    else applicable.push(decision);
  }
  return { applicable, stale };
}

/** Buttons only make draft choices. They cannot manufacture human approval. */
export async function makeDraft(card, decision, text, note = '', author = '') {
  insist(card.entry && !card.blockedReason, 'Для этой карточки решение недоступно: ' + (card.blockedReason ?? 'нет вхождения'));
  insist(DECISIONS.has(decision), 'Неизвестный вид решения');
  insist(isText(note) && isText(author), 'Заметка и автор должны быть строками');
  if (decision === 'accepted') insist(card.finding.suggestion !== '', 'Без предложения используйте ручное исправление');
  const proposed = decision === 'rejected' ? null : decision === 'accepted' ? card.finding.suggestion : text;
  insist(isNullableText(proposed) && (decision === 'rejected' || proposed !== null), 'Для исправления требуется текст');
  return {
    card_id: card.id,
    key: card.finding.key,
    entry_id: card.entry.entry_id,
    source_hash: await sha256(card.entry.source),
    original_hash: await sha256(card.entry.target),
    suggestion_hash: await sha256(card.finding.suggestion),
    decision,
    proposed_text: proposed,
    proposed_hash: await sha256(proposed),
    note,
    updated_at: new Date().toISOString(),
    author
  };
}

/** Preserve stale drafts as well as current ones when exporting the workspace. */
export function createWorkspace(model, drafts, reviews = { schema_version: '1.0', target_locale: model.bundle.target_locale, decisions: [] }, precisionSample = null) {
  const workspace = {
    kind: 'qazaq-loc-qa-workspace',
    version: precisionSample === null ? 1 : 2,
    target_locale: model.bundle.target_locale,
    drafts: structuredClone(drafts),
    imported_reviews: structuredClone(reviews)
  };
  if (precisionSample !== null) workspace.imported_precision = structuredClone(precisionSample);
  return workspace;
}

export async function restoreWorkspace(workspace, model) {
  const fields = ['kind', 'version', 'target_locale', 'drafts', 'imported_reviews'];
  if (workspace?.version === 2) fields.push('imported_precision');
  exactObject(workspace, fields, 'workspace');
  insist(workspace.kind === 'qazaq-loc-qa-workspace' && [1, 2].includes(workspace.version), 'Неизвестный формат рабочего файла');
  if (workspace.version === 2) insist(workspace.imported_precision !== null && typeof workspace.imported_precision === 'object' && !Array.isArray(workspace.imported_precision), 'workspace: imported_precision должен быть объектом анкеты');
  insist(validLocale(workspace.target_locale), 'workspace: неверная локаль');
  insist(workspace.target_locale === model.bundle.target_locale, 'Локаль рабочего файла не совпадает с bundle.');
  insist(Array.isArray(workspace.drafts), 'workspace: drafts должен быть массивом');
  const drafts = [], staleDrafts = [], seenRecords = new Set(), activeCards = new Set();
  const cards = new Map(model.cards.map(card => [card.id, card]));
  for (const draft of workspace.drafts) {
    exactObject(draft, DRAFT_FIELDS, 'workspace.draft');
    const d = draft;
    insist(isText(d.card_id) && d.card_id.length > 0 && isText(d.key) && d.key.length > 0, 'workspace: пустой идентификатор карточки или ключ');
    insist(d.entry_id === null || (isText(d.entry_id) && d.entry_id.length > 0), 'workspace: неверный entry_id');
    // A stale historical choice may share a card identity with a new choice,
    // e.g. when bundle target changes from absent to an existing empty string.
    // Preserve such history, but never accept duplicate records or two current choices.
    const recordId = JSON.stringify(DRAFT_FIELDS.map(field => d[field]));
    insist(!seenRecords.has(recordId), 'workspace: повторная запись черновика');
    seenRecords.add(recordId);
    insist(isHash(d.source_hash) && isNullableHash(d.original_hash) && isHash(d.suggestion_hash) && isNullableHash(d.proposed_hash), 'workspace: неверный хэш');
    insist(DECISIONS.has(d.decision), 'workspace: неизвестное решение');
    insist(isNullableText(d.proposed_text) && (d.decision === 'rejected' ? d.proposed_text === null : d.proposed_text !== null), 'workspace: неверный текст решения');
    insist(isText(d.note) && isText(d.author) && validDateTime(d.updated_at), 'workspace: неверная заметка, автор или дата');
    insist(d.proposed_hash === await sha256(d.proposed_text), 'workspace: хэш предложения не совпадает с точным текстом');
    const card = cards.get(d.card_id);
    let reason = null;
    if (!card) reason = 'Находка удалена или её данные изменились.';
    else if (card.blockedReason || !card.entry) reason = card.blockedReason ?? 'Нет применимого вхождения.';
    else if (d.key !== card.finding.key || d.entry_id !== card.entry.entry_id) reason = 'Идентификатор вхождения изменился.';
    else if (d.source_hash !== card.entry.source_hash || d.original_hash !== card.entry.target_hash) reason = 'Исходный текст или перевод изменился.';
    else if (d.suggestion_hash !== await sha256(card.finding.suggestion)) reason = 'Предложение детектора изменилось.';
    else if (d.decision === 'accepted' && (d.proposed_text !== card.finding.suggestion || card.finding.suggestion === '')) reason = 'Принятый текст не совпадает с предложением детектора.';
    if (reason) staleDrafts.push({ draft, reason });
    else {
      insist(!activeCards.has(d.card_id), 'workspace: несколько применимых черновиков для карточки');
      activeCards.add(d.card_id);
      drafts.push(draft);
    }
  }
  const reviews = await validateReviews(workspace.imported_reviews, model);
  let precision = null, stalePrecision = null;
  if (workspace.version === 2) {
    try { precision = await validatePrecision(workspace.imported_precision, model.report); }
    catch (error) { stalePrecision = { sample: workspace.imported_precision, reason: error.message }; }
  }
  return { drafts, staleDrafts, reviews, precision, stalePrecision };
}

/** A string may have several issue cards, but cannot adopt conflicting versions. */
export function draftConflicts(drafts) {
  const entries = new Map();
  for (const draft of drafts instanceof Map ? drafts.values() : drafts) {
    if (!draft.entry_id || !['accepted', 'edited'].includes(draft.decision) || typeof draft.proposed_text !== 'string') continue;
    if (!entries.has(draft.entry_id)) entries.set(draft.entry_id, { entry_id: draft.entry_id, key: draft.key, drafts: [] });
    entries.get(draft.entry_id).drafts.push(draft);
  }
  return [...entries.values()].filter(group => new Set(group.drafts.map(draft => draft.proposed_text)).size > 1);
}

/** Navigation follows the report order even after a status filter hides selection. */
export function adjacentCardId(cards, visibleCards, selectedId, direction) {
  insist(direction === 1 || direction === -1, 'Направление перехода должно быть 1 или -1');
  const visibleIds = new Set(visibleCards.map(card => card.id));
  const current = cards.findIndex(card => card.id === selectedId);
  if (current < 0) {
    const ordered = direction === 1 ? cards : [...cards].reverse();
    return ordered.find(card => visibleIds.has(card.id))?.id ?? null;
  }
  for (let index = current + direction; index >= 0 && index < cards.length; index += direction) {
    if (visibleIds.has(cards[index].id)) return cards[index].id;
  }
  return null;
}
