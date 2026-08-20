/**
 * Load-env files are sourced by POSIX `sh` entrypoints. Bare `KEY=/path with
 * spaces` word-splits (`Application Support` → command `Support/...`).
 */

/** POSIX helper: assign KEY=VALUE lines without word-splitting or globbing. */
export const LOAD_ENV_FILE_SH = [
  "load_env_file() {",
  '  [ -f "$1" ] || return 0',
  '  while IFS= read -r _line || [ -n "$_line" ]; do',
  '    case "$_line" in',
  '      ""|"#"*) continue ;;',
  "    esac",
  '    _key="${_line%%=*}"',
  '    _val="${_line#*=}"',
  '    _q1="${_val%"${_val#?}"}"',
  '    _q2="${_val#"${_val%?}"}"',
  `    if [ "$_q1" = "$_q2" ] && { [ "$_q1" = '"' ] || [ "$_q1" = "'" ]; }; then`,
  '      _val="${_val#?}"',
  '      _val="${_val%?}"',
  "    fi",
  '    case "$_key" in',
  '      ""|*[!A-Za-z0-9_]*) continue ;;',
  "    esac",
  '    export "$_key=$_val"',
  '  done < "$1"',
  "  unset _line _key _val _q1 _q2",
  "}",
].join("\n");

export function quoteLoadEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

export function renderLoadEnv(
  lines: Record<string, string | number | null | undefined>,
): string {
  const body = Object.entries(lines)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${quoteLoadEnvValue(String(v))}`)
    .join("\n");
  return `${body}\n`;
}

function unquoteLoadEnvValue(raw: string): string {
  if (raw.length >= 2) {
    const start = raw[0];
    const end = raw[raw.length - 1];
    if (start === end && (start === '"' || start === "'")) {
      const inner = raw.slice(1, -1);
      if (start === '"') {
        return inner.replace(/\\([\\"$`])/g, "$1");
      }
      return inner;
    }
  }
  return raw;
}

export function parseLoadEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = unquoteLoadEnvValue(trimmed.slice(eq + 1));
  }
  return out;
}
