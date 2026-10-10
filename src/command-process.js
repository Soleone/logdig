import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

// True when a command can be run: a path to an executable, or a bare name found on PATH.
export async function commandAvailable(command, { env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (command.includes("/") || command.includes("\\")) {
    candidates.push(command);
  } else {
    const extensions = platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
    for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
      for (const extension of extensions) candidates.push(path.join(directory, `${command}${extension}`));
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Keep looking through the remaining PATH entries.
    }
  }
  return false;
}

function quoteCmdArgument(value) {
  const text = String(value);
  if (/[\0\r\n"]/.test(text) || text.includes("%")) {
    throw new Error("Command arguments cannot contain quotes, newlines, or percent signs on Windows");
  }
  return `"${text}"`;
}

export function spawnCommand(command, args, options, { platform = process.platform, spawnProcess = spawn } = {}) {
  if (platform !== "win32") return spawnProcess(command, args, options);

  const commandLine = [command, ...args].map(quoteCmdArgument).join(" ");
  return spawnProcess(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/v:off", "/c", `"${commandLine}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}
