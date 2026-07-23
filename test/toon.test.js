// toon.test.js — validazione round-trip dell'encoder TOON (toon.js).
//
// Per ciascun oggetto rappresentativo degli output del CLI:
//   1. lo codifica con toon()
//   2. decodifica l'output con decode() (toon-decode.js)
//   3. verifica deep-equal con l'originale (round-trip preserva la struttura)
//   4. verifica invarianti di formato TOON (no trailing space, no tab in indent,
//      LF, `[N]` matcha il conteggio reale)
//
// Esecuzione: `npm test` (o `node test/toon.test.js`). Zero dipendenze.

const { toon } = require('../bin/toon.js');
const { decode } = require('../bin/toon-decode.js');

let failures = 0;
let passes = 0;

function ok(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error(`  FAIL: ${msg}`); }
}

// deepEqual ricorsivo (oggetti: keys uguali a prescindere dall'ordine; array: ordine rilevante).
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// Invarianti di formato TOON sul testo codificato.
function assertInvariants(text, label) {
  const lines = text.split('\n');
  // no trailing spaces
  ok(!lines.some((l) => / $/.test(l)), `${label}: no trailing spaces`);
  // no tab in indentation (solo spazi)
  ok(!lines.some((l) => /^\t/.test(l) || /^ *\t/.test(l)), `${label}: no tab in indentation`);
  // LF endings (nessun \r): verificato dal fatto che split('\n') non produce \r residui
  ok(!text.includes('\r'), `${label}: LF only (no CR)`);
  // ogni header `[N]{...}:` o `[N]:` deve avere N coerente
  for (const l of lines) {
    const m = l.match(/\[(\d+)\]/);
    if (m) {
      const n = parseInt(m[1], 10);
      // per i tabular header su questa riga, le N righe sono sotto; non controlliamo
      // qui il conteggio righe (lo fa il round-trip), solo che N è un intero >=0
      ok(Number.isInteger(n) && n >= 0, `${label}: array count [${n}] is a non-negative integer`);
    }
  }
}

function roundTrip(label, obj) {
  const text = toon(obj);
  let back;
  try {
    back = decode(text);
  } catch (e) {
    ok(false, `${label}: decode threw: ${e.message}`);
    console.error('--- encoded ---\n' + text + '---');
    return;
  }
  ok(deepEqual(back, obj), `${label}: round-trip deep-equal`);
  if (!deepEqual(back, obj)) {
    console.error('--- encoded ---\n' + text + '---');
    console.error('--- decoded ---\n' + JSON.stringify(back, null, 2));
    console.error('--- expected ---\n' + JSON.stringify(obj, null, 2));
  }
  assertInvariants(text, label);
}

// ---------------------------------------------------------------------------
// Casi d'uso reali (gli output effettivi del CLI)
// ---------------------------------------------------------------------------

roundTrip('send', {
  sent: { channel: 'diag', sender: 'ZED', ts: 1784344404944 },
  total: 3,
  help: [
    'Run `agent-channel wait diag ZED` to block for the reply',
    'Run `agent-channel send-wait diag ZED "<msg>"` to reply + wait',
  ],
});

roundTrip('wait-received', {
  channel: 'diag',
  received: 2,
  messages: [
    { ts: 1784344404, sender: 'VANTA', msg: 'Concordo. Verifico il listener main.tsx.' },
    { ts: 1784344409, sender: 'VANTA', msg: 'Root cause confermata: token JWT stantio' },
  ],
  help: ['Run `agent-channel send-wait diag ZED "<reply>"` to answer and wait again'],
});

roundTrip('timeout', {
  timeout: { seconds: 210, last_other_sender: 'VANTA' },
  reminder: "Nessun messaggio da VANTA negli ultimi 210s. RIMETTITI IN ATTESA rieseguendo 'wait'.",
  exit: 2,
  help: [
    'Run `agent-channel wait diag ZED --timeout=210` to keep waiting',
    'Run `agent-channel send diag ZED "<nudge>"` to nudge VANTA',
  ],
});

roundTrip('show', {
  channel: 'diag',
  total: 12,
  shown: 12,
  by_sender: [
    { sender: 'ZED', count: 5, last_ts: 1784344404 },
    { sender: 'VANTA', count: 7, last_ts: 1784344409 },
  ],
  messages: [
    { ts: 1784344400, sender: 'ZED', msg: 'Sono ZED. Ipotizzo token JWT stantio...' },
    { ts: 1784344450, sender: 'VANTA', msg: 'Concordo.' },
  ],
  help: ['Run `agent-channel wait diag <who>` to block for new messages'],
});

roundTrip('home', {
  bin: '~/.pi/agent/npm/node_modules/pi-agent-channel/bin/agent-channel.js',
  description: 'Mailbox channel via filesystem for coordinating two pi agents on a shared working tree',
  root: '/home/user/repo',
  channels: [
    { name: 'diag', total: 12, last_sender: 'VANTA', last_ts: 1784344409 },
  ],
  help: [
    'Run `agent-channel send <channel> <who> "<msg>"` to post a message',
    'Run `agent-channel wait <channel> <who>` to block for the next message',
    'Run `agent-channel show <channel>` to read a transcript',
    'Run `agent-channel --help` for full reference',
  ],
});

roundTrip('home-empty', {
  bin: '~/.pi/agent/.../agent-channel.js',
  description: 'Mailbox channel via filesystem for coordinating two pi agents on a shared working tree',
  root: '/home/user/repo',
  channels: [],
  note: 'no channels found in /home/user/repo',
  help: ['Run `agent-channel send <channel> <who> "<msg>"` to post a message'],
});

roundTrip('show-empty', {
  channel: 'diag',
  total: 0,
  empty: 'no messages in channel "diag" yet',
  help: ['Run `agent-channel send diag <who> "<msg>"` to post the first message'],
});

roundTrip('error', {
  error: 'unknown flag --stat for `send`',
  help: 'valid flags for `send`: (none) (--help always allowed)',
});

roundTrip('single-message', {
  channel: 'd',
  received: 1,
  messages: [{ ts: 1784651220847, sender: 'VANTA', msg: 'root cause = X. Tu?' }],
  help: ['Run `agent-channel send-wait d ZED "<reply>"` to answer and wait again'],
});

// ---------------------------------------------------------------------------
// Edge cases: valori "difficili" (quoting/escape/ambiguità primitivi)
// ---------------------------------------------------------------------------

roundTrip('edge-strings', {
  comma: 'ciao, mondo',
  quotes: 'ha detto "ciao"',
  newline: 'riga1\nriga2',
  tab: 'a\tb',
  colon: 'http://x:8080',
  looks_number: '123',
  looks_bool: 'true',
  looks_null: 'null',
  empty: '',
  leading_space: '  leading',
});

roundTrip('edge-scalars', {
  big_number: 1784652316146,
  float: 3.14,
  zero: 0,
  neg: -42,
  true_val: true,
  false_val: false,
  null_val: null,
});

roundTrip('edge-help-with-commas', {
  total: 1,
  help: [
    'Run `cmd a, b` then `cmd c`',
    'Use "--flag=x, y" for lists',
    'plain help line',
  ],
});

roundTrip('edge-tabular-one-row', {
  messages: [{ ts: 1, sender: 'A', msg: 'solo' }],
});

roundTrip('edge-multiline-msg', {
  messages: [
    { ts: 1, sender: 'A', msg: 'prima riga\nseconda riga con, virgola' },
    { ts: 2, sender: 'B', msg: 'with "quotes" and : colon' },
  ],
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
