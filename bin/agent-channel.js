#!/usr/bin/env node
// agent-channel.js — mailbox channel per coordinare agenti via filesystem.
//
// Primitiva di comunicazione sincronizzata tra 2+ agenti (sessioni separate)
// che condividono un working tree. Lascia un log locale (transcript NDJSON) e
// implementa un semaforo: `wait` BLOCCA il chiamante finché l'altro agente non
// scrive un nuovo messaggio.
//
// Layout (dir di root = cwd o AGENT_CHANNEL_ROOT):
//   .agents/<channel>/transcript.ndjson   log append-only (1 riga JSON per msg)
//   .agents/<channel>/cursor-<who>        (numero riga) fin dove <who> ha letto
//
// Uso:
//   agent-channel.js send      <channel> <who> <msg...>           # scrive, ritorna subito
//   agent-channel.js wait      <channel> <who> [--timeout=300]    # blocca finché nuovo msg
//   agent-channel.js send-wait <channel> <who> <msg...> [--timeout=300]  # send + wait
//   agent-channel.js show      <channel>                          # pretty-print del log
//
// Exit code di wait/send-wait: 0 = messaggio ricevuto, 2 = timeout, >2 = errore.
// Zero dipendenze (node puro). Cross-platform.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT = 210; // secondi (3.5 min). Sotto il cap tipico del tool bash.
// Allo scadere, lo script emette un Reminder Prompt (vedi doWait) che dice
// all'agente di rimettersi in attesa se l'altro è ancora al lavoro.
const POLL_MS = 1000;

function usage() {
  console.error(`agent-channel — mailbox channel via filesystem

Uso:
  agent-channel.js send      <channel> <who> <msg...> [--note=...]
  agent-channel.js wait      <channel> <who> [--timeout=300]
  agent-channel.js send-wait <channel> <who> <msg...> [--timeout=300]
  agent-channel.js show      <channel>

Env:
  AGENT_CHANNEL_ROOT  dir di root (default: cwd). Il transcript va in
                      <root>/.agents/<channel>/

Exit (wait/send-wait): 0 = msg ricevuto, 2 = timeout, >2 = errore.`);
}

function rootDir() {
  return process.env.AGENT_CHANNEL_ROOT || process.cwd();
}

function channelDir(channel) {
  const d = path.join(rootDir(), '.agents', channel);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const transcriptPath = (dir) => path.join(dir, 'transcript.ndjson');
const cursorPath = (dir, who) => path.join(dir, 'cursor-' + sanitize(who));

// sanitize: il nome del partecipante finisce in un nome file
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

function readCursor(p) {
  if (!fs.existsSync(p)) return 0;
  const n = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

function writeCursor(p, n) {
  fs.writeFileSync(p, String(n));
}

function fmtTime(ts) {
  const d = new Date(ts);
  // HH:MM:SS locale
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function prettyLine(raw) {
  try {
    const o = JSON.parse(raw);
    return `[${fmtTime(o.ts)}] ${o.sender}: ${o.msg}`;
  } catch {
    return raw;
  }
}

function parseArgs(args) {
  let timeout = DEFAULT_TIMEOUT;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--timeout=')) {
      timeout = parseInt(a.slice('--timeout='.length), 10);
    } else if (a === '--timeout') {
      timeout = parseInt(args[++i], 10);
    } else {
      positional.push(a);
    }
  }
  if (!Number.isFinite(timeout) || timeout < 0) timeout = DEFAULT_TIMEOUT;
  return { timeout, positional };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ultimo sender != me nel transcript (per capire chi è "l'altro" nel reminder).
function lastOtherSender(dir, me) {
  const lines = readLines(transcriptPath(dir));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      if (o.sender !== me) return o.sender;
    } catch {}
  }
  return null;
}

// Reminder stampato allo scadere del timeout di wait: istruisce l'agente a
// rimettersi in attesa se l'altro è ancora attivo (oppure a sollecitare/proseguire).
function printReminder(dir, me, timeoutSec) {
  const other = lastOtherSender(dir, me) || "un altro partecipante";
  console.log(
    `--- REMINDER (timeout ${timeoutSec}s, nessun nuovo messaggio) ---
` +
    `Nessun messaggio da ${other} negli ultimi ${timeoutSec}s.
` +
    `Se ${other} è ancora al lavoro (sta scrivendo codice / indagando nella sua sessione),
` +
    `RIMETTITI IN ATTESA rieseguendo lo stesso comando 'wait' (o 'send-wait' se vuoi
` +
    `anche scrivere). È normale: il canale è asincrono e l'altro può essere occupato.
` +
    `Solo se ritieni ${other} assente o bloccato: sollecitalo con un 'send', oppure
` +
    `prosegui per conto tuo e torna al canale dopo.
` +
    `---`
  );
}

// wait: blocca finché trova righe nel transcript con sender != me oltre il mio
// cursore. Se ce ne sono già, ritorna subito. Aggiorna il cursore alla fine del
// transcript (così non rilegge i miei né i già-processati).
async function doWait(dir, me, timeoutSec) {
  const cp = cursorPath(dir, me);
  const tp = transcriptPath(dir);
  const start = Date.now();
  const timeoutMs = timeoutSec * 1000;
  let printed = false;
  for (;;) {
    const lines = readLines(tp);
    let cursor = readCursor(cp);
    // se il transcript si è accorciato (reset/manuale), riparti da 0
    if (cursor > lines.length) cursor = 0;
    const newOnes = [];
    for (let i = cursor; i < lines.length; i++) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.sender !== me) newOnes.push(lines[i]);
    }
    if (newOnes.length) {
      for (const raw of newOnes) console.log(prettyLine(raw));
      writeCursor(cp, lines.length);
      printed = true;
      break;
    }
    if (Date.now() - start >= timeoutMs) break;
    await sleep(POLL_MS);
  }
  if (!printed) printReminder(dir, me, timeoutSec);
  return printed ? 0 : 2;
}

function doShow(dir) {
  const lines = readLines(transcriptPath(dir));
  for (const l of lines) console.log(prettyLine(l));
  return 0;
}

async function main() {
  const [cmd, channel, who, ...rest] = process.argv.slice(2);
  if (!cmd || !channel) { usage(); return 1; }
  if (cmd === 'show') {
    return doShow(channelDir(channel));
  }
  if (!who) { usage(); return 1; }
  const { timeout, positional } = parseArgs(rest);
  const dir = channelDir(channel);
  const msg = positional.join(' ').trim();

  switch (cmd) {
    case 'send':
      if (!msg) { console.error('send: messaggio vuoto'); return 3; }
      appendMessage(dir, who, msg);
      return 0;
    case 'wait':
      return await doWait(dir, who, timeout);
    case 'send-wait':
    case 'reply':
      if (!msg) { console.error('send-wait: messaggio vuoto'); return 3; }
      appendMessage(dir, who, msg);
      return await doWait(dir, who, timeout);
    default:
      usage();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('agent-channel error:', e && e.message ? e.message : e);
    process.exit(4);
  });
