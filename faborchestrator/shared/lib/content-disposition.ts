/**
 * Build a `Content-Disposition: attachment` header value that is safe for ANY
 * filename, including non-Latin scripts (Tamil, Chinese, …).
 *
 * Why this exists: Node/undici require header values to be ByteStrings
 * (code points ≤ 255). Putting a raw Tamil filename in the header throws
 * "Cannot convert argument to a ByteString …", which surfaced as a silent
 * download failure. Per RFC 6266 / RFC 5987 the header carries an ASCII
 * fallback in `filename=` and the real UTF-8 name, percent-encoded, in
 * `filename*=`. Modern browsers prefer `filename*` and save the original name.
 */
export function contentDispositionAttachment(filename: string): string {
  const name = (filename || "download").trim() || "download";

  // ASCII fallback: replace anything outside printable ASCII (and the quote /
  // backslash, which would break the quoted-string) with "_". Collapse runs so
  // a fully non-ASCII name becomes "_" + extension rather than "__________".
  let ascii = name
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/[\s_]*_[\s_]*/g, "_");
  if (ascii === "_" || ascii === "") ascii = "download";
  // Keep the extension recognisable when the stem was entirely non-ASCII.
  if (/^_?\.[A-Za-z0-9]+$/.test(ascii)) ascii = `download${ascii.replace(/^_/, "")}`;

  const isAscii = /^[\x20-\x7E]*$/.test(name) && !/["\\]/.test(name);
  if (isAscii) return `attachment; filename="${ascii}"`;

  // RFC 5987 ext-value: UTF-8, percent-encoded. encodeURIComponent leaves
  // `!'()*` unencoded, which are attr-char-legal, so the result is valid.
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
