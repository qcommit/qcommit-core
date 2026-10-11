/** Bounded JSON parser that rejects duplicate members before they can disappear. */
export function parseJson(text, maxBytes = 65536) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > maxBytes) throw new Error('JSON exceeds its size limit.');
  let at = 0;
  function ws() { while (/[ \t\n\r]/.test(text[at] ?? '') && at < text.length) at++; }
  function fail() { throw new Error(`Invalid JSON near character ${at}.`); }
  function string() {
    const start = at++;
    while (at < text.length) {
      if (text[at] === '"') { at++; return JSON.parse(text.slice(start, at)); }
      if (text[at] === '\\') at++;
      at++;
    }
    fail();
  }
  function value(depth) {
    if (depth > 12) throw new Error('JSON nesting is too deep.');
    ws();
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++; ws(); const out = Object.create(null);
      if (text[at] === '}') { at++; return out; }
      while (at < text.length) {
        ws(); if (text[at] !== '"') fail(); const key = string(); ws();
        if (Object.hasOwn(out, key)) throw new Error(`Duplicate JSON field: ${key}`);
        if (text[at++] !== ':') fail(); out[key] = value(depth + 1); ws();
        const next = text[at++]; if (next === '}') return out; if (next !== ',') fail();
      }
    }
    if (text[at] === '[') {
      at++; ws(); const out = [];
      if (text[at] === ']') { at++; return out; }
      while (at < text.length) {
        out.push(value(depth + 1)); ws(); const next = text[at++];
        if (next === ']') return out; if (next !== ',') fail();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!match) fail(); at += match[0].length; const parsed = JSON.parse(match[0]); if(typeof parsed === 'number' && !Number.isFinite(parsed)) fail(); return parsed;
  }
  const result = value(0); ws(); if (at !== text.length) fail(); return result;
}
