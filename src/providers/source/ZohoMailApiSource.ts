import axios, { AxiosInstance } from 'axios';
import { MessageMetadata, MessageRef, SourceProvider, SyncCheckpoint } from '../../core/types.js';

export interface ZohoConfig {
  dc: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId?: string;
}

const TOKEN_REFRESH_SAFETY_MS = 60_000; // refresh a minute before expiry

export class ZohoMailApiSource implements SourceProvider {
  public name = 'zoho';
  private http: AxiosInstance;
  private accessToken?: string;
  private tokenExpiresAt = 0;
  private accountId?: string;

  constructor(private config: ZohoConfig) {
    this.http = axios.create({ timeout: 30_000 });
    this.accountId = config.accountId;

    // Auto-refresh on 401 once per request
    this.http.interceptors.response.use(
      (r) => r,
      async (err) => {
        const cfg = err.config;
        if (err.response?.status === 401 && cfg && !cfg._retried) {
          cfg._retried = true;
          await this.refreshAccessToken();
          cfg.headers = { ...cfg.headers, Authorization: `Zoho-oauthtoken ${this.accessToken}` };
          return this.http.request(cfg);
        }
        return Promise.reject(err);
      }
    );
  }

  private getAccountsUrl() {
    return `https://mail.zoho.${this.config.dc}/api/accounts`;
  }

  private getRefreshTokenUrl() {
    return `https://accounts.zoho.${this.config.dc}/oauth/v2/token`;
  }

  async connect(): Promise<void> {
    if (!this.isTokenValid()) await this.refreshAccessToken();
    if (!this.accountId) this.accountId = await this.discoverAccountId();
  }

  async disconnect(): Promise<void> {
    // No explicit disconnect needed for HTTP; token is retained for the next run.
  }

  private isTokenValid(): boolean {
    return !!this.accessToken && this.tokenExpiresAt > Date.now() + TOKEN_REFRESH_SAFETY_MS;
  }

  private async refreshAccessToken(): Promise<void> {
    const params = new URLSearchParams({
      refresh_token: this.config.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
    });

    const resp = await axios.post(this.getRefreshTokenUrl(), params, { timeout: 30_000 });
    this.accessToken = resp.data.access_token;
    const expiresIn = Number(resp.data.expires_in) || 3600;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000;

    this.http.defaults.headers.common['Authorization'] = `Zoho-oauthtoken ${this.accessToken}`;
  }

  private async discoverAccountId(): Promise<string> {
    try {
      const resp = await this.http.get(this.getAccountsUrl());
      const accounts = resp.data.data;
      if (!accounts || accounts.length === 0) {
        throw new Error('No Zoho accounts found');
      }
      return accounts[0].accountId;
    } catch (err: any) {
      if (err.response) {
        throw new Error(
          `Zoho discoverAccountId failed: ${err.response.status} - ${JSON.stringify(err.response.data)}`
        );
      }
      throw err;
    }
  }

  async getAccountId(): Promise<string> {
    if (!this.accountId) await this.connect();
    return this.accountId!;
  }

  async listCandidateMessages(
    checkpoint: SyncCheckpoint,
    options?: { folders?: string[]; excludeFolders?: string[]; limit?: number }
  ): Promise<MessageMetadata[]> {
    const accountId = await this.getAccountId();

    const folders = await this.getFolders(accountId);
    const defaultExcludes = new Set(['Spam', 'Trash']);
    const folderFilter = options?.folders;
    const excludeNames = new Set(options?.excludeFolders ?? [...defaultExcludes]);
    const targetFolders = folders.filter(
      (f) =>
        (folderFilter === undefined || folderFilter.includes(f.folderName)) &&
        !excludeNames.has(f.folderName)
    );

    const since = checkpoint.lastReceivedAt ? new Date(checkpoint.lastReceivedAt) : undefined;
    const hardCap = options?.limit;
    const allMessages: MessageMetadata[] = [];

    for (const folder of targetFolders) {
      const url = `https://mail.zoho.${this.config.dc}/api/accounts/${accountId}/messages/view`;
      const limitPerPage = 200; // Zoho's documented max per page
      let start = 1;
      let iterations = 0;
      let reachedCheckpoint = false;

      while (!reachedCheckpoint) {
        if (++iterations > 1000) {
          throw new Error('Circuit breaker triggered: Too many pagination requests to Zoho');
        }

        const params: any = {
          folderId: folder.folderId,
          start,
          limit: limitPerPage,
          sortBy: 'date',
          sortorder: 'false', // descending: newest first, so we can early-stop at checkpoint
          status: 'all',
          threadedMails: 'false',
        };

        let messages: any[];
        try {
          const resp = await this.http.get(url, { params });
          messages = resp.data.data || [];
        } catch (err: any) {
          if (err.response) {
            throw new Error(
              `Zoho view messages failed for folder ${folder.folderName}: ${err.response.status} - ${JSON.stringify(err.response.data)}`
            );
          }
          throw err;
        }

        if (!Array.isArray(messages) || messages.length === 0) break;

        for (const m of messages) {
          const receivedAt = new Date(parseInt(m.receivedTime || m.receivedtime));
          if (since && receivedAt < since) {
            reachedCheckpoint = true;
            break;
          }
          allMessages.push({
            id: m.messageId,
            receivedAt,
            subject: m.subject,
            from: m.sender,
            folderId: folder.folderId,
            folderName: folder.folderName,
            rawSize: parseInt(m.size),
          });
          if (hardCap !== undefined && allMessages.length >= hardCap) {
            reachedCheckpoint = true;
            break;
          }
        }

        if (messages.length < limitPerPage) break; // reached end of folder
        start += messages.length;
      }
    }

    return allMessages.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  private async getFolders(accountId: string): Promise<any[]> {
    try {
      const resp = await this.http.get(
        `https://mail.zoho.${this.config.dc}/api/accounts/${accountId}/folders`
      );
      return resp.data.data || [];
    } catch (err: any) {
      if (err.response) {
        throw new Error(
          `Zoho getFolders failed: ${err.response.status} - ${JSON.stringify(err.response.data)}`
        );
      }
      throw err;
    }
  }

  async fetchRawMessage(messageRef: MessageRef): Promise<Buffer> {
    const url = `https://mail.zoho.${this.config.dc}/api/accounts/${messageRef.accountId}/messages/${messageRef.id}/originalmessage`;
    const resp = await this.http.get(url);
    // Zoho returns original MIME in the "content" field of the originalmessage response
    const rawMime = resp.data.data.content;
    return Buffer.from(rawMime, 'utf-8');
  }
}
