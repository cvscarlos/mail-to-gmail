import axios, { AxiosInstance } from 'axios';
import { MessageMetadata, MessageRef, SourceProvider, SyncCheckpoint } from '../../core/types.js';

export interface ZohoConfig {
  dc: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId?: string;
}

export class ZohoMailApiSource implements SourceProvider {
  public name = 'zoho';
  private http: AxiosInstance;
  private accessToken?: string;
  private accountId?: string;

  constructor(private config: ZohoConfig) {
    this.http = axios.create();
    this.accountId = config.accountId;
  }

  private getAccountsUrl() {
    return `https://mail.zoho.${this.config.dc}/api/accounts`;
  }

  private getRefreshTokenUrl() {
    return `https://accounts.zoho.${this.config.dc}/oauth/v2/token`;
  }

  async connect(): Promise<void> {
    await this.refreshAccessToken();
    if (!this.accountId) {
      this.accountId = await this.discoverAccountId();
    }
  }

  async disconnect(): Promise<void> {
    // No explicit disconnect needed for HTTP
  }

  private async refreshAccessToken(): Promise<void> {
    const params = new URLSearchParams({
      refresh_token: this.config.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
    });

    const resp = await axios.post(this.getRefreshTokenUrl(), params);
    this.accessToken = resp.data.access_token;

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
    options?: { folders?: string[]; limit?: number }
  ): Promise<MessageMetadata[]> {
    const accountId = await this.getAccountId();

    // For v1, we only list from Inbox if folders are not specified
    const folderNames = options?.folders || ['Inbox'];
    const folders = await this.getFolders(accountId);

    const targetFolders = folders.filter((f) => folderNames.includes(f.folderName));

    let allMessages: MessageMetadata[] = [];

    for (const folder of targetFolders) {
      const url = `https://mail.zoho.${this.config.dc}/api/accounts/${accountId}/messages/view`;

      let start = 1;
      // Zoho doc max is 200
      const limitPerPage = Math.min(options?.limit || 200, 200);
      let hasMore = true;

      let iterations = 0;
      while (hasMore && allMessages.length < (options?.limit || Infinity)) {
        iterations++;
        if (iterations > 1000) {
          throw new Error('Circuit breaker triggered: Too many pagination requests to Zoho');
        }

        const params: any = {
          folderId: folder.folderId,
          start: start,
          limit: limitPerPage,
          sortBy: 'date',
          sortorder: 'false', // descending
          status: 'all',
          threadedMails: 'false',
        };

        try {
          const resp = await this.http.get(url, { params });
          const messages = resp.data.data || [];

          if (!Array.isArray(messages) || messages.length === 0) {
            hasMore = false;
            break;
          }

          allMessages = allMessages.concat(
            messages.map((m: any) => ({
              id: m.messageId,
              receivedAt: new Date(parseInt(m.receivedTime || m.receivedtime)),
              subject: m.subject,
              from: m.sender,
              folderId: folder.folderId,
              folderName: folder.folderName,
              rawSize: parseInt(m.size),
            }))
          );

          start += messages.length;

          // Stop if we fetched less than we asked for, meaning we hit the end of the folder
          if (messages.length < limitPerPage) {
            hasMore = false;
          }
        } catch (err: any) {
          if (err.response) {
            throw new Error(
              `Zoho view messages failed for folder ${folder.folderName}: ${err.response.status} - ${JSON.stringify(err.response.data)}`
            );
          }
          throw err;
        }
      }
    }

    // Filter by checkpoint if available
    if (checkpoint.lastReceivedAt) {
      const since = new Date(checkpoint.lastReceivedAt);
      allMessages = allMessages.filter((m) => m.receivedAt >= since);
    }

    // Sort by receivedAt ascending for deterministic processing
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
