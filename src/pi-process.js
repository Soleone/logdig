import { spawn } from "node:child_process";

function quoteCmdArgument(value) {
  const text = String(value);
  if (/[\0\r\n"]/.test(text) || text.includes("%")) {
    throw new Error("Pi command arguments cannot contain quotes, newlines, or percent signs on Windows");
  }
  return `"${text}"`;
}

export function spawnPiProcess(command, args, options, { platform = process.platform, spawnProcess = spawn } = {}) {
  if (platform !== "win32") return spawnProcess(command, args, options);

  const commandLine = [command, ...args].map(quoteCmdArgument).join(" ");
  return spawnProcess(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/v:off", "/c", `"${commandLine}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}
