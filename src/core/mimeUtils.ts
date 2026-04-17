function extractHeaderBlock(rawMime: Buffer): string {
  const str = rawMime.toString('latin1');
  const crlfEnd = str.indexOf('\r\n\r\n');
  const lfEnd = str.indexOf('\n\n');
  let end: number;
  if (crlfEnd >= 0 && (lfEnd < 0 || crlfEnd <= lfEnd)) {
    end = crlfEnd;
  } else if (lfEnd >= 0) {
    end = lfEnd;
  } else {
    end = str.length;
  }
  return str.slice(0, end);
}

function unfoldHeaders(block: string): string[] {
  const lines = block.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1] += ' ' + line.trim();
    } else {
      out.push(line);
    }
  }
  return out;
}

export function getHeader(rawMime: Buffer, name: string): string | undefined {
  const block = extractHeaderBlock(rawMime);
  const headers = unfoldHeaders(block);
  const prefix = name.toLowerCase() + ':';
  for (const h of headers) {
    if (h.toLowerCase().startsWith(prefix)) {
      return h.slice(prefix.length).trim();
    }
  }
  return undefined;
}

export function parseMessageId(rawMime: Buffer): string | undefined {
  const val = getHeader(rawMime, 'Message-ID');
  if (!val) return undefined;
  const m = val.match(/<([^>]+)>/);
  return m ? m[1] : val;
}

export function parseListId(rawMime: Buffer): string | undefined {
  const val = getHeader(rawMime, 'List-Id');
  if (!val) return undefined;
  const m = val.match(/<([^>]+)>/);
  return m ? m[1] : val;
}

export function injectHeader(rawMime: Buffer, name: string, value: string): Buffer {
  if (getHeader(rawMime, name) !== undefined) return rawMime;
  const prefix = Buffer.from(`${name}: ${value}\r\n`, 'latin1');
  return Buffer.concat([prefix, rawMime]);
}
