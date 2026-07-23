---
description: Metti in comunicazione due (o più) agenti via una mailbox channel su filesystem per fargli coordinare un task condiviso. Usalo quando l'utente dice "vi metto in comunicazione con un altro agente", "parla col collega", "coordinati via file", o quando c'è un problema condiviso (stesso working tree / stessa repo) e serve che gli agenti si sincronizzino senza pestarsi.
---

# Istruzioni: protocollo di coordinamento due-agenti via mailbox channel

Quando l'utente ti "mette in comunicazione" con un altro agente (in una sessione
separata), il canale è una **mailbox su filesystem** gestita dallo script
`agent-channel.js` (in `~/.pi/agent/bin/`). Lo script fa da **semaforo**: il
comando `wait` **blocca** il chiamante finché l'altro non scrive; niente più
polling manuale con `tail`. Lascia anche un **log locale leggibile**. Qui sotto
la metodologia esatta, come istruttoria: seguila.

## Contesto: quando serve

- Due agenti (sessioni separate) devono diagnosticare/risolvere **uno stesso
  problema** che tocca una repo o un working tree condiviso.
- Nessuno dei due vede lo schermo dell'altro: la **mailbox** è l'unico canale.
- Obiettivo: dividersi il lavoro senza collidere (due processi che editano lo
  stesso file = sovrascrizione reciproca) e arrivare a root cause + fix.

## 1. La primitiva

Due modi per invocare il canale:

### A) Via tool `agent_channel` (RACCOMANDATO se il package `pi-agent-channel` è installato come estensione pi)

L'estensione registra il custom tool `agent_channel`. L'agente lo chiama come
qualsiasi altro tool nativo — niente PATH, niente percorsi lunghi:

```
agent_channel({
  action: "send-wait",
  channel: "diag",
  who: "ZED",
  msg: "root cause = X. Tu su cosa sei?",
  timeout: 210
})
```

`action`: `send` | `wait` | `send-wait` | `show`. Stessa semantica dei comandi
script (§B). Il ritorno del tool contiene `content[].text` (output strutturato
**TOON**: tabelle `messages[N]{ts,sender,msg}`, oggetti `sent` / `timeout` /
`error`) e `details` con `exitCode` (0 = ok, 2 = timeout o usage error,
1 = errore interno) e `status` (`ok` / `timeout` / `usage_error` / `error`).

### B) Via script da bash (fallback / uso umano diretto)

`agent-channel.js` (in `~/.pi/agent/bin/`, o dentro il package installato in
`~/.pi/agent/npm/node_modules/pi-agent-channel/bin/`). Zero dipendenze (node
puro). Stati del canale in `<cwd>/.agents/<channel>/` (overridabile con
`AGENT_CHANNEL_ROOT`).

| Comando | Cosa fa | Exit |
|---|---|---|
| `send <channel> <who> <msg...>` | Scrive il messaggio e **ritorna subito** (= *rispondo e continuo per i fatti miei*) | 0 |
| `wait <channel> <who> [--timeout=N]` | **Blocca** finché arriva un messaggio da un altro `sender`; lo stampa (pretty), avanza il cursore | 0 = ricevuto, 2 = timeout |
| `send-wait <channel> <who> <msg...> [--timeout=N]` | **send + wait** in uno (= *rispondo e mi metto in attesa*: la "function call" combinata) | 0 / 2 |
| `show <channel> [--limit=N] [--full] [--fields=ts,sender,msg]` | Transcript in TOON: `total`, `by_sender[N]{sender,count,last_ts}`, tabella `messages`; `msg` troncato a 500 char (preview) a meno di `--full` | 0 |

- **Timeout di default = 210s (3.5 min)**, sotto il cap tipico del tool bash.
- Allo **scadere del timeout** lo script stampa un **Reminder Prompt** che ti dice
  di rimetterti in attesa (nomina anche l'altro partecipante se lo conosce).
- Se ci sono già messaggi non letti → `wait` ritorna subito.
- Più messaggi accumulati → tornano tutti insieme in una tabella TOON `messages[N]{ts,sender,msg}`.
- Output strutturato in **TOON** (Token-Oriented Object Notation): leggibile e
  ~40% più token-efficient del JSON equivalente. `show` aggiunge `total`,
  `shown` e `by_sender[N]{sender,count,last_ts}`.
- Lanciare `agent-channel` senza argomenti restituisce la **home**: stato live
  dei canali (`channels[N]{name,total,last_sender,last_ts}`), niente manuale.
- **Root condivisa** per agenti in cwd diverse: `--root=<path>` (flag globale,
  ogni subcommand e la home) o env `AGENT_CHANNEL_ROOT=<path>`. Il transcript va
  in `<root>/.agents/<channel>/`. Vedi §C.

### C) Quando i due agenti sono in directory diverse (cwd diverse)

Se tu e l'altro agente lavorate in working tree **diversi** (es. tu in
`<root>/fancy-copy-paste/`, lui in `<root>/noderfy-admin/`), ognuno con la
propria cwd non vede il transcript dell'altro. Soluzione: concordate una
**root condivisa** (il genitore comune dei vostri repo) e puntate entrambi lì.

- **Via tool `agent_channel`** (RACCOMANDATO): passate lo stesso parametro
  `root` in entrambe le sessioni:
  ```
  agent_channel({ action: "send-wait", channel: "fcp-log-render",
                  who: "FCP", msg: "root cause = X. Tu?",
                  root: "/c/github/noderfy", timeout: 210 })
  ```
- **Via script**: flag `--root=<path>` o env `AGENT_CHANNEL_ROOT=<path>`:
  ```
  AGENT_CHANNEL_ROOT=/c/github/noderfy node .../agent-channel.js send-wait fcp-log-render FCP "..."
  node .../agent-channel.js show fcp-log-render --root=/c/github/noderfy
  ```

Il transcript va in `<root>/.agents/<channel>/`, condiviso. La **home** con
`--root=<path>` (o l'azione `show` con `root`) mostra i canali presenti in
quella root, anche se la tua cwd è un'altra.

Esempio di "turno" completo (risposta + attesa):
```
node ~/.pi/agent/bin/agent-channel.js send-wait <channel> ZED "root cause = X. Procedo su file A. Tu?" --timeout=210
```

Esempio di output TOON (wait che riceve 2 messaggi, exit 0):
```
channel: diag
received: 2
messages[2]{ts,sender,msg}:
  1784344404,VANTA,Concordo. Verifico il listener main.tsx.
  1784344409,VANTA,Root cause confermata: token JWT stantio
help[1]: Run `agent-channel send-wait diag ZED "<reply>"` to answer and wait again
```

Esempio di output TOON (timeout, exit 2):
```
timeout:
  seconds: 210
  last_other_sender: VANTA
reminder: "Nessun messaggio da VANTA negli ultimi 210s. Se VANTA è ancora al lavoro, RIMETTITI IN ATTESA rieseguendo 'wait' (o 'send-wait'). Solo se lo ritieni assente: sollecita con 'send' o prosegui."
exit: 2
help[2]: Run `agent-channel wait diag ZED --timeout=210` to keep waiting, Run `agent-channel send diag ZED "<nudge>"` to nudge VANTA
```

## 2. Setup + scelta del nome

- Scegliete il **nome del channel** (breve, legato al task: `fcp-bug`, `auth-diag`).
- Nel **primo messaggio** dichiara un **nome breve, maiuscolo, distintivo** (3-5
  lettere: `ZED`, `VANTA`, `NIX`). Niente "io", niente nomi ambigui.
- Quel nome è il `<who>` in ogni comando. Non cambiarlo a metà sessione.

## 3. Stile comunicativo

- **Deciso, freddo, addensato**. Stile telegramma: frasi brevi, niente
  congiuntivi, niente formalismi ("ciao", "grazie", "secondo me forse").
  Comprensione concettuale > grammatica.
- Eccezione: quando **spieghi codice o diff** (snippet, nomi di funzione, hash,
  query), puoi essere più discorsivo — la precisione tecnica vince sulla sintesi.
- Niente ripetizioni: se hai già dato un'informazione in un turno, non ridarla.

## 4. Ciclo: send-wait → leggi → send-wait

Il ciclo naturale è una sequenza di `send-wait`:

1. `send-wait <ch> <tuonome> "<msg>"` — scrivi la tua posizione/domanda e ti metti
   in attesa.
2. Il comando blocca. Quando l'altro scrive, stampa il suo msg ed exit 0.
3. Leggi, ragiona (puoi indagare in locale nel frattempo), poi ripeti dal punto 1.
4. Se scade il timeout (exit 2 + Reminder Prompt): **riesegui `wait`** se l'altro
   è ancora al lavoro (il reminder te lo dice); sollecita con `send` o prosegui
   per conto tuo solo se ritieni l'altro assente.

`send` (senza wait) lo usi quando vuoi **lasciare un'informazione e basta**,
senza aspettare risposta (es. "io intanto vado su file B, a dopo").

## 5. Sasso-carta-forbice con commit-reveal (per scegliere chi fa cosa)

Quando c'è **sovrapposizione** (entrambi vogliono indagare/fixare la stessa
cosa) e serve estrarre chi se la prende, usate sasso-carta-forbice (SCF). Il
vincolo: il canale è asincrono, e **chi risponde dopo potrebbe barare** leggendo
il tiro dell'altro prima di dichiarare il suo. Servono due turni di
commit-reveal (hash commitment):

1. **Commit**: il primo agent pubblica un **hash**, NON il tiro:
   ```
   send-wait <ch> <A> "COMMIT_A = <sha256(\"<tiro>|<nonce>\")>"
   ```
2. **Reveal**: l'altro agent scrive il **suo tiro in chiaro** (sasso | carta |
   forbici). Solo dopo averlo letto, il primo **rivela** tiro + nonce;
   l'altro verifica `sha256(tiro+"|"+nonce) == COMMIT`.
3. Regole: sasso>forbici, forbice>carta, carta>sasso. Pareggio → ritiro.
4. Il **vincitore sceglie per primo** il lato/file che vuole; il perdente prende
   il resto.

Se c'è **fiducia esplicita** (l'utente dice "lavorate nello stesso working tree,
no problem") potete saltare lo SCF e accordarvi a parole — ma solo se nessuno ha
argomenti forti per un lato specifico. Lo SCF è un tie-breaker deterministico,
non un gioco.

## 6. Coordinamento sul working tree condiviso

- Nel primo turno, **dichiara quali file stai toccando** (o "sto fuori da X").
  Chiedi all'altro la stessa cosa.
- Se l'altro ha **uncommitted** su un file, **non attaccarlo anche tu**: rischi di
  sovrascrivere le sue modifiche. O aspetti che commit/pulisca, o ti offri di
  subentrare su quel file quando lui molla.
- Se l'utente chiarisce "stesso working tree, no problem", puoi collaborare più
  liberamente — ma continua a dichiarare la tua zona.

## 7. Ritrattabilità (niente ego)

Se scopri di esserti **sbagliato** (grep difettoso, ipotesi smentita, file che
esisteva già), **ritira esplicitamente** nel messaggio successivo: "RETTIFICA:
avevo torto perché X. La tua tesi regge." È il metodo scientifico. Non insistere
su una posizione per orgoglio — costa tempo all'utente e rallenta la diagnosi.

## 8. Chiusura

- Quando il task è risolto (root cause confermata + fix applicato e testato),
  scrivi **CHIUSO** con un breve riepilogo nel canale.
- Lascia la **decisione di commit** all'utente (non committare senza ok,
  specialmente se il working tree ha lavoro misto: restyle + fix, tuo + dell'altro).
- Aggiorna memoria agente + HANDOFF/README con la lezione appresa.
- `show <channel>` resta come log consultabile della sessione.

## Antipattern (da evitare)

- Due `send` di fila senza aspettare risposta (rompi l'allineamento).
- Sostituire `.agents/<channel>/transcript.ndjson` invece di appendere via
  `send` (corrompi i cursori altrui).
- Ignorare il Reminder Prompt di timeout: se l'altro è attivo, riesegui `wait`.
- Fixare lo stesso file che l'altro sta editando senza coordinarsi.
- Insistere su un'ipotesi dopo che l'altro l'ha smentita con evidenza.
- Inviare "ci sei?" / "sto aspettando" ripetutamente: il timeout + reminder
  gestiscono già l'attesa, una sola sollecitazione mirata se serve.
