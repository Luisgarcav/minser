import { describe, expect, test } from "bun:test";
import { displayHost, safePublicUrl, sanitizeText } from "../src/text";

describe("sanitizeText", () => {
  test("preserves readable Unicode, newlines, tabs and emoji joiners", () => {
    const text = "Definición: ∑ α ≤ β\n\t中文 العربية café e\u0301 👩‍🔬";
    expect(sanitizeText(text)).toBe(text);
    expect(sanitizeText("")).toBe("");
  });

  test.each([
    ["\x1b[31mrojo\x1b[0m", "rojo"],
    ["a\x1b[2J\x1b[H\x1b[?25lb", "ab"],
    ["\x9b38;2;255;0;0mrojo\x9b0m", "rojo"],
    ["a\x1b7b\x1b8c\x1b=\x1b>d\x1bce", "abcde"],
    ["\x1b(Btexto\x1b)0", "texto"],
    ["a\x1b[31\x00mb", "ab"],
    ["a\x1b[\x1b[31mb", "ab"],
    ["a\x1b[💡b", "a💡b"],
    ["a\x1b", "a"],
    ["a\x1b[", "a"],
    ["a\x1b[31;", "a"],
    ["a\x1b(", "a"],
  ])("removes ANSI sequences: %j", (input, output) => {
    expect(sanitizeText(input)).toBe(output);
  });

  test.each([
    ["a\x1b]0;window title\x07b", "ab"],
    ["a\x1b]52;c;clipboard secret\x1b\\b", "ab"],
    ["\x1b]8;;https://evil.example\x07label\x1b]8;;\x07", "label"],
    ["\x9d8;;https://evil.example\x9clabel\x9d8;;\x9c", "label"],
    ["a\x1bPdevice payload\x1b\\b", "ab"],
    ["a\x1bXsecret\x1b\\b", "ab"],
    ["a\x1b^secret\x1b\\b", "ab"],
    ["a\x1b_secret\x1b\\b", "ab"],
    ["a\x90secret\x9cb", "ab"],
    ["a\x98secret\x9cb", "ab"],
    ["a\x9esecret\x9cb", "ab"],
    ["a\x9fsecret\x9cb", "ab"],
    ["a\x1b]52;c;unterminated\nsecret", "a"],
    ["a\x1bPunterminated", "a"],
    ["a\x9dunterminated", "a"],
  ])("removes complete control-string payloads: %j", (input, output) => {
    expect(sanitizeText(input)).toBe(output);
  });

  test("strips C0/C1, carriage return, DEL, BOM and bidi controls", () => {
    expect(
      sanitizeText("a\x00\x01\x07\x08\x0b\x0c\x0e\x1f\x7f\x80\x85\x9cb\r\n\tc"),
    ).toBe("ab\n\tc");
    const bidi =
      "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u206a\u206b\u206c\u206d\u206e\u206f\ufeff";
    expect(sanitizeText(`antes${bidi}después`)).toBe("antesdespués");
  });

  test("is idempotent and never leaves terminal escape characters", () => {
    const text =
      "\x1b[1mTítulo\x1b[0m\n\x1b]8;;https://example.org\x1b\\cita\x1b]8;;\x1b\\\t\u202etexto\x07";
    const safe = sanitizeText(text);
    expect(safe).toBe("Título\ncita\ttexto");
    expect(sanitizeText(safe)).toBe(safe);
    expect(safe).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e]/);
  });
});

describe("safePublicUrl", () => {
  test.each([
    [
      "https://Example.ORG:443/paper?q=term#definition",
      "https://example.org/paper?q=term#definition",
    ],
    ["http://example.org:8080/docs", "http://example.org:8080/docs"],
    ["https://example.org./", "https://example.org./"],
    ["https://münich.example/α", "https://xn--mnich-kva.example/%CE%B1"],
    ["https://8.8.8.8/", "https://8.8.8.8/"],
    ["http://1.1.1.1/", "http://1.1.1.1/"],
    ["https://[2606:4700:4700::1111]/", "https://[2606:4700:4700::1111]/"],
    ["https://[2001:4860:4860::8888]/", "https://[2001:4860:4860::8888]/"],
    [
      "https://example.org/path@name?url=http://localhost",
      "https://example.org/path@name?url=http://localhost",
    ],
  ])("accepts and canonicalizes public HTTP(S): %s", (input, output) => {
    expect(safePublicUrl(input)).toBe(output);
  });

  test.each([
    "",
    "not a URL",
    "/paper",
    "//example.org/paper",
    "https:example.org",
    "ftp://example.org/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://user:password@example.org/",
    "https://user@example.org/",
    "https://@example.org/",
    "https://:@example.org/",
    "https:////@example.org/",
    "https:///example.org/",
    "https://example.org\\@localhost/",
    "https://example.org/\x1b[31m",
    "https://example.org/\u202etxt",
    "https://example.org/\u061c",
    "https://example.org/\u2066text",
    " https://example.org/",
    "https://example.org/\n",
    "https://exa\tmple.org/",
    "https://example.org/a b",
    "https://[not-an-ip]/",
    "https://example.org:99999/",
    "https://%/",
  ])("rejects malformed, credential-bearing or unsafe schemes: %j", (url) => {
    expect(safePublicUrl(url)).toBeNull();
  });

  test.each([
    "localhost",
    "LOCALHOST.",
    "localhost..",
    "app.localhost",
    "localhost.localdomain",
    "app.localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "intranet",
    "printer.local",
    "%6cocalhost",
    "0.0.0.0",
    "0.10.20.30",
    "10.0.0.1",
    "127.0.0.1",
    "127.2.3.4",
    "127.1",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "127.0.0.1.",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "[::]",
    "[::1]",
    "[0:0:0:0:0:0:0:1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:a00:1]",
    "[::192.168.1.1]",
    "[fc00::1]",
    "[fd12:3456::1]",
    "[fe80::1]",
    "[febf::1]",
    "[fec0::1]",
    "[ff02::1]",
    "[64:ff9b::7f00:1]",
    "[2001:db8::1]",
    "[2001::1]",
    "[2002:7f00:1::1]",
    "[3fff::1]",
    "[fe80::1%25eth0]",
  ])("rejects local/private/reserved hosts without DNS: %s", (host) => {
    expect(safePublicUrl(`https://${host}/`)).toBeNull();
  });

  test.each([
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "198.20.0.1",
  ])("does not overmatch IPv4 private subnet boundaries: %s", (host) => {
    expect(safePublicUrl(`https://${host}/`)).toBe(`https://${host}/`);
  });
});

describe("displayHost", () => {
  test("shows a canonical host and optional port, without paths or credentials", () => {
    expect(displayHost("https://Example.org/paper?q=term")).toBe("example.org");
    expect(displayHost("https://example.org:8443/paper")).toBe(
      "example.org:8443",
    );
    expect(displayHost("https://münich.example/")).toBe(
      "xn--mnich-kva.example",
    );
    expect(displayHost("https://user:secret@example.org/")).toBe("");
    expect(displayHost("http://localhost/")).toBe("");
    expect(displayHost("not a URL")).toBe("");
  });
});
