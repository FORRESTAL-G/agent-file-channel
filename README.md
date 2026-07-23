# README — Multi-Agent File Channel

Mailbox channel via filesystem per mettere in comunicazione **due o più agenti**
(sessioni separate) che devono coordinarsi su un task condiviso, senza vedere lo
schermo l'uno dell'altro. Lo script fa da **semaforo bloccante** e lascia un
**log locale leggibile**. Pensato per agenti nello stesso working tree / repo.

> Documento di riferimento per la cura e il versioning della soluzione.
> Ultimo aggiornamento: 21/07/2026.

Il CLI `agent-channel.js` è conforme **AXI** (Agent eXperience Interface):
output in [TOON](https://toonformat.dev/), home *content-first*, errori
strutturati su stdout, fail-loud su flag/argomenti sconosciuti, `--help`
globale e per subcommand, disclosure contestuale (`help[]` con i prossimi
passi). Vedi §10 per il dettaglio della conformità.

---

## 1. Dove stanno i file

Il package è ora **versionabile come unità** — tutti i file vivono insieme nel
repo del package `pi-agent-channel`:

```
pi-agent-channel/
├── package.json              # name, keywords:[pi-package], pi: {extensions, prompts}, bin
├── README.md                 # questo file
├── bin/
│   └── agent-channel.js      # la primitiva (single source of truth della logica)
├── prompts/
│   └── multi-agent-file-channel.md   # prompt auto-trigger (metodologia)
└── extensions/
    └── agent-channel.ts      # custom tool `agent_channel` (wrapper del bin)
```

### Dopo l'installazione (`pi install`)

Il package viene installato in `~/.pi/agent/npm/node_modules/pi-agent-channel/`.
In **questa posizione** i file live sono:

| File | Percorso (Windows) |
|---|---|
| Script | `C:\Users\<user>\.pi\agent\npm\node_modules\pi-agent-channel\bin\agent-channel.js` |
| Extension (custom tool) | `C:\Users\<user>\.pi\agent\npm\node_modules\pi-agent-channel\extensions\agent-channel.ts` |
| Prompt | `C:\Users\<user>\.pi\agent\npm\node_modules\pi-agent-channel\prompts\multi-agent-file-channel.md` |

Una volta installato:
- il **custom tool `agent_channel`** è disponibile in ogni sessione pi (globale),
  senza PATH: l'agente lo invoca come tool nativo;
- il **prompt** `multi-agent-file-channel` è auto-triggerato nei contesti giusti;
- per **uso shell umano diretto**: si usa il path assoluto del bin (sopra) o ci si
  fa un alias (`agent-channel=node .../bin/agent-channel.js`).

I file **runtime** (uno per sessione, NON da versionare — `.gitignore`):

```
<cwd>/.agents/<channel>/
├─ transcript.ndjson     # log append-only: 1 riga JSON per messaggio
└─ cursor-<who>          # (numero riga) fin dove <who> ha letto
```

La `<cwd>` è la directory da cui l'agente lancia il comando (override via env
`AGENT_CHANNEL_ROOT`). Scegliete un cwd condiviso tra i due agenti (il root della
repo su cui state lavorando).

### Installazione

```bash
# locale (sviluppo):
pi install /path/to/pi-agent-channel
# da git:
pi install git:github.com/<user>/pi-agent-channel
# da npm (se pubblicato):
pi install npm:pi-agent-channel
```

`pi list` mostra i package installati. `pi remove npm:pi-agent-channel` per
disinstallare.

---

## 2. Comandi

Due interfacce equivalenti per la stessa logica (lo script `bin/agent-channel.js`
è la single source of truth; l'extension è un thin wrapper che lo invoca).

### Via custom tool `agent_channel` (dopo `pi install`)

Parametri:

| Param | Type | Required | Note |
|---|---|---|---|
| `action` | `"send"\|"wait"\|"send-wait"\|"show"` | sì | |
| `channel` | string | sì | nome del canale |
| `who` | string | per send/wait/send-wait | tuo nome (maiusc, 3-5 lettere) |
| `msg` | string | per send/send-wait | testo messaggio |
| `timeout` | number | opz (wait/send-wait) | secondi, default 210 |

Ritorno: `content[].text` = stdout strutturato in **TOON** (tabelle
`messages[N]{ts,sender,msg}`, oggetti `sent` / `timeout` / `error`, `help[]`
con i prossimi passi) e `details` con `exitCode` (0 ok · 2 timeout o usage · 1
errore interno) e `status` (`ok` / `timeout` / `usage_error` / `error`).
Esempio:

```
agent_channel({ action: "send-wait", channel: "diag", who: "ZED",
                msg: "root cause = X. Tu?", timeout: 210 })
```

### Via script (shell, uso umano / fallback)

Tutti i comandi hanno forma `node agent-channel.js <cmd> <channel> <who> [...]`.

| Comando | Sintassi | Cosa fa | Exit |
|---|---|---|---|
| `send` | `send <ch> <who> <msg...>` | Scrive il messaggio, **ritorna subito** (= *rispondo e continuo per i fatti miei*) | 0 |
| `wait` | `wait <ch> <who> [--timeout=N]` | **Blocca** finché arriva un msg da un `sender` != `<who>`; lo stampa (pretty), avanza il cursore | 0 = ricevuto · 2 = timeout |
| `send-wait` | `send-wait <ch> <who> <msg...> [--timeout=N]` | **send + wait** in uno (= *rispondo e mi metto in attesa*) | 0 / 2 |
| `show` | `show <ch> [--limit=N] [--full] [--fields=ts,sender,msg]` | Transcript in TOON: `total`, `by_sender[N]{sender,count,last_ts}`, tabella `messages`; `msg` troncato a 500 char (preview) a meno di `--full` | 0 |

`<who>` è il **nome del partecipante** che avete scelto (3-5 lettere maiuscole:
`ZED`, `VANTA`, …). Stesso `<who>` in ogni comando dello stesso agente.

### Flag e env

- `--root=<path>` (flag globale, ogni subcommand + home): dir di root del canale.
  Il transcript va in `<root>/.agents/<channel>/`. **Per agenti in cwd diverse**:
  entrambi puntano alla stessa root (es. il genitore comune dei repo). Vedi §11.
- `--timeout=N` (secondi). **Default 210** (3 minuti e mezzo). Sotto il cap
  tipico del tool bash di un agente, e sopra il tempo medio di risposta.
- `AGENT_CHANNEL_ROOT` (env): stesso effetto di `--root` (override della cwd).

### Output

Tutto lo stdout è **TOON** strutturato (Token-Oriented Object Notation,
~40% più token-efficient del JSON equivalente, leggibile dall'agente).

`wait` / `send-wait` — messaggi ricevuti (exit 0):
```
channel: diag
received: 2
messages[2]{ts,sender,msg}:
  1784344404,VANTA,Concordo. Verifico il listener main.tsx.
  1784344409,VANTA,Root cause confermata: token JWT stantio
help[1]: Run `agent-channel send-wait diag ZED "<reply>"` to answer and wait again
```

`send` — conferma + hint al prossimo passo (exit 0):
```
sent:
  channel: diag
  sender: ZED
  ts: 1784344404
total: 3
help[2]: Run `agent-channel wait diag ZED` to block for the reply, Run `agent-channel send-wait diag ZED "<msg>"` to reply + wait
```

`show` — transcript con aggregati:
```
channel: diag
total: 12
shown: 12
by_sender[2]{sender,count,last_ts}:
  ZED,5,1784344404
  VANTA,7,1784344409
messages[12]{ts,sender,msg}:
  1784344400,ZED,Sono ZED. Ipotizzo token JWT stantio...
  ...
```

Home (nessun argomento) — stato live dei canali, **niente manuale**:
```
bin: ~/.pi/agent/.../agent-channel.js
description: Mailbox channel via filesystem for coordinating two pi agents on a shared working tree
root: /home/user/repo
channels[1]{name,total,last_sender,last_ts}:
  diag,12,VANTA,1784344409
help[5]: Run `agent-channel send ...`, ...
```

> Errori e usage error vanno **sempre su stdout** in forma strutturata
> (`error: ...\nhelp: ...`), mai su stderr (che è solo diagnostica).

---

## 3. Funzionamento interno

### Layout del transcript

Una riga JSON (NDJSON) per messaggio:

```json
{"sender":"ZED","ts":1784344404944,"msg":"root cause confermata: token JWT stantio"}
```

Campi: `sender` (string), `ts` (ms epoch), `msg` (string, qualsiasi lunghezza).

### Semaforo: cursore per-partecipante

Ogni partecipante ha un file `cursor-<who>` con il **numero di riga** del
transcript fin dove ha letto. `wait` legge da quel numero in poi, mostra le righe
con `sender != <who>`, poi porta il cursore alla fine del transcript (così non
rilegge né i propri né i già-processati).

### Polling e blocco

`wait` polla il file ogni **1 secondo** (async, via `setTimeout`). Ritorna subito
se ci sono già messaggi non letti; altrimenti resta bloccato fino al primo msg
nuovo o al timeout.

### Atomicità

`fs.appendFileSync` di una **singola riga** (linea + `\n`) è atomica su POSIX se
la riga è più corta di `PIPE_BUF` (~4KB su Linux). Per messaggi brevi (il caso
normale) due `send` concorrenti non si interlacciano. Su Windows/NTFS la garanzia
è più debole ma in pratica regge per righe piccole. Per messaggi enormi (>4KB)
considera uno split o un lock file — non gestito in questa versione.

### Cursore di un transcript accorciato

Se il transcript viene accorciato manualmente (raro, solo reset), e il cursore è
oltre la fine, `wait` lo resetta a 0 e rilegge tutto. Comportamento sicuro.

---

## 4. Timeout e Reminder Prompt

Quando `wait`/`send-wait` **scade** (210s default, exit 2) senza nuovi messaggi,
lo script stampa su stdout un **Reminder Prompt** per l'agente:

```
--- REMINDER (timeout 210s, nessun nuovo messaggio) ---
Nessun messaggio da <ALTRO> negli ultimi 210s.
Se <ALTRO> è ancora al lavoro (sta scrivendo codice / indagando nella sua sessione),
RIMETTITI IN ATTESA rieseguendo lo stesso comando 'wait' (o 'send-wait' se vuoi
anche scrivere). È normale: il canale è asincrono e l'altro può essere occupato.
Solo se ritieni <ALTRO> assente o bloccato: sollecitalo con un 'send', oppure
prosegui per conto tuo e torna al canale dopo.
---
```

`<ALTRO>` è l'**ultimo sender != me** nel transcript (es. `VANTA`). Se il
transcript non ha ancora msg altrui, il fallback è `un altro partecipante`.

Il reminder è progettato perché l'agente LLM lo legga come istruzione: nella
maggior parte dei casi deve semplicemente **rieseguire `wait`**.

---

## 5. Exit code

| Code | Significato | Cosa fa l'agente |
|---|---|---|
| 0 | Successo (msg ricevuto / send OK / show; incluse no-op) | leggi l'output TOON, ragiona, rispondi |
| 1 | Errore interno (I/O, eccezione) | leggi `error:` nello stdout, diagnostica |
| 2 | Usage error (argomenti/flag errati) **oppure** timeout di wait/send-wait | se l'output ha `timeout:` → riesegui `wait`; se ha `error:` → correggi e ritenta |

> **Nota sull'exit 2.** AXI §6 assegna `2` al solo *usage error*. Qui `2` copre
> anche il timeout, perché è il **contratto** che il prompt
> `multi-agent-file-channel` e l'extension `agent_channel` usano per
> distinguere "nessun messaggio" dal successo. Per disambiguare, guarda il
> contenuto TOON: `timeout:` = attesa scaduta, `error:` = uso errato.

---

## 6. Esempi d'uso

### Apertura (ZED scrive per primo)

```bash
node ~/.pi/agent/bin/agent-channel.js send-wait diag ZED \
  "Sono ZED. Ipotizzo token JWT stantio. Tu su cosa sei?" --timeout=210
# blocca finché VANTA non risponde
```

### Turno normale (VANTA risponde + aspetta)

```bash
node ~/.pi/agent/bin/agent-channel.js send-wait diag VANTA \
  "Concordo. Verifico il listener main.tsx. Tu controlla il DB." --timeout=210
```

### Lascia un messaggio senza aspettare

```bash
node ~/.pi/agent/bin/agent-channel.js send diag ZED \
  "Io nel frattempo vado su README, a dopo."
# ritorna subito
```

### Solo attesa (dopo aver mandato un send separato)

```bash
node ~/.pi/agent/bin/agent-channel.js wait diag ZED --timeout=210
```

### Consultare il log

```bash
node ~/.pi/agent/bin/agent-channel.js show diag
```

### Sasso-carta-forbice commit-reveal (per decidere chi fa cosa)

```bash
# A: commit (hash del proprio tiro + nonce)
node ~/.pi/agent/bin/agent-channel.js send-wait split A \
  "COMMIT_A = $(printf '%s' 'sasso|nonce-randomissimo' | sha256sum | cut -d' ' -f1)"
# B: tiro in chiaro
node ~/.pi/agent/bin/agent-channel.js send-wait split B "forbici"
# A: reveal
node ~/.pi/agent/bin/agent-channel.js send-wait split A \
  "REVEAL: sasso | nonce-randomissimo (verifica hash == COMMIT_A)"
```

Vince chi? sasso>forbici, forbice>carta, carta>sasso. Pareggio → ritiro.

---

## 7. Il prompt associato (`multi-agent-file-channel.md`)

Non è obbligatorio: lo script funziona da solo. Ma il prompt fa scattare
l'**auto-allineamento** dell'agente quando l'utente dice "vi metto in
comunicazione": dichiara il nome, segue il ciclo `send-wait`, usa lo SCF
commit-reveal in caso di sovrapposizione, dichiara la propria zona del working
tree, è pronto a ritrattare se sbaglia. La `description` del frontmatter lo fa
triggerare nei contesti giusti.

---

## 8. Limiti e note

- **Cross-machine no**: la mailbox è su filesystem locale. Due agenti su macchine
  diverse non comunicano così (servirebbe un server MCP o un canale di rete).
- **Concorrenza**: atomicità garantita per righe piccole (< PIPE_BUF). Per
  payload enormi, splitta o aggiungi un lock.
- **Cursore per-partecipante**: se un agente cambia `<who>` a metà sessione,
  perde il cursore e rilegge tutto (benigno, solo ridondanza).
- **Reset/cleanup**: rimuovi `<cwd>/.agents/<channel>/` per azzerare il canale.
  I cursori sono dentro la stessa cartella, quindi spariscono insieme.
- **Non è crittografato**: il transcript è in chiaro. Non scambiate segreti
  tramite il canale (chiavi, password). Per i segreti usate gli env/secret store.

---

## 9. Versioning

Per versionare questa soluzione come unità coerente, copiate in un vostro repo
(dry, dotfiles, o un repo dedicato ai tool di pi) i tre file dell'installazione:

```
agent-channel.js                              →  bin/agent-channel.js
prompts/multi-agent-file-channel.md           →  prompts/multi-agent-file-channel.md
prompts/README-MULTI-AGENT-FILE-CHANNEL.md    →  prompts/README-MULTI-AGENT-FILE-CHANNEL.md
```

Suggerito un sync script che copi dai percorsi di installazione (`~/.pi/agent/`)
al repo e viceversa, per poter both "snapshot nello repo" e "reinstalla in
`~/.pi/agent/`". Alternativa minima: `cp` manuale dei 3 file quando cambia
qualcosa.

I file runtime (`<cwd>/.agents/`) vanno **ignorati** dal versioning (aggiungete
`.agents/` al `.gitignore` di ogni repo dove usate il canale).

### Cambiamenti tracciabili (CHANGELOG minimale)

- **v1.0 (18/07/2026)** — script `agent-channel.js`: comandi `send`/`wait`/`send-wait`/`show`, timeout default 210s, Reminder Prompt che nomina l'altro partecipante, NDJSON interno + pretty output, cursore per-partecipante.
- **v1.1 (18/07/2026)** — impacchettato come **pi package** `pi-agent-channel`: aggiunta l'**extension** `extensions/agent-channel.ts` che registra il custom tool **`agent_channel`** (thin wrapper dello script, path risolto via `import.meta.url`, zero deps runtime). Il package tiene insieme bin + prompt + README + extension come unità versionabile; installabile via `pi install` (locale/git/npm). Il tool è globale in ogni sessione pi, senza PATH.
- **v1.2 (21/07/2026)** — CLI **conforme AXI** (Agent eXperience Interface):
  - output strutturato in **TOON** (encoder inline zero-deps) al posto del plain text; `messages[N]{ts,sender,msg}`, `by_sender[N]{sender,count,last_ts}`, oggetti `sent`/`timeout`/`error`, `help[]` contestuale;
  - **content-first**: nessun argomento → home con stato live dei canali;
  - **errori strutturati su stdout** (mai stderr); exit code allineati ad AXI (0 successo, 1 errore, 2 usage) tranne il **timeout che resta exit 2 per contratto** (disambiguato dal contenuto TOON: `timeout:` vs `error:`);
  - **fail-loud** su flag/comandi sconosciuti (exit 2 + flag valide elencate); nessun prompt interattivo;
  - `--help` globale e per subcommand; `show --limit/--full/--fields`;
  - truncation di `msg` (>500 char) con preview + `--full`;
  - empty state espliciti e aggregati (`total`, `shown`, `by_sender`);
  - extension aggiornata: status `ok`/`timeout`/`usage_error`/`error` derivato da exit code + contenuto TOON.
  - **validazione TOON**: encoder estratto in `bin/toon.js` (modulo condiviso) + decoder `bin/toon-decode.js` + test di round-trip `test/toon.test.js` (`npm test`, 73 check su 14 casi d'uso inclusi edge case).
- **v1.3 (21/07/2026)** — **root condivisa come opzione di prima classe** per
  coordinare agenti in cwd diverse (pattern del progetto noderfy/fancy-copy-paste,
  vedi HANDOFF.md):
  - flag globale `--root=<path>` nello script (ogni subcommand + home) e parametro
    `root` nel tool nativo `agent_channel`; entrambi puntano alla stessa root così
    due agenti in working tree diversi condividono un unico transcript in
    `<root>/.agents/<channel>/`;
  - sostituisce il wrapper `AGENT_CHANNEL_ROOT=... node ...` (e il riferimento al
    package `agent-file-channel` di FORRESTAL-G, rimosso per conflitto col tool
    `agent_channel`) — ora il tool nativo basta da solo, in pieno AXI;
  - prompt `multi-agent-file-channel`: nuova sezione C "cwd diverse → root
    condivisa"; README: nuova §11.

---

## 10. Conformità AXI

Il CLI `agent-channel.js` segue i principi **AXI** (Agent eXperience Interface).
Riferimento: skill `axi` di pi + specifica [TOON](https://toonformat.dev/).

| Principio | Come è soddisfatto |
|---|---|
| §1 Output token-efficient | Tutto lo stdout è **TOON** (encoder `bin/toon.js`, zero-deps; round-trip validato da `npm test`). Niente JSON/plain-text nell'output agent-facing. |
| §2 Schema minimale | `messages[N]{ts,sender,msg}` di default (3 campi). `show --fields=ts,sender` per restringere/riordinare. |
| §3 Truncation | `msg` > 500 char troncato con preview + `... (truncated, N chars total; use --full)`. `show --full` per l'intero. Mai omesso. |
| §4 Aggregati | `show` include `total`, `shown`, `by_sender[N]{sender,count,last_ts}`. `home` include `total`/`last_*` per canale. |
| §5 Empty state | `show` su transcript vuoto: `total: 0` + `empty: "no messages ..."`. Home senza canali: `channels[0]:` + `note: "no channels found ..."`. |
| §6 Errori + exit code | Errori su **stdout** in TOON (`error:` + `help:`). Exit: 0 successo, 1 errore interno, 2 usage **o** timeout (v. nota §5). **Fail-loud** su flag/comandi sconosciuti (exit 2 + flag valide elencate). Nessun prompt interattivo. |
| §7 Contesto ambientale | **Non implementato** (intenzionale): il canale è una primitiva di coordinamento tra-agenti attivata on-demand, non uno stato da iniettare ogni sessione. Un SessionStart hook aggiungerebbe costo token per-sessione senza beneficio. Eventuale skill su `agentskills.io` come follow-up. |
| §8 Content-first | Nessun argomento → home con stato live dei canali (non un manuale). Il manuale è dietro `--help`. |
| §9 Disclosure | Ogni output include `help[]` con i prossimi comandi logici (send → wait; show → wait; timeout → keep waiting / nudge). Hint per liste troncate. |
| §10 Help consistente | Home identifica il tool (`bin:` con `~` collapse + `description:`). `--help` globale + `agent-channel --help <sub>` con flag, default ed esempio. |

### Deviazioni documentate

- **Exit 2 per il timeout** (AXI §6 vorrebbe `2` = solo usage error). Mantenuto
  come contratto con prompt + extension. Disambiguazione via contenuto TOON
  (`timeout:` vs `error:`).
- **§7 SessionStart hook skippato**: out-of-scope per una primitiva di
  coordinamento on-demand. Uno skill riassuntivo è un possibile follow-up.

## 11. Coordinamento con cwd diverse (root condivisa)

Quando i due agenti girano in **working tree diversi** (es.
`C:/github/noderfy/fancy-copy-paste/` + `C:/github/noderfy/noderfy-admin/`),
ciascuno con la propria cwd non vedrebbe il transcript dell'altro. Soluzione:
concordare una **root condivisa** (il genitore comune, es.
`C:/github/noderfy`) e puntare entrambi lì.

Via **tool nativo** `agent_channel` (parametro `root`, identico in entrambe le
sessioni):

```
agent_channel({ action: "send-wait", channel: "fcp-log-render",
                who: "FCP", msg: "root cause = X. Tu?",
                root: "C:/github/noderfy", timeout: 210 })
```

Via **script** (flag `--root` o env `AGENT_CHANNEL_ROOT`):

```bash
node .../agent-channel.js send-wait fcp-log-render FCP "..." --root=C:/github/noderfy
AGENT_CHANNEL_ROOT=C:/github/noderfy node .../agent-channel.js show fcp-log-render
```

Il transcript va in `C:/github/noderfy/.agents/fcp-log-render/`, condiviso. La
home con `--root` (o `show` con `root`) elenca i canali di quella root a
prescindere dalla cwd corrente.

> Sostituisce il vecchio wrapper `AGENT_CHANNEL_ROOT=... node
> .../agent-file-channel/bin/...` (package `agent-file-channel` di FORRESTAL-G,
> rimosso per conflitto col tool `agent_channel`). Ora il tool nativo basta da
> solo, in pieno AXI.
