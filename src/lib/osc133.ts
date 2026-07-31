export type Osc133Event =
  | { kind: "prompt-start" }
  | { kind: "prompt-end" }
  | { kind: "command-start"; command: string | null }
  | { kind: "command-end"; exitCode: number | null };

/** Parse FinalTerm/OSC 133 shell lifecycle markers emitted by our shell hook. */
export function parseOsc133(payload: string): Osc133Event | null {
  if (payload === "A") return { kind: "prompt-start" };
  if (payload === "B") return { kind: "prompt-end" };

  const [marker, value] = splitOnce(payload, ";");
  if (marker === "C") {
    if (!value) return { kind: "command-start", command: null };
    const encoded = value.startsWith("cmd=") ? value.slice(4) : null;
    return {
      kind: "command-start",
      command: encoded === null ? null : decodeUtf8Base64(encoded),
    };
  }
  if (marker === "D") {
    if (!value) return { kind: "command-end", exitCode: null };
    const exitCode = Number(value);
    return {
      kind: "command-end",
      exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    };
  }
  return null;
}

function splitOnce(value: string, separator: string): [string, string] {
  const at = value.indexOf(separator);
  return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at + separator.length)];
}

function decodeUtf8Base64(value: string): string | null {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
