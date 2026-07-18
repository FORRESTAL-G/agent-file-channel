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
      "Mailbox channel via filesystem to coordinate with another pi agent in a separate session, on a shared working tree. Blocking semaphore: 'wait' and 'send-wait' block the caller until the other agent writes a new message (or until the timeout). Leaves a readable local log at <cwd>/.agents/<channel>/. Use it when the user puts you in communication with another agent via a file channel. Actions: 'send' (write + return immediately), 'wait' (block until other writes), 'send-wait' (write + block), 'show' (print whole transcript). Exit 0 = message received, 2 = timeout (a reminder is printed suggesting to wait again).",
    promptSnippet:
      "Coordinate with another agent via mailbox channel (send/wait/send-wait/show) — blocking semaphore on shared working tree",
    promptGuidelines: [
      "Use the agent_channel tool to exchange messages with another agent when the user sets up a file-channel coordination between two sessions. Prefer 'send-wait' for a turn (write your message and block for the reply). If agent_channel returns exit code 2 (timeout) with the reminder, call it again with action 'wait' (or 'send-wait' to add a note) unless you have reason to believe the other agent is truly absent.",
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
          description: "Seconds. Default 210 (3.5 min). For wait / send-wait. At timeout: exit 2 + reminder printed.",
        },
      },
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const action = params.action;
      const channel = String(params.channel || "");
      const who = params.who ? String(params.who) : "";
      const msg = params.msg != null ? String(params.msg) : "";

      if (!channel) {
        return { content: [{ type: "text", text: "agent_channel: 'channel' is required." }], details: { error: true } };
      }
      if ((action === "send" || action === "send-wait") && !msg) {
        return { content: [{ type: "text", text: "agent_channel: 'msg' is required for send / send-wait." }], details: { error: true } };
      }
      if (action !== "show" && !who) {
        return { content: [{ type: "text", text: "agent_channel: 'who' is required for " + action + "." }], details: { error: true } };
      }

      const args = [action, channel];
      if (action !== "show") args.push(who);
      if (action === "send" || action === "send-wait") args.push(msg);
      if ((action === "wait" || action === "send-wait") && typeof params.timeout === "number") {
        args.push("--timeout=" + params.timeout);
      }

      const { stdout, stderr, exitCode } = await runScript(args, ctx?.cwd || process.cwd(), signal);
      const out = [stdout, stderr].map((s) => (s || "").trim()).filter(Boolean).join("\n");
      const status = exitCode === 0 ? "ok" : exitCode === 2 ? "timeout" : "error";

      let text = out;
      if (!text) text = `(agent_channel ${action} → exit ${exitCode}, no output)`;
      if (exitCode !== 0) text = `[exit ${exitCode} / ${status}]\n${text}`;

      return {
        content: [{ type: "text", text }],
        details: { action, channel, who, exitCode, status },
      };
    },
  });
}
