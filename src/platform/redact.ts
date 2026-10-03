// Frontend sensitive-value redaction. Mirrors src-tauri/src/logging.rs so
// developer tokens, Music User Tokens, and Authorization headers never reach
// the diagnostics pane or local logs (plan section 18: auth data is toxic).

const TOKEN_PREFIXES = ["eyJ"];
// Music User Tokens are opaque (not JWTs), so they are caught by the key
// that labels them and by exact value once the app has seen them.
const TOKEN_KEY_PATTERN =
  /((?:music|media)[-_]?user[-_]?token|developer[-_]?token)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi;
const MIN_REGISTERED_LENGTH = 16;
const registeredValues = new Set<string>();

/** Redacts this exact value from every later log line. */
export function registerSensitiveValue(value: unknown): void {
  if (typeof value === "string" && value.length >= MIN_REGISTERED_LENGTH) {
    registeredValues.add(value);
  }
}

export function clearSensitiveValues(): void {
  registeredValues.clear();
}

function redactPrefix(text: string, prefix: string): string {
  let result = text;
  let start = result.indexOf(prefix);
  while (start >= 0) {
    let end = result.length;
    for (let i = start; i < result.length; i += 1) {
      const char = result[i];
      if (
        char === " " ||
        char === "\t" ||
        char === "\n" ||
        char === '"' ||
        char === "'" ||
        char === ","
      ) {
        end = i;
        break;
      }
    }
    result = `${result.slice(0, start)}[REDACTED]${result.slice(end)}`;
    start = result.indexOf(prefix);
  }
  return result;
}

export function redactSensitive(text: string): string {
  let result = text;
  for (const value of registeredValues) {
    result = result.split(value).join("[REDACTED]");
  }
  result = result.replace(TOKEN_KEY_PATTERN, "$1$2[REDACTED]");
  for (const prefix of TOKEN_PREFIXES) {
    result = redactPrefix(result, prefix);
  }
  // Authorization header values are never safe to display.
  result = result.replace(
    /(authorization\s*:\s*(?:bearer\s+)?)[^\s"']+/gi,
    "$1[REDACTED]",
  );
  return result;
}
