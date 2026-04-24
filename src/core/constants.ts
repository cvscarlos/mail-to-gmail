export const CONTENT_HASH_HEADER = 'X-M2G-Content-Hash';
export const SOURCE_NAME_HEADER = 'X-M2G-Source';
export const SOURCE_MESSAGE_ID_HEADER = 'X-M2G-Source-ID';
// Gmail label (exposed as an IMAP keyword). No slash — some clients and Gmail
// IMAP itself mishandle slash-hierarchical keywords when STORE creates them
// for the first time. Flat keyword is unambiguously a simple user label.
export const PROPAGATED_LABEL = 'mail-to-gmail-propagated';
