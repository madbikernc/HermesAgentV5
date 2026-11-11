// Version: 1.0.0
//
// 1.0.0 (2026-11-10) -- where a bot's errors go when nothing else caught them.
//
// guardedInterval(fn, ms) is setInterval(fn, ms) for every periodic check in index.js: an error
// one tick throws (or a promise it returns rejects with) is logged as one line naming the error
// and the bot file it was thrown from, and the next tick runs as normal. Before, any such error
// reached Node's default handler and ended the process -- the whole bot restarted for one
// check's bug.
//
// installFatalHandlers(username) covers everything else: an uncaught exception or unhandled
// rejection is logged the same way, then the process still exits(1) for systemd to restart --
// state after an unknown error is not trusted, and hiding it would hide the bug.
//
// Both lines carry the error's name (TypeError, ReferenceError, ...), which
// tools/hermes-minecraft-triage.py's "crash" pattern matches, and the first stack frame in this
// codebase, so the self-repair bridge is handed the file and line, not just the message.

let label = "bot";

// The first stack frame in this codebase (not node_modules, not Node's own internals).
export function errorWhere(err) {
  const frames = String(err?.stack ?? "").split("\n").slice(1);
  const ours = frames.find((l) => /minecraft-bots\//.test(l) && !/node_modules/.test(l));
  const frame = ours ?? frames.find((l) => l.trim().startsWith("at ")) ?? "";
  const m = frame.match(/minecraft-bots\/([^\s:()]+):(\d+)(?::\d+)?/);
  return m ? `${m[1]}:${m[2]}` : frame.trim().replace(/^at /, "") || "unknown location";
}

export function describeError(err) {
  if (err instanceof Error) return `${err.name}: ${err.message} (at ${errorWhere(err)})`;
  return `non-Error value thrown: ${String(err)}`;
}

export function guardedInterval(fn, ms) {
  const report = (err) => console.error(`[${label}] periodic check failed: ${describeError(err)}`);
  return setInterval(() => {
    try {
      const result = fn();
      if (result && typeof result.catch === "function") result.catch(report);
    } catch (err) {
      report(err);
    }
  }, ms);
}

export function installFatalHandlers(username, proc = process) {
  label = username;
  const fatal = (kind) => (err) => {
    // stderr is a pipe to journald: exit only once the line is written, or it can be lost.
    proc.stderr.write(`[${label}] FATAL ${kind}: ${describeError(err)}\n${err?.stack ?? ""}\n`,
      () => proc.exit(1));
  };
  proc.on("uncaughtException", fatal("uncaughtException"));
  proc.on("unhandledRejection", fatal("unhandledRejection"));
}
