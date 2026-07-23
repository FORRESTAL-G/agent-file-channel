// toon.js — encoder TOON (Token-Oriented Object Notation) minimale.
//
// Modulo condiviso tra il CLI (bin/agent-channel.js) e i test di validazione
// (test/toon.test.js). Zero dipendenze. Copre il subset emesso dal CLI:
//   - oggetti (key: value, key: + blocco annidato)
//   - array tabulari (key[N]{f1,f2}: + N righe delimiter-separated)
//   - array inline di primitive (key[N]: a, b, c)
//   - array vuoti (key[0]:)
//   - scalari: number / boolean / null / string (quoted se serve)
//
// Spec di riferimento: https://toonformat.dev/reference/spec.html (v3.0).
// Indentazione 2 spazi, LF, nessun trailing space. Il decoder companion è in
// ./toon-decode.js e verifica il round-trip (vedi `npm test`).

const TOON_DELIM = ',';

// Una stringa va quoted se contiene delimiter/strutturali/nuova riga, è vuota,
// ha leading/trailing space, o unquoted sembrerebbe number/bool/null.
function needsQuote(s) {
  if (s === '') return true;
  if (s !== s.trim()) return true; // leading/trailing whitespace
  if (/["\n\r:,{}[\]]/.test(s)) return true;
  // ambiguità con primitivi
  if (s === 'true' || s === 'false' || s === 'null') return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  return false;
}

function quoteString(s) {
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return '"' + escaped + '"';
}

function toonScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'null';
    return String(v);
  }
  const s = String(v);
  return needsQuote(s) ? quoteString(s) : s;
}

// Rende una cella di riga tabulare: number/bool/null restano scalari unquoted,
// le stringhe sono safe col delimiter attivo (`,`).
function toonCell(v) {
  if (typeof v === 'number') return toonScalar(v);
  if (typeof v === 'boolean') return toonScalar(v);
  if (v === null || v === undefined) return 'null';
  const s = String(v);
  // In una riga delimitata da `,` serve quotare anche se contiene solo virgola.
  return needsQuote(s) ? quoteString(s) : s;
}

// Array di oggetti uniformi (tutti object con stesse keys nello stesso ordine)
// → forma tabulare (header + righe). È la forma token-efficient usata per i log.
function isUniformObjectArray(arr) {
  if (!arr.length || typeof arr[0] !== 'object' || arr[0] === null || Array.isArray(arr[0])) return false;
  const keys = Object.keys(arr[0]);
  if (!keys.length) return false;
  return arr.every((o) => o && typeof o === 'object' && !Array.isArray(o)
    && Object.keys(o).length === keys.length
    && Object.keys(o).every((k, i) => k === keys[i]));
}

function indent(n) { return '  '.repeat(n); }

function toonValue(v, depth) {
  if (Array.isArray(v)) return toonArray(v, depth);
  if (v && typeof v === 'object') return toonObject(v, depth);
  return toonScalar(v);
}

function toonObject(obj, depth) {
  const keys = Object.keys(obj);
  if (!keys.length) return '{}';
  const lines = [];
  for (const k of keys) {
    const v = obj[k];
    const key = toonScalar(k); // le key sono identifer di solito, ma safe
    if (v && typeof v === 'object') {
      lines.push(`${indent(depth)}${key}:`);
      lines.push(toonValue(v, depth + 1));
    } else {
      lines.push(`${indent(depth)}${key}: ${toonScalar(v)}`);
    }
  }
  return lines.join('\n');
}

function toonArray(arr, depth) {
  if (arr.length === 0) return `${indent(depth)}[]`;
  if (isUniformObjectArray(arr)) {
    const fields = Object.keys(arr[0]);
    const header = `${indent(depth)}${''}items[${arr.length}]{${fields.join(',')}}:`;
    // Nota: la chiave del contenitore viene prefissata dal chiamante.
    // Qui assumiamo che il chiamante abbia già scritto `key:`; emettiamo solo le
    // righe. Per semplicità questo path è gestito in toonFieldArray.
    const rows = arr.map((o) => indent(depth + 1) + fields.map((f) => toonCell(o[f])).join(TOON_DELIM));
    return [header, ...rows].join('\n');
  }
  // array di primitive → inline
  if (arr.every((v) => v === null || typeof v !== 'object')) {
    return `${indent(depth)}[${arr.length}]: ${arr.map(toonScalar).join(', ')}`;
  }
  // list form (misto/oggetti non uniformi)
  return arr.map((v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v);
      if (!entries.length) return `${indent(depth)}- {}`;
      const [k0, v0] = entries[0];
      const first = `${indent(depth)}- ${toonScalar(k0)}: ${Array.isArray(v0) || (v0 && typeof v0 === 'object') ? '' : toonScalar(v0)}`;
      const rest = entries.slice(1).map(([k, vv]) => {
        if (vv && typeof vv === 'object') {
          return `${indent(depth + 1)}${toonScalar(k)}:\n${toonValue(vv, depth + 2)}`;
        }
        return `${indent(depth + 1)}${toonScalar(k)}: ${toonScalar(vv)}`;
      });
      let firstLine = first;
      if (v0 && typeof v0 === 'object') {
        firstLine = `${indent(depth)}- ${toonScalar(k0)}:\n${toonValue(v0, depth + 2)}`;
      }
      return [firstLine, ...rest].join('\n');
    }
    return `${indent(depth)}- ${toonScalar(v)}`;
  }).join('\n');
}

// Emette un campo array annidato sotto una key, gestendo il path tabulare
// con la key nell'header (key[N]{fields}:). È la forma usata nei nostri output.
function toonFieldArray(key, arr, depth) {
  if (!Array.isArray(arr)) {
    return `${indent(depth)}${toonScalar(key)}: ${toonScalar(arr)}`;
  }
  if (arr.length === 0) return `${indent(depth)}${toonScalar(key)}[0]:`;
  if (isUniformObjectArray(arr)) {
    const fields = Object.keys(arr[0]);
    const header = `${indent(depth)}${toonScalar(key)}[${arr.length}]{${fields.join(',')}}:`;
    const rows = arr.map((o) => indent(depth + 1) + fields.map((f) => toonCell(o[f])).join(TOON_DELIM));
    return [header, ...rows].join('\n');
  }
  // array di primitive
  if (arr.every((v) => v === null || typeof v !== 'object')) {
    return `${indent(depth)}${toonScalar(key)}[${arr.length}]: ${arr.map(toonScalar).join(', ')}`;
  }
  // list form con key
  return `${indent(depth)}${toonScalar(key)}[${arr.length}]:\n` + toonArray(arr, depth + 1);
}

// Serializza un oggetto root in TOON, gestendo i campi array con toonFieldArray.
function toon(obj) {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      lines.push(toonFieldArray(k, v, 0));
    } else if (v && typeof v === 'object') {
      lines.push(`${toonScalar(k)}:`);
      lines.push(toonObject(v, 1));
    } else {
      lines.push(`${toonScalar(k)}: ${toonScalar(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  toon,
  toonScalar,
  toonCell,
  quoteString,
  needsQuote,
  isUniformObjectArray,
  TOON_DELIM,
};
