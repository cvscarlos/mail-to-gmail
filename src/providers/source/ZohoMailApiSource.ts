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
      console.error(`Zoho discoverAccountId failed: ${err.response?.status} - ${JSON.stringify(err.response?.data)}`);
      throw err;
    }
  }

  async getAccountId(): Promise<string> {
    if (!this.accountId) await this.connect();
    return this.accountId!;
  }

  async listCandidateMessages(
    checkpoint: SyncCheckpoint,
    options?: { folders?: string[] }
  ): Promise<MessageMetadata[]> {
    const accountId = await this.getAccountId();

    // For v1, we only list from Inbox if folders are not specified
    const folderNames = options?.folders || ['Inbox'];
    const folders = await this.getFolders(accountId);

    const targetFolders = folders.filter((f) => folderNames.includes(f.folderName));

    let allMessages: MessageMetadata[] = [];

    for (const folder of targetFolders) {
      const url = `https://mail.zoho.${this.config.dc}/api/accounts/${accountId}/messages/view`;
      const params: any = {
        folderid: folder.folderId,
        limit: 100,
      };

      try {
        const resp = await this.http.get(url, { params });
        const messages = resp.data.data || [];

        allMessages = allMessages.concat(
          messages.map((m: any) => ({
            id: m.messageId,
            receivedAt: new Date(parseInt(m.receivedTime)),
            subject: m.subject,
            from: m.sender,
            folderId: folder.folderId,
            folderName: folder.folderName,
            rawSize: parseInt(m.size),
          }))
        );
      } catch (err: any) {
        console.error(`Zoho view messages failed for folder ${folder.folderName}: ${err.response?.status} - ${JSON.stringify(err.response?.data)}`);
        throw err;
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
      console.error(`Zoho getFolders failed: ${err.response?.status} - ${JSON.stringify(err.response?.data)}`);
      throw err;
    }
  }

  async fetchRawMessage(messageRef: MessageRef): Promise<Buffer> {
    const url = `https://mail.zoho.${this.config.dc}/api/accounts/${messageRef.accountId}/messages/${messageRef.id}/raw`;
    const resp = await this.http.get(url);
    // Zoho returns original MIME in the "content" field of the raw response
    const rawMime = resp.data.data.content;
    return Buffer.from(rawMime, 'utf-8');
  }
}
