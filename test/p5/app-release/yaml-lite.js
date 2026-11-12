// A small YAML reader for this track's tests: the GitHub workflow and the Maestro flows. The server's install has no
// YAML library (ci.yml installs no app packages), so this reads the subset those files use: block mappings and
// sequences, `|` and `>` block scalars, flow `{ }` and `[ ]` collections, quoted and plain scalars, comments, and
// several documents split by `---`. Anything else it does not understand throws, so a file it misreads fails loudly.

const isBlank = (line) => /^\s*(?:#.*)?$/.test(line);
const indentOf = (line) => /^ */.exec(line)[0].length;

/** `text` up to an inline comment (` #` outside quotes). */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

/** Splits `text` at `sep` where it is outside quotes and brackets. */
function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Where a mapping key ends: the first `:` followed by a space or the end, outside quotes and brackets. */
function keyEnd(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if ((c === "'" || c === '"') && i === 0) quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 0 && (i === text.length - 1 || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function scalar(raw) {
  const text = raw.trim();
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Error(`Unclosed quote: ${text}`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('"')) return JSON.parse(text);
  if (text.startsWith('{')) {
    const inner = text.replace(/^\{|\}$/g, '').trim();
    return Object.fromEntries(inner ? splitTop(inner, ',').map((pair) => {
      const at = keyEnd(pair.trim());
      if (at < 0) throw new Error(`Not a key: value pair: ${pair}`);
      return [scalar(pair.trim().slice(0, at)), scalar(pair.trim().slice(at + 1))];
    }) : []);
  }
  if (text.startsWith('[')) {
    const inner = text.replace(/^\[|\]$/g, '').trim();
    return inner ? splitTop(inner, ',').map(scalar) : [];
  }
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true' || text === 'false') return text === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function blockScalar(lines, start, parentIndent, style) {
  let end = start;
  while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > parentIndent)) end++;
  const body = lines.slice(start, end);
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  const cut = Math.min(...body.filter((line) => line.trim()).map(indentOf));
  const text = body.map((line) => line.slice(cut)).join('\n');
  return [style.startsWith('>') ? text.replace(/([^\n])\n(?=[^\n ])/g, '$1 ') : `${text}\n`, end];
}

function nextContent(lines, i) {
  while (i < lines.length && isBlank(lines[i])) i++;
  return i;
}

function parseBlock(lines, i, indent) {
  i = nextContent(lines, i);
  if (i >= lines.length) return [null, i];
  return /^-(?: |$)/.test(lines[i].slice(indent)) ? parseSequence(lines, i, indent) : parseMapping(lines, i, indent);
}

function parseValue(lines, i, indent, rest) {
  const value = stripComment(rest).trim();
  if (/^[|>][-+]?$/.test(value)) return blockScalar(lines, i, indent, value);
  if (value !== '') return [scalar(value), i];
  const next = nextContent(lines, i);
  if (next < lines.length && (indentOf(lines[next]) > indent || (indentOf(lines[next]) === indent && /^-(?: |$)/.test(lines[next].slice(indent))))) {
    return parseBlock(lines, next, indentOf(lines[next]));
  }
  return [null, i];
}

function parseMapping(lines, i, indent) {
  const out = {};
  while ((i = nextContent(lines, i)) < lines.length && indentOf(lines[i]) === indent && !/^-(?: |$)/.test(lines[i].slice(indent))) {
    const text = lines[i].slice(indent);
    const at = keyEnd(text);
    if (at < 0) throw new Error(`Line ${i + 1}: expected "key: value", got "${text}"`);
    const key = scalar(text.slice(0, at));
    [out[key], i] = parseValue(lines, i + 1, indent, text.slice(at + 1));
  }
  if (i < lines.length && indentOf(lines[i]) > indent) throw new Error(`Line ${i + 1}: unexpected indentation`);
  return [out, i];
}

function parseSequence(lines, i, indent) {
  const out = [];
  while ((i = nextContent(lines, i)) < lines.length && indentOf(lines[i]) === indent && /^-(?: |$)/.test(lines[i].slice(indent))) {
    const rest = lines[i].slice(indent + 1);
    const content = stripComment(rest).trim();
    if (content === '') {
      let value;
      [value, i] = parseValue(lines, i + 1, indent, '');
      out.push(value);
    } else if (keyEnd(content) >= 0 && !/^['"{[]/.test(content)) {
      // "- key: value" starts a mapping whose keys sit two columns in.
      const copy = [...lines];
      copy[i] = `${' '.repeat(indent + 2)}${rest.replace(/^ +/, '')}`;
      let value;
      [value, i] = parseMapping(copy, i, indent + 2);
      out.push(value);
    } else {
      out.push(scalar(content));
      i++;
    }
  }
  return [out, i];
}

/** One document. */
export function parseYaml(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const start = nextContent(lines, 0);
  if (start >= lines.length) return null;
  const [value, end] = parseBlock(lines, start, indentOf(lines[start]));
  if (nextContent(lines, end) < lines.length) throw new Error(`Line ${nextContent(lines, end) + 1}: not read`);
  return value;
}

/** Every document in a file of several, split by `---` lines. */
export const parseYamlDocs = (text) => String(text).replace(/\r\n/g, '\n').split(/^---[ \t]*$/m).map(parseYaml);
