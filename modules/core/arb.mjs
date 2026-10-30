import { parseTree, getNodeValue, printParseErrorCode } from 'jsonc-parser';
import { hashText } from '../../src/contracts.mjs';

export const entryId = (key, occurrence) => encodeURIComponent(key) + '#' + occurrence;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Keep the syntax tree: JSON.parse would silently discard duplicate keys.
export function readArb(text, side = 'arb') {
  const errors = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (errors.length || tree?.type !== 'object') {
    throw new Error(`${side}: invalid ARB JSON: ${errors.map(e => `${printParseErrorCode(e.error)} at ${e.offset}`).join(', ') || 'root must be an object'}`);
  }
  const diagnostics = [], properties = [], groups = new Map(), metadata = new Map();
  const counts = new Map(), lines = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines.push(i + 1);
  function location(offset) {
    let lo = 0, hi = lines.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (lines[mid] <= offset) lo = mid; else hi = mid; }
    return { offset, line: lo + 1, column: offset - lines[lo] + 1 };
  }
  function diagnostic(code, severity, evidence, property) {
    diagnostics.push({ code, severity, side, evidence, ...(property ? { key: property.key, occurrence: property.occurrence, ...location(property.offset) } : {}) });
  }
  let section = null;
  for (const node of tree.children ?? []) {
    const [keyNode, valueNode] = node.children;
    const key = keyNode.value, value = getNodeValue(valueNode);
    const occurrence = (counts.get(key) ?? 0) + 1;
    counts.set(key, occurrence);
    if (key === '@@comment' && typeof value === 'string') section = value;
    const property = { key, value, occurrence, section, kind: key.startsWith('@@') ? 'global' : key.startsWith('@') ? 'metadata' : 'message',
      ...location(node.offset), length: node.length, valueOffset: valueNode.offset, valueLength: valueNode.length, raw: text.slice(node.offset, node.offset + node.length) };
    properties.push(property);
    if (property.kind !== 'message') {
      metadata.set(key, property);
      if (key.startsWith('@') && !key.startsWith('@@') && !object(value)) diagnostic('invalid_metadata', 'error', 'Message metadata must be an object.', property);
      continue;
    }
    const group = groups.get(key) ?? [];
    group.push(property); groups.set(key, group);
    if (typeof value !== 'string') diagnostic('non_string_resource', 'error', 'ARB message value must be a string.', property);
    if (!/^[a-z$][a-zA-Z0-9_$]*$/.test(key)) diagnostic('invalid_resource_name', 'error', 'Resource name is incompatible with Flutter getters; metadata belongs in @key, not key@description.', property);
  }
  for (const [key, group] of groups) if (group.length > 1) {
    diagnostic('duplicate_key', 'error', `${group.length} occurrences; ${new Set(group.map(p => JSON.stringify(p.value))).size > 1 ? 'conflicting values' : 'identical values'}. Explicit recorded resolution is required before export.`, group[0]);
  }
  function walk(node, path = '', top = false) {
    if (node.type === 'object') {
      const seen = new Set();
      for (const property of node.children ?? []) {
        const [keyNode, valueNode] = property.children, key = keyNode.value;
        if (seen.has(key) && !(top && (key === '@@comment' || !key.startsWith('@')))) {
          diagnostics.push({ code: 'duplicate_attribute', severity: 'error', side, path: path + '/' + key, ...location(property.offset), evidence: 'Duplicate metadata/object member would lose information during export.' });
        }
        seen.add(key); walk(valueNode, path + '/' + key);
      }
    } else if (node.type === 'array') for (const [i, child] of (node.children ?? []).entries()) walk(child, path + '/' + i);
  }
  walk(tree, '', true);
  for (const [key, p] of metadata) if (key.startsWith('@') && !key.startsWith('@@') && !groups.has(key.slice(1))) diagnostic('orphan_metadata', 'warning', 'Metadata has no message in this file.', p);
  return { text, sha256: hashText(text), tree, properties, groups, metadata, diagnostics };
}

export function localeOf(arb, explicit) {
  const declared = arb.metadata.get('@@locale')?.value;
  const locale = explicit ?? declared;
  if (typeof locale !== 'string' || !locale.trim()) throw new Error('Missing locale: provide --source-locale/--target-locale or @@locale.');
  const canonical = value => Intl.getCanonicalLocales(value.replaceAll('_', '-'))[0];
  canonical(locale);
  if (declared !== undefined && (typeof declared !== 'string' || canonical(declared) !== canonical(locale))) throw new Error('Explicit locale conflicts with @@locale.');
  return locale;
}

export function arbSnapshot(arb) {
  return { sha256: arb.sha256, properties: arb.properties };
}

export function createBundle(source, target, sourceLocale, targetLocale, diagnostics) {
  const entries = [];
  for (const [key, originals] of source.groups) {
    if (originals.some(p => typeof p.value !== 'string') || new Set(originals.map(p => p.value)).size > 1) continue;
    const targets = target.groups.get(key) ?? [];
    if (targets.some(p => typeof p.value !== 'string')) continue;
    const original = originals[0];
    for (const current of targets.length ? targets : [null]) {
      const occurrence = current?.occurrence ?? 0;
      const description = target.metadata.get('@' + key)?.value?.description ?? source.metadata.get('@' + key)?.value?.description;
      const context = { section: current?.section ?? original.section };
      if (typeof description === 'string') context.description = description;
      entries.push({ entry_id: entryId(key, occurrence), key, occurrence, source: original.value, target: current?.value ?? null,
        source_hash: hashText(original.value), target_hash: hashText(current?.value ?? null), context });
    }
  }
  for (const [key, group] of target.groups) if (!source.groups.has(key)) diagnostics.push({ code: 'target_only_key', severity: 'warning', side: 'target', key, occurrence: group[0].occurrence, evidence: 'No source message; retained in audit/export, excluded from paired language analysis.' });
  return { schema_version: '1.0', source_locale: sourceLocale, target_locale: targetLocale, entries };
}
