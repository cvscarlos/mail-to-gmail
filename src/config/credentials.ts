export interface ZohoCreds {
  dc: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId?: string;
}

export interface ImapCreds {
  email: string;
  appPassword: string;
}

export interface GmailImapCreds {
  email: string;
  appPassword: string;
}

function requireEnv(ref: string, suffix: string, contextName: string): string {
  const key = `${ref}_${suffix}`;
  const val = process.env[key];
  if (!val) {
    throw new Error(
      `Missing environment variable "${key}" (required by "${contextName}"). Check your .env.`
    );
  }
  return val;
}

function optionalEnv(ref: string, suffix: string): string | undefined {
  const val = process.env[`${ref}_${suffix}`];
  return val === '' ? undefined : val;
}

export function resolveZohoCreds(ref: string, sourceName: string): ZohoCreds {
  const dc = optionalEnv(ref, 'DC') ?? 'com';
  const allowed = new Set(['com', 'eu', 'in', 'com.au', 'com.cn']);
  if (!allowed.has(dc)) {
    throw new Error(
      `Invalid ${ref}_DC="${dc}" (source "${sourceName}"). Must be one of: ${[...allowed].join(', ')}.`
    );
  }
  return {
    dc,
    clientId: requireEnv(ref, 'CLIENT_ID', sourceName),
    clientSecret: requireEnv(ref, 'CLIENT_SECRET', sourceName),
    refreshToken: requireEnv(ref, 'REFRESH_TOKEN', sourceName),
    accountId: optionalEnv(ref, 'ACCOUNT_ID'),
  };
}

export function resolveImapCreds(ref: string, sourceName: string): ImapCreds {
  return {
    email: requireEnv(ref, 'EMAIL', sourceName),
    appPassword: requireEnv(ref, 'APP_PASSWORD', sourceName),
  };
}

export function resolveGmailImapCreds(ref: string, destinationName: string): GmailImapCreds {
  return {
    email: requireEnv(ref, 'EMAIL', destinationName),
    appPassword: requireEnv(ref, 'APP_PASSWORD', destinationName),
  };
}
