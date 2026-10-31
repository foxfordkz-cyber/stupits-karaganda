import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import { technicalSignature } from '../../src/arb-audit.mjs';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const unique = items => [...new Set(items)].sort();
const control = node => node.type === TYPE.select || node.type === TYPE.plural;
const markup = /<\/?[A-Za-z][A-Za-z0-9:_-]*(?=\s|\/?>)(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
const printf = /%%|%(?:(?:\d+)\$)?[-+#0 ]*(?:\d+|\*(?:\d+\$)?)?(?:\.(?:\d+|\*(?:\d+\$)?))?[sdif]/g;

export function hasLinguisticText(nodes) {
  return nodes.some(node => node.type === TYPE.literal
    ? /\p{L}/u.test(node.value.replace(markup, '').replace(printf, '').replace(/&(?:#\d+|#x[\da-fA-F]+|[A-Za-z][A-Za-z0-9]+);/g, ''))
    : node.options && Object.values(node.options).some(option => hasLinguisticText(option.value)));
}
const label = node => node.type === TYPE.plural ? node.pluralType : 'select';
const ruleCache = new Map();
function categories(locale, type) {
  const name = locale.replaceAll('_', '-'), id = name + ':' + type;
  if (!ruleCache.has(id)) {
    if (!Intl.PluralRules.supportedLocalesOf([name]).length) throw new Error('CLDR plural rules unavailable for ' + locale);
    ruleCache.set(id, new Set(new Intl.PluralRules(name, { type }).resolvedOptions().pluralCategories));
  }
  return ruleCache.get(id);
}

export function inspectMessage(text, locale) {
  // Relax only the mandatory-other check so a malformed plural can be classified
  // without guessing from a regex. The recursive parser still validates syntax.
  const ast = parse(text, { ignoreTag: true, requiresOtherClause: false, captureLocation: true });
  const pluralErrors = [], placeholderErrors = [], names = [], controls = [], scopeSignatures = new WeakMap();
  function visit(nodes, path = 'message') {
    for (const node of nodes) {
      if ([TYPE.argument, TYPE.number, TYPE.date, TYPE.time, TYPE.select, TYPE.plural].includes(node.type)) names.push(node.value);
      if (control(node)) {
        controls.push(node);
        const issues = node.type === TYPE.plural ? pluralErrors : placeholderErrors;
        if (!Object.hasOwn(node.options, 'other')) issues.push(`${node.value}: missing mandatory other branch`);
        if (node.type === TYPE.plural) {
          const allowed = categories(locale, node.pluralType);
          for (const selector of Object.keys(node.options)) if (!selector.startsWith('=') && !allowed.has(selector)) {
            // Flutter accepts all six CLDR labels, but unreachable labels are
            // reported using this locale's CLDR data; no RU->KK set equality.
            issues.push(`${node.value}: category ${selector} is unused for ${locale} ${node.pluralType}`);
          }
        }
        for (const [key, option] of Object.entries(node.options)) visit(option.value, `${path}/${node.value}/${key}`);
      }
    }
    // Raw spans retain ICU quoting. Rebuilding decoded literals would turn
    // escaped braces into arguments. Each branch needs its own token inventory:
    // a matching global inventory can hide tags/printf moved to another branch.
    const raw = nodes.length ? text.slice(nodes[0].location.start.offset, nodes.at(-1).location.end.offset) : '';
    try { scopeSignatures.set(nodes, technicalSignature(raw)); } catch (error) {
      if (!pluralErrors.length && !placeholderErrors.length) placeholderErrors.push(`${path}: ${error.message}`);
    }
  }
  visit(ast);
  return { ast, signature: scopeSignatures.get(ast) ?? null, scopeSignatures, names: unique(names), controls, pluralErrors, placeholderErrors };
}

// Compare each select/plural scope rather than just a global union. A plural
// moved out of one select branch must not be masked by another identical plural.
function compareScopes(source, target, path, pluralErrors, placeholderErrors, sourceSignatures, targetSignatures) {
  const sourceSignature = sourceSignatures.get(source), targetSignature = targetSignatures.get(target);
  if (sourceSignature && targetSignature) for (const field of ['printf', 'tags']) {
    if (!equal(sourceSignature[field], targetSignature[field])) placeholderErrors.push(`${path}: ${field}: expected ${JSON.stringify(sourceSignature[field])}, got ${JSON.stringify(targetSignature[field])}`);
  }
  for (const name of unique(source.filter(n => n.type === TYPE.argument).map(n => n.value))) {
    const expected = source.filter(n => n.type === TYPE.argument && n.value === name).length;
    const actual = target.filter(n => n.type === TYPE.argument && n.value === name).length;
    if (actual < expected) placeholderErrors.push(`${path}: bare argument ${name} expected ${expected} occurrences, got ${actual}`);
  }
  if (target.filter(n => n.type === TYPE.pound).length < source.filter(n => n.type === TYPE.pound).length) placeholderErrors.push(`${path}: ICU pound number token was removed`);
  function style(value) {
    if (value === undefined) return null;
    if (Array.isArray(value)) return value.map(style);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(k => k !== 'location').sort().map(k => [k, style(value[k])]));
    return value;
  }
  const formatted = target.filter(n => [TYPE.number, TYPE.date, TYPE.time].includes(n.type)), usedFormatted = new Set();
  for (const node of source.filter(n => [TYPE.number, TYPE.date, TYPE.time].includes(n.type))) {
    const i = formatted.findIndex((n, index) => !usedFormatted.has(index) && n.type === node.type && n.value === node.value && equal(style(n.style), style(node.style)));
    if (i < 0) placeholderErrors.push(`${path}: missing occurrence or changed ${TYPE[node.type]} style for ${node.value}`);
    else usedFormatted.add(i);
  }
  const a = source.filter(control), b = target.filter(control), used = new Set();
  for (const node of a) {
    const i = b.findIndex((other, index) => !used.has(index) && other.value === node.value && label(other) === label(node));
    const issues = node.type === TYPE.plural ? pluralErrors : placeholderErrors;
    if (i < 0) { issues.push(`${path}: missing ${label(node)} expression for ${node.value}`); continue; }
    used.add(i); const other = b[i];
    if (node.type === TYPE.plural && node.offset !== other.offset) issues.push(`${path}/${node.value}: changed plural offset`);
    const required = Object.keys(node.options).filter(key => node.type === TYPE.select || key.startsWith('=') || key === 'other');
    for (const key of required) if (!Object.hasOwn(other.options, key)) issues.push(`${path}/${node.value}: missing branch ${key}`);
    const compareBranch = (key, branch, match) => {
      const argumentsIn = nodes => unique(nodes.filter(n => [TYPE.argument, TYPE.number, TYPE.date, TYPE.time].includes(n.type)).map(n => n.value));
      const expected = argumentsIn(branch.value), actual = argumentsIn(match.value);
      if (expected.some(name => !actual.includes(name))) placeholderErrors.push(`${path}/${node.value}/${key}: branch argument missing`);
      compareScopes(branch.value, match.value, `${path}/${node.value}/${key}`, pluralErrors, placeholderErrors, sourceSignatures, targetSignatures);
    };
    for (const [key, branch] of Object.entries(node.options)) {
      // An omitted source plural category falls back to target other. Literal
      // text can change, but nested argument/control requirements cannot vanish.
      const match = other.options[key] ?? (node.type === TYPE.plural && !key.startsWith('=') ? other.options.other : undefined);
      if (match) compareBranch(key, branch, match);
    }
    // New localized branches also need the source fallback's technical content.
    for (const [key, branch] of Object.entries(other.options)) if (!Object.hasOwn(node.options, key) && node.options.other) compareBranch(key, node.options.other, branch);
  }
  for (const [i, node] of b.entries()) if (!used.has(i)) (node.type === TYPE.plural ? pluralErrors : placeholderErrors).push(`${path}: unexpected ${label(node)} expression for ${node.value}`);
}

export function compareMessages(source, target) {
  const pluralErrors = [...target.pluralErrors], placeholderErrors = [...target.placeholderErrors];
  if (!equal(source.names, target.names)) placeholderErrors.push(`ICU arguments: expected ${JSON.stringify(source.names)}, got ${JSON.stringify(target.names)}`);
  compareScopes(source.ast, target.ast, 'message', pluralErrors, placeholderErrors, source.scopeSignatures, target.scopeSignatures);
  if (source.signature && target.signature) {
    for (const requirement of source.signature.icuRequirements) {
      const kind = JSON.parse(requirement)[0];
      if (!['plural', 'selectordinal', 'select'].includes(kind) && !target.signature.icuRequirements.includes(requirement)) placeholderErrors.push('Changed formatted argument: ' + requirement);
    }
  }
  return { pluralErrors: unique(pluralErrors), placeholderErrors: unique(placeholderErrors) };
}

export function protectedTokens(text, tolerateMalformed = false) {
  // Preserve decoded control characters, private/font glyphs, format controls,
  // symbols (including emoji), literal slashes/entities, and escaped ICU braces.
  const literals = [];
  function visit(nodes) {
    for (const node of nodes) {
      if (node.type === TYPE.literal) literals.push(node.value);
      if (node.options) for (const branch of Object.values(node.options)) visit(branch.value);
    }
  }
  let malformed = false;
  try { visit(parse(text, { ignoreTag: true, requiresOtherClause: false })); }
  catch (error) { if (!tolerateMalformed) throw error; literals.push(text); malformed = true; }
  const tokens = literals.flatMap(value => value.match(/\r\n|%%|[\r\n\t\u2028\u2029\\{}]|[\p{Co}\p{Cf}\p{S}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]|&(?:#\d+|#x[\da-fA-F]+|[A-Za-z][A-Za-z0-9]+);/gu) ?? []);
  // A malformed original can be repaired, including its braces. Its raw font
  // glyphs and line breaks must still survive even when no AST can be built.
  return [...(malformed ? tokens.filter(token => token !== '{' && token !== '}') : tokens), ...(text.match(/''/g) ?? [])].sort();
}

export function visibleLength(ast, locale) {
  const segmenter = new Intl.Segmenter(locale.replaceAll('_', '-'), { granularity: 'grapheme' });
  function length(nodes) {
    return nodes.reduce((sum, node) => {
      if (node.type === TYPE.literal) return sum + [...segmenter.segment(node.value.replace(markup, '').replace(printf, ''))].length;
      if (node.options) return sum + Math.max(0, ...Object.values(node.options).map(option => length(option.value)));
      return sum; // runtime values have no knowable display width
    }, 0);
  }
  return length(ast);
}
