// ImapFlow rejects failed IMAP commands with a generic `Error('Command failed')`
// and stashes the useful detail on extra properties (the server's text response,
// the IMAP status word, and the command that was sent — already credential-safe
// because ImapFlow compiles it with isLogging:true). Plain `err.message` throws
// all of that away, which makes production failures undebuggable. This helper
// pulls the extra fields into the logged string.
interface ImapFlowError extends Error {
  responseText?: string;
  responseStatus?: string;
  executedCommand?: string;
  serverResponseCode?: string;
  code?: string;
}

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as ImapFlowError;
  const parts = [e.message];
  if (e.responseText) parts.push(`response="${e.responseText}"`);
  if (e.responseStatus) parts.push(`status=${e.responseStatus}`);
  if (e.serverResponseCode) parts.push(`serverCode=${e.serverResponseCode}`);
  else if (e.code) parts.push(`code=${e.code}`);
  // executedCommand carries the IMAP verb (LIST/SEARCH/APPEND/…) which pins down
  // *which* operation failed. Keep only the first token to avoid logging args.
  if (e.executedCommand) {
    const verb = e.executedCommand.trim().split(/\s+/).slice(0, 2).join(' ');
    parts.push(`command="${verb}"`);
  }
  return parts.join(' ');
}
