import {
  resolveGmailImapCreds,
  resolveImapCreds,
  resolveZohoCreds,
} from '../config/credentials.js';
import { resolveImapEndpoint } from '../config/appConfig.js';
import type { DestinationConfig, SourceConfig } from '../core/types.js';
import { GmailImapDestination } from './destination/GmailImapDestination.js';
import { ImapSource } from './source/ImapSource.js';
import { ZohoMailApiSource } from './source/ZohoMailApiSource.js';

export function createSource(source: SourceConfig): ZohoMailApiSource | ImapSource {
  if (source.type === 'zoho-api') {
    const creds = resolveZohoCreds(source.credentialsRef, source.name);
    return new ZohoMailApiSource({
      dc: creds.dc,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: creds.refreshToken,
      accountId: creds.accountId,
    });
  }

  const endpoint = resolveImapEndpoint(source);
  const creds = resolveImapCreds(source.credentialsRef, source.name);
  return new ImapSource({
    name: source.name,
    host: endpoint.host,
    port: endpoint.port,
    tls: endpoint.tls,
    email: creds.email,
    appPassword: creds.appPassword,
  });
}

export function createDestination(destination: DestinationConfig): GmailImapDestination {
  const creds = resolveGmailImapCreds(destination.credentialsRef, destination.name);
  return new GmailImapDestination({
    email: creds.email,
    appPassword: creds.appPassword,
  });
}
