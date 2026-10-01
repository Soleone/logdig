const STATUS_WIDTH = 6;
const ICON_STATUS_WIDTH = 2;

const statuses = {
  ok: { text: "OK", icon: "\uf00c", color: "32" },
  warning: { text: "WARN", icon: "\uf071", color: "33" },
  error: { text: "FIX", icon: "\uf00d", color: "31" },
};

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
