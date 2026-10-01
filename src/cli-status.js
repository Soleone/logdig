const STATUS_WIDTH = 6;
const ICON_STATUS_WIDTH = 2;

const statuses = {
  ok: { text: "OK", icon: "\uf00c", color: "32" },
  warning: { text: "WARN", icon: "\uf071", color: "33" },
  error: { text: "FIX", icon: "\uf00d", color: "31" },
};

const progressStatuses = {
  CHECKING: { icon: "\uf002", color: "36" },
  SUMMARIZING: { icon: "\uf110", color: "36" },
  SAVED: { icon: "\uf00c", color: "32" },
  UPDATED: { icon: "\uf040", color: "36" },
  CURRENT: { icon: "\uf058", color: "32" },
  DONE: { icon: "\uf00c", color: "32" },
  SKIPPED: { icon: "\uf05e", color: "33" },
  FAILED: { icon: "\uf00d", color: "31" },
  PREVIEW: { icon: "\uf06e", color: "36" },
};

const PROGRESS_STATUS_WIDTH = Math.max(...Object.keys(progressStatuses).map((status) => status.length));

export { STATUS_WIDTH };

function useIcons({
  isTTY = process.stdout.isTTY,
  term = process.env.TERM,
  icons = process.env.LOGDIG_ICONS !== "0",
} = {}) {
  return isTTY && term !== "dumb" && icons;
}

export function statusPrefixWidth(options) {
  return useIcons(options) ? ICON_STATUS_WIDTH : STATUS_WIDTH;
}

export function statusPrefix(status, options = {}) {
  const marker = statuses[status];
  if (!marker) throw new TypeError(`Unknown CLI status: ${status}`);

  if (!useIcons(options)) {
    return `${marker.text}${" ".repeat(STATUS_WIDTH - marker.text.length)}`;
  }

  const noColor = options.noColor ?? process.env.NO_COLOR !== undefined;
  const icon = noColor ? marker.icon : `\u001b[${marker.color}m${marker.icon}\u001b[0m`;
  return `${icon} `;
}

export function progressStatus(status, options = {}) {
  const marker = progressStatuses[status];
  if (!marker) throw new TypeError(`Unknown progress status: ${status}`);
  const text = options.pad ? status.padEnd(PROGRESS_STATUS_WIDTH) : status;
  if (!useIcons(options)) return text;

  const noColor = options.noColor ?? process.env.NO_COLOR !== undefined;
  const icon = noColor ? marker.icon : `\u001b[${marker.color}m${marker.icon}\u001b[0m`;
  return `${icon} ${text}`;
}
