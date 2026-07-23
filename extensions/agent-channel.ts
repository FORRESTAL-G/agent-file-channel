// agent-channel.ts — pi extension che registra il custom tool `agent_channel`.
//
// Thin wrapper attorno a `../bin/agent-channel.js` (che resta la single source
// of truth della logica: semaforo, cursore, NDJSON, reminder prompt). Il tool
// risolve il path del bin via import.meta.url (niente hardcoding, niente PATH)
// e lo esegue in-process via child_process.
//
// Zero dipendenze runtime esterne: solo node built-ins. JSON schema "plain"
// per i parameters (così non serve typebox/pi-ai come deps).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "agent-channel.js");

function runScript(args, cwd, signal) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr + "\n[spawn error] " + (err?.message || err), exitCode: 4 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

export default function (pi) {
  pi.registerTool({
    name: "agent_channel",
    label: "Agent Channel",
    description:
      "Mailbox channel via filesystem to coordinate with another pi agent in a separate session, on a shared working tree. Blocking semaphore: 'wait' and 'send-wait' block the caller until the other agent writes a new message (or until the timeout). Leaves a readable local log at <root>/.agents/<channel>/ (root = the `root` param, AGENT_CHANNEL_ROOT env, or the session cwd). Use it when the user puts you in communication with another agent via a file channel. If the two agents run in DIFFERENT directories, pass the SAME `root` (e.g. a common parent dir) on both so they share one transcript. Actions: 'send' (write + return immediately), 'wait' (block until other writes), 'send-wait' (write + block), 'show' (print whole transcript). Output is structured TOON on stdout. details.exitCode: 0 = ok, 2 = timeout (a `timeout:` object with a `reminder` is returned, keep waiting) OR usage error (an `error:` object), 1 = internal error.",
    promptSnippet:
      "Coordinate with another agent via mailbox channel (send/wait/send-wait/show) — blocking semaphore on shared working tree. Output is TOON.",
    promptGuidelines: [
      "Use the agent_channel tool to exchange messages with another agent when the user sets up a file-channel coordination between two sessions. Prefer 'send-wait' for a turn (write your message and block for the reply).",
      "Output is structured TOON: on a successful wait/send-wait you get a `messages[N]{ts,sender,msg}` table; on timeout (exit code 2) you get a `timeout:` object with a `reminder` string — call agent_channel again with action 'wait' (or 'send-wait' to add a note) unless you have reason to believe the other agent is truly absent.",
      "Details are in details.exitCode (0 ok, 2 timeout/usage, 1 error) and details.status (ok/timeout/usage_error/error).",
    ],
    // JSON schema plain (no typebox dep). Pi accetta entrambi.
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action", "channel"],
      properties: {
        action: {
          type: "string",
          enum: ["send", "wait", "send-wait", "show"],
          description: "send = write + return immediately; wait = block until the other writes; send-wait = send + wait in one; show = print whole transcript.",
        },
        channel: {
          type: "string",
          description: "Channel name, shared between the two agents (e.g. 'diag', 'fcp-bug'). Defines <cwd>/.agents/<channel>/.",
        },
        who: {
          type: "string",
          description: "Your participant name (short, uppercase, e.g. ZED). Same every call. Required for send / wait / send-wait; ignored by show.",
        },
        msg: {
          type: "string",
          description: "Message text. Required for send / send-wait. Ignored by wait / show.",
        },
        timeout: {
          type: "number",
          description: "Seconds. Default 210 (3.5 min). For wait / send-wait. At timeout: exit 2 + reminder returned.",
        },
        root: {
          type: "string",
          description: "Shared root directory for the channel transcript (<root>/.agents/<channel>/). Use it when the two agents run in DIFFERENT working directories: set the SAME root on both (e.g. a common parent dir like the repo group root) so they read/write the same transcript. Defaults to the session cwd (or AGENT_CHANNEL_ROOT env).",
        },
      },
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Guard: il bin deve esistere. Se il package è stato rimosso/spostato (o la
      // sessione ha caricato un'estensione stale), restituisci un errore
      // strutturato ACTIONABLE invece di lasciar leakare il traceback di node
      // ("Cannot find module ..."). AXI §6: traduci l'errore, niente rumore.
      if (!existsSync(BIN)) {
        return {
          content: [{ type: "text", text: `error: agent_channel script not found at ${BIN} — the pi-agent-channel package may be missing or this session loaded a stale extension. Reinstall it (\`pi install\` from its source) and RESTART this pi session so the tool reloads.` }],
          details: { error: true, status: "error" },
        };
      }
      const action = params.action;
      const channel = String(params.channel || "");
      const who = params.who ? String(params.who) : "";
      const msg = params.msg != null ? String(params.msg) : "";

      if (!channel) {
        return { content: [{ type: "text", text: "error: 'channel' is required" }], details: { error: true, status: "usage_error" } };
      }
      if ((action === "send" || action === "send-wait") && !msg) {
        return { content: [{ type: "text", text: "error: 'msg' is required for send / send-wait" }], details: { error: true, status: "usage_error" } };
      }
      if (action !== "show" && !who) {
        return { content: [{ type: "text", text: "error: 'who' is required for " + action }], details: { error: true, status: "usage_error" } };
      }

      const args = [action, channel];
      if (action !== "show") args.push(who);
      if (action === "send" || action === "send-wait") args.push(msg);
      if ((action === "wait" || action === "send-wait") && typeof params.timeout === "number") {
        args.push("--timeout=" + params.timeout);
      }
      if (params.root) args.push("--root=" + params.root);

      const { stdout, stderr, exitCode } = await runScript(args, ctx?.cwd || process.cwd(), signal);
      // stdout è TOON strutturato. stderr solo diagnostica (non attesa).
      const out = (stdout || "").trim();
      // exit 2 = timeout OPPURE usage error: distingui dal contenuto TOON.
      //   timeout  → stdout contiene un oggetto `timeout:`
      //   usage    → stdout contiene un oggetto `error:`
      let status;
      if (exitCode === 0) status = "ok";
      else if (exitCode === 2) status = /(^|\n)timeout:/.test(out) ? "timeout" : "usage_error";
      else status = "error";

      let text = out;
      if (!text) {
        text = stderr.trim() || `(agent_channel ${action} → exit ${exitCode}, no output)`;
      }

      return {
        content: [{ type: "text", text }],
        details: { action, channel, who, exitCode, status },
      };
    },
  });
}
