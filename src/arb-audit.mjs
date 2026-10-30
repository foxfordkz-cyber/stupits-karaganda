import { parseTree, getNodeValue, printParseErrorCode } from 'jsonc-parser';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

export function inspectArb(text) {
  const errors = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (errors.length || root?.type !== 'object') {
    throw new Error('Invalid ARB JSON: ' + errors.map(e => printParseErrorCode(e.error) + '@' + e.offset).join(', '));
  }
  const entries = [], strings = new Map(), metadata = new Map(), groups = new Map();
  for (const property of root.children ?? []) {
    const key = property.children[0].value;
    const value = getNodeValue(property.children[1]);
    if (key.startsWith('@')) { metadata.set(key, value); continue; }
    if (typeof value !== 'string') throw new Error('Non-string ARB resource: ' + key);
    const previous = groups.get(key) ?? [];
    const entry = { key, text: value, occurrence: previous.length + 1, offset: property.offset };
    previous.push(entry); groups.set(key, previous); entries.push(entry); strings.set(key, value);
  }
  const duplicates = [...groups].filter(([,g]) => g.length > 1).map(([key,g]) => ({
    key, conflicting: new Set(g.map(e => e.text)).size > 1, occurrences: g
  }));
  // Nested duplicate attributes must not be silently discarded either.
  const nestedDuplicates = [];
  function walk(node, path, top = false) {
    if (node.type === 'object') {
      const seen = new Set();
      for (const p of node.children ?? []) {
        const key = p.children[0].value;
        if (seen.has(key) && !(top && (key === '@@comment' || !key.startsWith('@')))) nestedDuplicates.push(path + '/' + key);
        seen.add(key); walk(p.children[1], path + '/' + key);
      }
    } else if (node.type === 'array') {
      for (const [i,child] of (node.children ?? []).entries()) walk(child, path + '/' + i);
    }
  }
  walk(root, '', true);
  return { entries, strings, metadata, duplicates, nestedDuplicates };
}

function canonicalStyle(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalStyle);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalStyle(value[key])]));
  }
  return value;
}

function printfSignature(text) {
  const tokens = [];
  let fullyNumbered = true;
  // Preserve positional meaning. %% consumes no argument. A '*' consumes an
  // additional argument and must also be numbered before token sorting is safe.
  const pattern = /^%(?:(\d+)\$)?[-+#0 ]*(?:(\d+)|(\*)(?:(\d+)\$)?)?(?:\.(?:(\d+)|(\*)(?:(\d+)\$)?))?[sdif]/;
  for (let offset = 0; offset < text.length;) {
    if (text[offset] !== '%') { offset += 1; continue; }
    if (text[offset + 1] === '%') { offset += 2; continue; }
    const match = pattern.exec(text.slice(offset));
    if (!match) { offset += 1; continue; }
    const [, position, , widthStar, widthPosition, , precisionStar, precisionPosition] = match;
    if (!position || (widthStar && !widthPosition) || (precisionStar && !precisionPosition)) {
      fullyNumbered = false;
    }
    tokens.push(match[0]);
    offset += match[0].length;
  }
  return fullyNumbered ? tokens.sort() : tokens;
}

function tagSignature(text) {
  // Keep raw tokens for preservation checks, while checking structural balance.
  // Quoted attributes may themselves contain '>' characters. Standalone
  // <nick>-style tokens are permitted when that name has no closing tag; their
  // raw token still has to be preserved by the release gate.
  const pattern = /<\/?[A-Za-z][A-Za-z0-9:_-]*(?=\s|\/?>)(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
    'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const tokens = text.match(pattern) ?? [];
  const closingNames = new Set(tokens.filter(token => token.startsWith('</'))
    .map(token => /^<\/([A-Za-z][A-Za-z0-9:_-]*)/.exec(token)[1].toLowerCase()));
  const stack = [];
  for (const token of tokens) {
    const name = /^<\/?([A-Za-z][A-Za-z0-9:_-]*)/.exec(token)[1].toLowerCase();
    if (token.startsWith('</')) {
      if (voidTags.has(name)) throw new Error('Void markup tag must not have a closing tag: ' + name);
      const opening = stack.pop();
      if (opening !== name) throw new Error('Unbalanced markup tag: expected closing ' + (opening ?? '(none)') + ', got ' + name);
    } else if (closingNames.has(name) && !voidTags.has(name) && !/\/\s*>$/.test(token)) {
      stack.push(name);
    }
  }
  if (stack.length) throw new Error('Unclosed markup tag: ' + stack[stack.length - 1]);
  return tokens.sort();
}

export function technicalSignature(text) {
  const names = new Set(), requirements = new Set();
  const require = (...tuple) => requirements.add(JSON.stringify(tuple));
  function walk(nodes) {
    for (const node of nodes) {
      if ([TYPE.argument, TYPE.number, TYPE.date, TYPE.time, TYPE.select, TYPE.plural].includes(node.type)) names.add(node.value);
      if (node.type === TYPE.plural) {
        const kind = node.pluralType === 'ordinal' ? 'selectordinal' : 'plural';
        require(kind, node.value, 'offset', node.offset ?? 0);
        // CLDR categories differ between locales. Preserve explicit =N branches,
        // but do not require identical one/few/many category sets.
        for (const selector of Object.keys(node.options)) {
          if (selector.startsWith('=')) require(kind, node.value, 'exact', selector);
        }
      } else if (node.type === TYPE.select) {
        require('select', node.value);
        for (const selector of Object.keys(node.options)) require('select', node.value, 'selector', selector);
      } else if ([TYPE.number, TYPE.date, TYPE.time].includes(node.type)) {
        require(TYPE[node.type], node.value, 'style', canonicalStyle(node.style));
      }
      if (node.options) for (const option of Object.values(node.options)) walk(option.value);
      if (node.children) walk(node.children);
    }
  }
  walk(parse(text, { ignoreTag: true, requiresOtherClause: true }));
  return {
    placeholders: [...names].sort(),
    printf: printfSignature(text),
    tags: tagSignature(text),
    // JSON-encoded tuples avoid collisions if an ICU identifier includes ':'.
    // A target must contain every source requirement; extra localized branches
    // and plural categories are allowed.
    icuRequirements: [...requirements].sort()
  };
}
