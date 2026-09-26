// Strip terminal control strings in full, including their non-printing payloads.
// An unterminated string consumes the remainder rather than exposing OSC data.
function skipControlString(input: string, start: number, osc: boolean): number {
  for (let i = start; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 0x9c || (osc && code === 0x07)) return i + 1;
    if (code === 0x1b && input[i + 1] === "\\") return i + 2;
  }
  return input.length;
}

function skipCsi(input: string, start: number): number {
  let i = start;
  for (; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
    if (code >= 0x20 && code <= 0x3f) continue;
    if (code < 0x20 && code !== 0x1b) continue;
    // Let the outer parser handle a nested escape or ordinary Unicode text.
    break;
  }
  return i;
}

function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x206f)
  );
}

/** Keep readable Unicode, LF and TAB; remove ANSI, C0/C1 and bidi controls. */
export function sanitizeText(input: string): string {
  const output: string[] = [];
  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code === 0x1b) {
      const next = input[++i];
      if (next === "[") {
        i = skipCsi(input, i + 1);
      } else if (
        next === "]" ||
        next === "P" ||
        next === "X" ||
        next === "^" ||
        next === "_"
      ) {
        i = skipControlString(input, i + 1, next === "]");
      } else {
        // Other ESC sequences: zero or more intermediate bytes, then a final.
        while (input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
        if (input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x7e) i++;
      }
      continue;
    }
    if (code === 0x9b) {
      i = skipCsi(input, i + 1);
      continue;
    }
    if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      i = skipControlString(input, i + 1, code === 0x9d);
      continue;
    }
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f) ||
      isBidiControl(code) ||
      code === 0xfeff
    ) {
      i++;
      continue;
    }
    output.push(input[i]!);
    i++;
  }
  return output.join("");
}

function isPublicIpv4(host: string): boolean {
  const [a, b, c] = host.split(".").map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicIpv6(host: string): boolean {
  // URL has already validated and canonicalized the bracketed literal.
  const [first = "", second = ""] = host.slice(1, -1).split(":");
  const a = Number.parseInt(first, 16);
  const b = Number.parseInt(second || "0", 16);
  // Conservatively allow global unicast only: no local, mapped IPv4 or NAT64.
  if (!(a >= 0x2000 && a <= 0x3fff)) return false;
  if (a === 0x2002) return false; // 6to4 can encapsulate a private IPv4 address.
  if (a === 0x2001 && (b < 0x0200 || b === 0x0db8)) return false;
  if (a === 0x3fff && b <= 0x0fff) return false; // Documentation prefix.
  return true;
}

/** Syntactic public-URL guard, not DNS resolution or a DNS-rebinding defense. */
export function safePublicUrl(input: string): string | null {
  // Do not let URL's whitespace/backslash normalization hide unsafe input.
  if (
    !/^https?:\/\//i.test(input) ||
    /[\s\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\\]/u.test(
      input,
    )
  ) {
    return null;
  }
  const authority = input.slice(input.indexOf("://") + 3).split(/[/?#]/, 1)[0]!;
  if (!authority || authority.includes("@")) return null; // Includes empty userinfo.

  try {
    const url = new URL(input);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (host.startsWith("[")) {
      return isPublicIpv6(host) ? url.href : null;
    }
    // WHATWG URL canonicalizes decimal, hex, octal and shortened IPv4 forms.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return isPublicIpv4(host) ? url.href : null;
    }
    if (
      !host.includes(".") ||
      host.endsWith(".localhost") ||
      host === "localhost.localdomain" ||
      host.endsWith(".localhost.localdomain") ||
      host.endsWith(".local")
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/** A safe ASCII host label, including a non-default port; empty for unsafe URLs. */
export function displayHost(url: string): string {
  const safe = safePublicUrl(url);
  return safe ? new URL(safe).host : "";
}
