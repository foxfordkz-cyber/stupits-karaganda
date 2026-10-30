import { hashText } from '../../src/contracts.mjs';
import { inspectProposal } from './workflow.mjs';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new Error('Invalid ' + label + ' fields');
  }
}

// Editorial notes are independent of the shared report/reviews schemas.
// No reviewer identity, decision or approval flag is accepted here.
export function annotateQueue(queue, notes) {
  exactFields(notes, ['workflow_version', 'target_locale', 'annotations'], 'annotations document');
  if (notes.workflow_version !== '1.0' || notes.target_locale !== queue.reviews.target_locale
    || !Array.isArray(notes.annotations)) throw new Error('Invalid annotations version, locale or list');
  const result = structuredClone(queue);
  const rows = new Map(result.rows.map(row => [row.entry_id, row]));
  const seen = new Set();
  for (const note of notes.annotations) {
    exactFields(note, ['entry_id', 'source_hash', 'original_hash', 'proposed_text',
      'author', 'rationale', 'questions'], 'annotation');
    if (!nonempty(note.entry_id) || !nonempty(note.author) || !nonempty(note.rationale)
      || (note.proposed_text !== null && !nonempty(note.proposed_text))
      || !Array.isArray(note.questions) || !note.questions.every(nonempty)) throw new Error('Invalid annotation values');
    if (seen.has(note.entry_id)) throw new Error('Duplicate annotation: ' + note.entry_id);
    seen.add(note.entry_id);
    const row = rows.get(note.entry_id);
    if (!row) throw new Error('Annotation absent from queue: ' + note.entry_id);
    if (note.source_hash !== row.source_hash || note.original_hash !== row.original_hash) {
      throw new Error('Stale annotation: ' + note.entry_id);
    }
    const technical = note.proposed_text === null ? null : inspectProposal(row.source, note.proposed_text);
    row.editorial_note = { ...structuredClone(note), proposed_hash: hashText(note.proposed_text),
      technical, status: 'pending_human_review', reviewed_by_human: false };
    if (note.proposed_text !== null && !row.proposals.some(p => p.text === note.proposed_text)) {
      row.proposals.push({ text: note.proposed_text, text_hash: hashText(note.proposed_text),
        technical, proposed_by: note.author });
    }
  }
  // Do not depend on object aliasing between rows and batches after serialization.
  result.batches = result.batches.map(batch => ({ ...batch, rows: batch.rows.map(row => rows.get(row.entry_id)) }));
  return result;
}

function block(value) {
  const text = JSON.stringify(value, null, 2);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}json\n${text}\n${fence}\n`;
}

export function renderReviewPacket(batch) {
  const lines = ['# Пакет для чтения носителем', '',
    `Пакет ${batch.batch_id}; записей: ${batch.rows.length}. Человеческие решения не заполнены.`, '',
    'Тексты ниже записаны как JSON-строки: кавычки обозначают границы, \\n — перенос строки.',
    'Прочитать исходник, существующий перевод, предложения и контекст. Проверить смысл,',
    'естественность, термины и технические элементы. Решение относится только к точному тексту.',
    'Заполнение заметок в этом документе не создаёт записи reviews и не разрешает экспорт.', ''];
  for (const [i, row] of batch.rows.entries()) {
    lines.push(`## Запись ${i + 1}`, '', 'Идентификатор:', block(row.entry_id),
      'Исходник:', block(row.source), 'Существующий перевод (null = отсутствует):', block(row.original_text));
    for (const proposal of row.proposals) {
      const editorial = row.editorial_note?.proposed_text === proposal.text;
      lines.push(editorial ? 'Редакторский вариант для чтения:' : 'Вариант исходной модели:', block(proposal.text),
        'SHA-256 предложения: ' + proposal.text_hash, '');
      if (proposal.technical.errors.length || proposal.technical.warnings.length) {
        lines.push('Технические замечания:', block({ errors: proposal.technical.errors, warnings: proposal.technical.warnings }));
      } else lines.push('Автоматические технические проверки пройдены; смысл проверяет человек.', '');
    }
    if (!row.proposals.length) lines.push('Безопасный вариант пока не предложен.', '');
    if (row.editorial_note) {
      lines.push('Автор заметки:', block(row.editorial_note.author),
        'Причина выбора:', block(row.editorial_note.rationale), 'Вопросы по контексту:', block(row.editorial_note.questions));
    } else lines.push('Причины кандидата:', block(row.findings.map(finding => finding.evidence)));
    if (Object.keys(row.context).length) lines.push('Доступный контекст:', block(row.context));
    lines.push('Версия исходной пары:', block({ source_hash: row.source_hash, original_hash: row.original_hash }),
      'Решение человека: ____________________', '',
      'Точный финальный текст / причина отклонения: ____________________', '',
      'Проверивший, время и комментарий: ____________________', '');
  }
  return lines.join('\n') + '\n';
}

export function renderTermPacket(terms) {
  const lines = ['# Термины для согласования', '',
    'Каждая запись — черновик. Сначала определить смысл и регистр; затем прочитать KK',
    'и комментарий. Словоформы не считаются ошибкой только из-за отличия от леммы.',
    'Незаполненная строка решения означает, что термин ещё не согласован.', ''];
  for (const [i, record] of terms.entries()) {
    lines.push(`## Термин ${i + 1}`, '', block(record.term),
      'SHA-256 версии глоссария: ' + record.glossary_hash, '',
      'Предпочтительный вариант и область применения: ____________________', '',
      'Допустимые варианты / исключения: ____________________', '',
      'Проверивший и дата (после чтения финального варианта): ____________________', '');
  }
  return lines.join('\n') + '\n';
}
