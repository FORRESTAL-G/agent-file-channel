// toon-decode.js — decoder TOON minimale, companion di ./toon.js.
//
// Parsa il subset TOON emesso dal CLI (e dall'encoder toon.js) e lo ricostruisce
// in valore JS. Usato dai test di round-trip (test/toon.test.js) per validare
// che encode → decode preservi la struttura originale.
//
// Supporta:
//   - oggetti: `key: value` (scalare) e `key:` + blocco annidato a indent+2
//   - array tabulari: `key[N]{f1,f2}:` + N righe a indent+2, delimiter `,`
//   - array inline di primitive: `key[N]: a, b, c`
//   - array vuoti: `key[0]:`
//   - scalari: number / true / false / null / stringa quoted (con escape) o unquoted
//
// Quoting/escape coerenti con toon.js (escape `\ " \n \r \t`). Il delimiter è `,`
// e viene rispettato dentro le quoted stringhe. Zero dipendenze.

function unquote(s) {
  // s inizia e finisce con `"`; ricostruisce la stringa applicando gli escape.
  const body = s.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) {
      const n = body[++i];
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === '"') out += '"';
      else if (n === '\\') out += '\\';
      else out += n; // tollerante: escape sconosciuto → carattere letterale
    } else {
      out += c;
    }
  }
  return out;
}

// Tipizza un token scalare (una cella o un value dopo `:`).
function parseScalar(tok) {
  tok = tok.trim();
  if (tok === '') return '';
  if (tok.startsWith('"')) return unquote(tok);
  if (tok === 'true') return true;
  if (tok === 'false') return false;
  if (tok === 'null') return null;
  if (/^-?\d+$/.test(tok)) return parseInt(tok, 10);
  if (/^-?\d+\.\d+$/.test(tok)) return parseFloat(tok);
  return tok; // stringa unquoted (non ambigua: l'encoder quota tutto ciò che lo è)
}

// Split di una riga su delimiter `,` rispettando le quoted stringhe e gli escape.
function splitDelim(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && inQ && i + 1 < line.length) { cur += c + line[++i]; continue; }
    if (c === '"') { inQ = !inQ; cur += c; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function leadingIndent(line) {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
}

// Trova il primo `:` fuori da quote → separa key dal resto.
function splitKeyColon(body) {
  let inQ = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && inQ && i + 1 < body.length) { i++; continue; }
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ':' && !inQ) return { key: body.slice(0, i), rest: body.slice(i + 1) };
  }
  return null;
}

// Normalizza una key: trim; se quoted → unquote.
function cleanKey(k) {
  k = k.trim();
  if (k.startsWith('"')) return unquote(k);
  return k;
}

// parseObject: legge righe a indent === ind, costruendo un oggetto.
// Ritorna { value, next } dove next è l'indice della prima riga fuori blocco.
function parseObject(lines, i, ind) {
  const obj = {};
  let idx = i;
  while (idx < lines.length) {
    const line = lines[idx];
    const li = leadingIndent(line);
    if (li < ind) break; // fine del blocco corrente
    if (li > ind) { idx++; continue; } // riga più indentata del previsto: salta (difensivo)
    const body = line.slice(ind);

    // 1) array tabular: `key[N]{f1,f2}:`
    let m = body.match(/^(.*?)\[(\d+)\]\{([^}]*)\}:$/);
    if (m) {
      const key = cleanKey(m[1]);
      const n = parseInt(m[2], 10);
      const fields = m[3].split(',').map((s) => s.trim()).filter(Boolean);
      const rows = [];
      for (let k = 0; k < n; k++) {
        const rline = lines[idx + 1 + k] || '';
        const rbody = rline.replace(/^ +/, ''); // togli indent
        const cells = splitDelim(rbody).map(parseScalar);
        const row = {};
        fields.forEach((f, fi) => { row[f] = cells[fi]; });
        rows.push(row);
      }
      obj[key] = rows;
      idx += 1 + n;
      continue;
    }

    // 2) array inline di primitive (o vuoto): `key[N]: a, b, c` | `key[0]:`
    m = body.match(/^(.*?)\[(\d+)\]:\s?(.*)$/);
    if (m) {
      const key = cleanKey(m[1]);
      const n = parseInt(m[2], 10);
      const rest = m[3].trim();
      if (n === 0 || rest === '') obj[key] = [];
      else obj[key] = splitDelim(rest).map(parseScalar);
      idx++;
      continue;
    }

    // 3) key: value (scalare) | key: (blocco annidato)
    const sc = splitKeyColon(body);
    if (!sc) { idx++; continue; } // riga non riconosciuta: salta (difensivo)
    const key = cleanKey(sc.key);
    const rest = sc.rest.trim();
    if (rest === '') {
      // blocco annidato: oggetto a indent+2 (i nostri blocchi annidati sono oggetti)
      const child = parseObject(lines, idx + 1, ind + 2);
      obj[key] = child.value;
      idx = child.next;
    } else if (rest === '[]') {
      obj[key] = [];
      idx++;
    } else {
      obj[key] = parseScalar(rest);
      idx++;
    }
  }
  return { value: obj, next: idx };
}

// decode(text) → JS object (presuppone root object, come da toon()).
function decode(text) {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0);
  return parseObject(lines, 0, 0).value;
}

module.exports = { decode, parseScalar, splitDelim, unquote };
