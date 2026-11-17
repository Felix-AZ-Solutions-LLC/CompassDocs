// A request body read up to a byte limit and no further (1.20.27, security
// review L5). `req.text()` buffers the whole body before anyone can look at
// its size, so a chunked body without a Content-Length was read whole before
// being refused (capped only by Next's own 10 MB clone limit). This reader
// refuses a declared size over the limit at once and stops reading a
// streamed one the moment it passes the limit. Answers null when too big.
// Shared by the helpdesk JSON reader, the portal's, the chat apps', the
// OAuth registration and the MCP endpoint.

export async function readTextCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
}
