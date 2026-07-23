#!/usr/bin/env node
// agent-channel.js — mailbox channel per coordinare agenti via filesystem.
//
// Primitiva di comunicazione sincronizzata tra 2+ agenti (sessioni separate)
// che condividono un working tree. Lascia un log locale (transcript NDJSON) e
// implementa un semaforo: `wait` BLOCCA il chiamante finché l'altro agente non
// scrive un nuovo messaggio.
//
// CLI conforme AXI (Agent eXperience Interface):
//   - output strutturato in TOON (Token-Oriented Object Notation) su stdout
//   - content-first: nessun argomento mostra lo stato live (canali attivi)
//   - errori strutturati su stdout (mai su stderr), exit code allineati
//   - fail-loud su flag/argomenti non riconosciuti
//   - `--help` globale e per subcommand
//   - disclosure contestuale (help[] con i prossimi passi logici)
//
// Layout (dir di root = cwd o AGENT_CHANNEL_ROOT):
//   .agents/<channel>/transcript.ndjson   log append-only (1 riga JSON per msg)
//   .agents/<channel>/cursor-<who>        (numero riga) fin dove <who> ha letto
//
// Uso:
//   agent-channel.js                                  # home: stato live dei canali
//   agent-channel.js send      <channel> <who> <msg...>           # scrive, ritorna subito
//   agent-channel.js wait      <channel> <who> [--timeout=300]    # blocca finché nuovo msg
//   agent-channel.js send-wait <channel> <who> <msg...> [--timeout=300]  # send + wait
//   agent-channel.js show      <channel> [--limit=50] [--full]    # transcript (TOON)
//
// Exit code:
//   0 = successo (incluse no-op, es. send a canale esistente)
//   1 = errore interno (I/O, eccezione)
//   2 = usage error (argomenti/flag errati) — E timeout di wait/send-wait (contratto)
//      Nota: l'exit 2 per il timeout è un'eccezione documentata ad AXI §6
//      (dove 2=usage error): il timeout è "nessun evento", ma l'exit 2 è il
//      contratto che il prompt `multi-agent-file-channel` e l'extension
//      `agent_channel` usano per distinguere "nessun messaggio" dal successo.
//
// Zero dipendenze (node puro). Cross-platform. Encoder TOON inline.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT = 210; // secondi (3.5 min). Sotto il cap tipico del tool bash.
const POLL_MS = 1000;
const MSG_PREVIEW = 500; // truncation di default per `msg` in show (caratteri)

// Encoder TOON: modulo condiviso con i test di validazione (vedi ./toon.js
// e ./toon-decode.js). Round-trip verificato da `npm test`.
const { toon } = require('./toon.js');

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

// Override esplicito della root (--root=<path> oppure env AGENT_CHANNEL_ROOT).
// Permette a due agenti in cwd DIVERSE di condividere lo stesso transcript:
// entrambi puntano alla stessa root (tipicamente il genitore comune dei loro
// repo). Senza --root, la root è AGENT_CHANNEL_ROOT o la cwd della sessione.
let ROOT_OVERRIDE = null;

function rootDir() {
  if (ROOT_OVERRIDE) return ROOT_OVERRIDE;
  return process.env.AGENT_CHANNEL_ROOT || process.cwd();
}

// Rimuove `--root=<path>` da argv (flag globale, trasversale a ogni subcommand e
// alla home) e ne registra il valore. AXI: la root è un'opzione esplicita, non
// un'assunzione sulla cwd della sessione — così il tool nativo basta da solo
// anche per agenti in working tree diversi.
function stripRoot(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--root=')) { ROOT_OVERRIDE = a.slice('--root='.length); continue; }
    out.push(a);
  }
  return out;
}

function channelDir(channel) {
  const d = path.join(rootDir(), '.agents', channel);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function listChannelDirs() {
  const base = path.join(rootDir(), '.agents');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

const transcriptPath = (dir) => path.join(dir, 'transcript.ndjson');
const cursorPath = (dir, who) => path.join(dir, 'cursor-' + sanitize(who));

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function appendMessage(dir, sender, msg) {
  const line = JSON.stringify({ sender, ts: Date.now(), msg }) + '\n';
  // appendFileSync: su POSIX, scritture O_APPEND di righe piccole (< PIPE_BUF)
  // sono atomiche. Accettabile per il nostro uso (messaggi brevi).
  fs.appendFileSync(transcriptPath(dir), line);
}

function readLines(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length);
}

function parseTranscriptLine(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function readTranscript(dir) {
  return readLines(transcriptPath(dir)).map(parseTranscriptLine).filter(Boolean);
}

function readCursor(p) {
  if (!fs.existsSync(p)) return 0;
  const n = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

function writeCursor(p, n) {
  fs.writeFileSync(p, String(n));
}

function truncateMsg(msg, limit) {
  if (typeof msg !== 'string') msg = String(msg);
  if (msg.length <= limit) return msg;
  return msg.slice(0, limit) + `... (truncated, ${msg.length} chars total; use --full)`;
}

// ---------------------------------------------------------------------------
// Output helpers (TOON su stdout; stderr solo per diagnostica interna)
// ---------------------------------------------------------------------------

function emit(obj) {
  process.stdout.write(toon(obj));
}

function emitError(message, help) {
  const obj = { error: message };
  if (help) obj.help = help;
  process.stdout.write(toon(obj));
}

// help[] inline è un array di primitive (righe di testo) → forma inline.
// Per avere una riga per elemento usiamo la list form via toonFieldArray(list).
// AXI §9: ogni suggerimento è un comando completo (o template).
function helpLines(lines) {
  return lines;
}

// ---------------------------------------------------------------------------
// Comandi
// ---------------------------------------------------------------------------

// Home / content-first: nessun argomento → stato live dei canali.
function doHome() {
  const bin = process.argv[1] || 'agent-channel';
  const names = listChannelDirs();
  const channels = names.map((name) => {
    const dir = path.join(rootDir(), '.agents', name);
    const msgs = readTranscript(dir);
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    return {
      name,
      total: msgs.length,
      last_sender: last ? last.sender : null,
      last_ts: last ? last.ts : null,
    };
  });
  const obj = {
    bin: collapseHome(bin),
    description: 'Mailbox channel via filesystem for coordinating two pi agents on a shared working tree',
    root: rootDir(),
    channels,
  };
  if (!channels.length) obj.note = `no channels found in ${rootDir()}`;
  obj.help = helpLines([
    `Run \`agent-channel send <channel> <who> "<msg>"\` to post a message`,
    `Run \`agent-channel wait <channel> <who>\` to block for the next message`,
    `Run \`agent-channel send-wait <channel> <who> "<msg>"\` to reply + wait`,
    `Run \`agent-channel show <channel>\` to read a transcript`,
    `Run \`agent-channel --help\` for full reference`,
  ]);
  emit(obj);
  return 0;
}

function collapseHome(p) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home && p && p.startsWith(home)) return '~' + p.slice(home.length).replace(/\\/g, '/');
  return p ? p.replace(/\\/g, '/') : 'agent-channel';
}

// send: scrive il messaggio, ritorna subito. Idempotente (nessun errore se il
// canale esiste già — lo crea). Conferma TOON + hint al prossimo passo logico.
function doSend(channel, who, msg) {
  const dir = channelDir(channel);
  appendMessage(dir, who, msg);
  const msgs = readTranscript(dir);
  const obj = {
    sent: {
      channel,
      sender: who,
      ts: msgs[msgs.length - 1].ts,
    },
    total: msgs.length,
  };
  obj.help = helpLines([
    `Run \`agent-channel wait ${channel} ${who}\` to block for the reply`,
    `Run \`agent-channel send-wait ${channel} ${who} "<msg>"\` to reply + wait`,
  ]);
  emit(obj);
  return 0;
}

// show: transcript in TOON con aggregati + truncation + limit + --fields.
function doShow(channel, opts) {
  const all = readTranscript(channelDir(channel));
  if (!all.length) {
    const obj = {
      channel,
      total: 0,
      empty: `no messages in channel "${channel}" yet`,
    };
    obj.help = helpLines([
      `Run \`agent-channel send ${channel} <who> "<msg>"\` to post the first message`,
    ]);
    emit(obj);
    return 0;
  }
  // Validazione --fields
  const VALID_FIELDS = new Set(['ts', 'sender', 'msg']);
  const fieldList = opts.fields
    ? String(opts.fields).split(',').map((s) => s.trim()).filter(Boolean)
    : ['ts', 'sender', 'msg'];
  const bad = fieldList.filter((f) => !VALID_FIELDS.has(f));
  if (bad.length) {
    emitError(
      `unknown field(s) ${bad.map((b) => '--fields=' + b).join(', ')}`,
      `valid fields: ${[...VALID_FIELDS].join(', ')}`,
    );
    return 2;
  }

  // aggregati by_sender
  const byMap = new Map();
  for (const m of all) {
    const e = byMap.get(m.sender) || { sender: m.sender, count: 0, last_ts: 0 };
    e.count += 1;
    if (m.ts > e.last_ts) e.last_ts = m.ts;
    byMap.set(m.sender, e);
  }
  const bySender = [...byMap.values()].sort((a, b) => b.count - a.count);

  let msgs = all;
  const limited = opts.limit && opts.limit > 0 && all.length > opts.limit;
  if (limited) msgs = all.slice(all.length - opts.limit);
  const out = msgs.map((m) => {
    const o = {};
    for (const k of fieldList) {
      if (k === 'msg') o.msg = opts.full ? m.msg : truncateMsg(m.msg, MSG_PREVIEW);
      else o[k] = m[k];
    }
    return o;
  });

  const obj = {
    channel,
    total: all.length,
    shown: msgs.length,
    by_sender: bySender,
    messages: out,
  };
  const hints = [
    `Run \`agent-channel wait ${channel} <who>\` to block for new messages`,
  ];
  if (limited) hints.unshift(`Run \`agent-channel show ${channel}\` (no --limit) to see all ${all.length} messages`);
  if (!opts.full && all.some((m) => typeof m.msg === 'string' && m.msg.length > MSG_PREVIEW)) {
    hints.push(`Run \`agent-channel show ${channel} --full\` for untruncated messages`);
  }
  obj.help = helpLines(hints);
  emit(obj);
  return 0;
}

// Help globale e per-subcommand. Formato TOON leggero + testo leggibile.
function doHelp(sub) {
  if (!sub) {
    emit({
      bin: collapseHome(process.argv[1] || 'agent-channel'),
      description: 'Mailbox channel via filesystem for coordinating two pi agents on a shared working tree',
      usage: [
        'agent-channel [--root=<path>]',
        'agent-channel send <channel> <who> <msg...> [--root=<path>]',
        'agent-channel wait <channel> <who> [--timeout=300] [--root=<path>]',
        'agent-channel send-wait <channel> <who> <msg...> [--timeout=300] [--root=<path>]',
        'agent-channel show <channel> [--limit=50] [--full] [--fields=ts,sender,msg] [--root=<path>]',
        'agent-channel --help [send|wait|send-wait|show]',
      ],
      global_flags: { '--root=<path>': 'root condivisa del canale (default: AGENT_CHANNEL_ROOT o cwd); il transcript va in <root>/.agents/<channel>/', '--help': 'questo help (o help di un subcommand)' },
      env: { AGENT_CHANNEL_ROOT: 'override della root (stesso effetto di --root)' },
      exit_codes: { '0': 'success (incl. no-op)', '1': 'error', '2': 'usage error — oppure timeout di wait/send-wait (contratto)' },
    });
    return 0;
  }
  const refs = {
    send: {
      args: '<channel> <who> <msg...>',
      flags: { '--help': 'questo help' },
      exit: '0',
      example: 'agent-channel send diag ZED "Ipotizzo token JWT stantio"',
    },
    wait: {
      args: '<channel> <who>',
      flags: { '--timeout=N': `secondi (default ${DEFAULT_TIMEOUT})`, '--help': 'questo help' },
      exit: '0 = msg ricevuto, 2 = timeout',
      example: 'agent-channel wait diag ZED --timeout=300',
    },
    'send-wait': {
      args: '<channel> <who> <msg...>',
      flags: { '--timeout=N': `secondi (default ${DEFAULT_TIMEOUT})`, '--help': 'questo help' },
      exit: '0 = msg ricevuto, 2 = timeout',
      example: 'agent-channel send-wait diag ZED "root cause = X. Tu?" --timeout=210',
    },
    show: {
      args: '<channel>',
      flags: {
        '--limit=N': 'ultimi N messaggi (0 = tutti; default: tutti)',
        '--full': 'non troncare i messaggi (default: preview 500 char)',
        '--fields=a,b': 'campi extra nel tabular (default: ts,sender,msg)',
        '--help': 'questo help',
      },
      exit: '0',
      example: 'agent-channel show diag --limit=20',
    },
  };
  const ref = refs[sub];
  if (!ref) {
    emitError(`unknown subcommand "${sub}" for --help`, 'valid: send, wait, send-wait, show');
    return 2;
  }
  emit({ command: sub, ...ref });
  return 0;
}

// ---------------------------------------------------------------------------
// Arg parsing (fail-loud su flag sconosciute; --help sempre ammessa)
// ---------------------------------------------------------------------------

const GLOBAL_FLAGS = new Set(['--help', '-h']);

// Definizione dei flag validi per subcommand.
const SUB_FLAGS = {
  send: new Set([]),
  wait: new Set(['--timeout']),
  'send-wait': new Set(['--timeout']),
  show: new Set(['--limit', '--full', '--fields']),
};

function parseFlags(args, allowed, sub) {
  // allowed: Set di flag validi per questo subcommand (senza GLOBAL_FLAGS).
  const out = { _positional: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { out._help = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      const isKnown = GLOBAL_FLAGS.has(name) || allowed.has(name);
      if (!isKnown) {
        const valid = [...allowed].sort();
        emitError(
          `unknown flag ${name} for \`${sub || 'agent-channel'}\``,
          `valid flags for \`${sub || 'agent-channel'}\`: ${valid.length ? valid.join(', ') : '(none)'} (--help always allowed)`,
        );
        return { _usageError: true, exit: 2 };
      }
      if (name === '--full') {
        out.flags.full = true;
      } else if (eq >= 0) {
        out.flags[name.slice(2)] = a.slice(eq + 1);
      } else if (allowed.has(name)) {
        // flag con valore separato
        const val = args[++i];
        out.flags[name.slice(2)] = val;
      } else {
        out.flags[name.slice(2)] = true;
      }
    } else {
      out._positional.push(a);
    }
  }
  return out;
}

function parseTimeout(raw, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastOtherSender(dir, me) {
  const msgs = readTranscript(dir);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].sender !== me) return msgs[i].sender;
  }
  return null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  // --root=<path> è una flag globale: estratta prima del dispatch (vale per ogni
  // subcommand e per la home). Permette di condividere la root tra agenti in cwd
  // diverse (vedi prompt multi-agent-file-channel, sez. coordinamento cross-cwd).
  const argv = stripRoot(process.argv.slice(2));

  // --help senza subcommand → help globale
  if (!argv.length) return doHome();

  // help globale esplicito in testa
  if (argv[0] === '--help' || argv[0] === '-h') {
    return doHelp(argv[1]);
  }
  if (argv[0] === 'help') {
    return doHelp(argv[1]);
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!SUB_FLAGS[cmd]) {
    emitError(
      `unknown command "${cmd}"`,
      'valid commands: send, wait, send-wait, show. Run `agent-channel --help` for reference.',
    );
    return 2;
  }

  const parsed = parseFlags(rest, SUB_FLAGS[cmd], cmd);
  if (parsed._usageError) return parsed.exit;
  if (parsed._help) return doHelp(cmd);

  const pos = parsed._positional;
  const f = parsed.flags;

  switch (cmd) {
    case 'send':
    case 'send-wait': {
      if (pos.length < 2) {
        emitError(
          `${cmd} requires <channel> <who> <msg...>`,
          `example: agent-channel ${cmd} diag ZED "root cause = X. Tu?"`,
        );
        return 2;
      }
      const [channel, who, ...msgParts] = pos;
      const msg = msgParts.join(' ').trim();
      if (!msg) {
        emitError(
          `${cmd}: message is empty`,
          `example: agent-channel ${cmd} ${channel} ${who} "<your message>"`,
        );
        return 2;
      }
      if (cmd === 'send') return doSend(channel, who, msg);
      // send-wait: send poi wait (con timeout opzionale)
      const timeout = f.timeout != null ? parseTimeout(f.timeout, DEFAULT_TIMEOUT) : DEFAULT_TIMEOUT;
      const dir = channelDir(channel);
      appendMessage(dir, who, msg);
      return await doWaitFrom(channel, who, timeout, dir, true);
    }
    case 'wait': {
      if (pos.length < 2) {
        emitError(
          'wait requires <channel> <who>',
          'example: agent-channel wait diag ZED --timeout=300',
        );
        return 2;
      }
      const [channel, who] = pos;
      const timeout = f.timeout != null ? parseTimeout(f.timeout, DEFAULT_TIMEOUT) : DEFAULT_TIMEOUT;
      return await doWaitFrom(channel, who, timeout, channelDir(channel), false);
    }
    case 'show': {
      if (pos.length < 1) {
        emitError(
          'show requires <channel>',
          'example: agent-channel show diag',
        );
        return 2;
      }
      const [channel] = pos;
      const limitRaw = f.limit != null ? f.limit : '0';
      const limit = parseTimeout(limitRaw, 0); // riuso parseInt (>0 o 0=tutti)
      const full = !!f.full;
      return doShow(channel, { limit, full, fields: f.fields });
    }
    default:
      return 2;
  }
}

// wait centralizzato (usato da wait e send-wait). `justSent` true se abbiamo
// appena scritto (send-wait): in quel caso i messaggi ricevuti non includono
// mai il nostro (sender === who) — già gestito da doWaitFrom stesso.
async function doWaitFrom(channel, who, timeoutSec, dir, justSent) {
  const cp = cursorPath(dir, who);
  const tp = transcriptPath(dir);
  const start = Date.now();
  const timeoutMs = timeoutSec * 1000;
  let received = [];
  for (;;) {
    const lines = readLines(tp);
    let cursor = readCursor(cp);
    if (cursor > lines.length) cursor = 0;
    for (let i = cursor; i < lines.length; i++) {
      const o = parseTranscriptLine(lines[i]);
      if (!o || o.sender === who) continue;
      received.push({ ts: o.ts, sender: o.sender, msg: o.msg });
    }
    if (received.length) {
      // porta il cursore alla fine solo delle righe effettivamente lette
      writeCursor(cp, lines.length);
      break;
    }
    if (Date.now() - start >= timeoutMs) break;
    await sleep(POLL_MS);
  }
  if (received.length) {
    const obj = {
      channel,
      received: received.length,
      messages: received,
    };
    obj.help = helpLines([
      `Run \`agent-channel send-wait ${channel} ${who} "<reply>"\` to answer and wait again`,
    ]);
    emit(obj);
    return 0;
  }
  const other = lastOtherSender(dir, who) || 'un altro partecipante';
  const obj = {
    timeout: {
      seconds: timeoutSec,
      last_other_sender: other,
    },
    reminder: `Nessun messaggio da ${other} negli ultimi ${timeoutSec}s. Se ${other} è ancora al lavoro, RIMETTITI IN ATTESA rieseguendo 'wait' (o 'send-wait' se vuoi anche scrivere). Solo se ritieni ${other} assente o bloccato: sollecitalo con un 'send', oppure prosegui per conto tuo e torna al canale dopo.`,
    exit: 2,
  };
  obj.help = helpLines([
    `Run \`agent-channel wait ${channel} ${who} --timeout=${timeoutSec}\` to keep waiting`,
    `Run \`agent-channel send ${channel} ${who} "<nudge>"\` to nudge ${other}`,
  ]);
  emit(obj);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // Errore interno: strutturato su stdout, exit 1 (AXI §6).
    emitError(
      'internal error: ' + (e && e.message ? e.message : String(e)),
      'check filesystem permissions under <root>/.agents/ or set AGENT_CHANNEL_ROOT',
    );
    process.exit(1);
  });
