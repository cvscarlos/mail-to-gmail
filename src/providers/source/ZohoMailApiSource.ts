import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';
import {
  type ListOptions,
  type MessageMetadata,
  type MessageRef,
  type RestoreRef,
  type SourceProvider,
  type SyncCheckpoint,
} from '../../core/types.js';

export interface ZohoConfig {
  dc: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId?: string;
}

interface ZohoAccount {
  accountId: string;
}

interface ZohoFolder {
  folderId: string;
  folderName: string;
}

interface ZohoMessageListEntry {
  messageId: string;
  subject?: string;
  sender?: string;
  receivedTime?: string;
  receivedtime?: string;
  size?: string;
}

interface ZohoTokenResponse {
  access_token: string;
  expires_in: number | string;
}

interface ZohoOriginalMessageResponse {
  data: { content: string };
}

interface ZohoListResponse<T> {
  data: T[];
}

interface RetryableRequest extends AxiosRequestConfig {
  _retried?: boolean;
}

const TOKEN_REFRESH_SAFETY_MS = 60_000;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const MESSAGES_PER_PAGE = 200;
const PAGINATION_CIRCUIT_BREAKER = 1000;
const DEFAULT_EXCLUDES = new Set(['Spam', 'Trash']);

function axiosErrorDetails(err: unknown, context: string): Error {
  const axErr = err as AxiosError | undefined;
  if (axErr?.response) {
    return new Error(
      `${context}: ${axErr.response.status} - ${JSON.stringify(axErr.response.data)}`
    );
  }
  if (err instanceof Error) return err;
  return new Error(`${context}: ${String(err)}`);
}

export class ZohoMailApiSource implements SourceProvider {
  public readonly name = 'zoho';
  private readonly config: ZohoConfig;
  private readonly http: AxiosInstance;
  private accessToken?: string;
  private tokenExpiresAt = 0;
  private accountId?: string;
  private inboxFolderId?: string;

  constructor(config: ZohoConfig) {
    this.config = config;
    this.accountId = config.accountId;
    this.http = axios.create({ timeout: 30_000 });

    this.http.interceptors.response.use(
      (r) => r,
      async (err: AxiosError) => {
        const cfg = err.config as RetryableRequest | undefined;
        if (err.response?.status === 401 && cfg && !cfg._retried) {
          cfg._retried = true;
          await this.refreshAccessToken();
          cfg.headers = {
            ...cfg.headers,
            Authorization: `Zoho-oauthtoken ${this.accessToken}`,
          };
          return this.http.request(cfg);
        }
        return Promise.reject(err);
      }
    );
  }

  public async connect(): Promise<void> {
    if (!this.isTokenValid()) await this.refreshAccessToken();
    if (!this.accountId) this.accountId = await this.discoverAccountId();
  }

  public async disconnect(): Promise<void> {
    // HTTP client has no connection state; the access token is kept for the next run.
  }

  public async getAccountId(): Promise<string> {
    if (!this.accountId) await this.connect();
    if (!this.accountId) throw new Error('Zoho account ID unavailable after connect');
    return this.accountId;
  }

  public async listCandidateMessages(
    checkpoint: SyncCheckpoint,
    options?: ListOptions
  ): Promise<MessageMetadata[]> {
    const accountId = await this.getAccountId();
    const folders = await this.getFolders(accountId);

    const includeFolders = options?.folders;
    const excludeFolders = new Set(options?.excludeFolders ?? [...DEFAULT_EXCLUDES]);
    const targetFolders = folders.filter(
      (f) =>
        (!includeFolders ||
          includeFolders.includes('*') ||
          includeFolders.includes(f.folderName)) &&
        !excludeFolders.has(f.folderName)
    );

    const since = checkpoint.lastReceivedAt ? new Date(checkpoint.lastReceivedAt) : undefined;
    const hardCap = options?.limit;
    const collected: MessageMetadata[] = [];

    for (const folder of targetFolders) {
      await this.paginateFolder(accountId, folder, since, hardCap, collected);
      if (hardCap !== undefined && collected.length >= hardCap) break;
    }

    return collected.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  public async fetchRawMessage(messageRef: MessageRef): Promise<Buffer> {
    const accountId = await this.getAccountId();
    const url = `https://mail.zoho.${this.config.dc}/api/accounts/${accountId}/messages/${messageRef.id}/originalmessage`;
    const resp = await this.http.get<ZohoOriginalMessageResponse>(url);
    const rawMime = resp.data.data.content;
    return Buffer.from(rawMime, 'utf-8');
  }

  public async deleteMessage(messageRef: MessageRef): Promise<void> {
    const accountId = await this.getAccountId();
    const url = `https://mail.zoho.${this.config.dc}/api/accounts/${accountId}/updatemessage`;
    try {
      await this.http.put(url, {
        mode: 'moveToTrash',
        messageId: [messageRef.id],
      });
    } catch (err) {
      throw axiosErrorDetails(err, `Zoho moveToTrash failed for ${messageRef.id}`);
    }
  }

  public async restoreMessage(ref: RestoreRef): Promise<void> {
    const accountId = await this.getAccountId();
    const inboxFolderId = await this.getInboxFolderId(accountId);
    const url = `https://mail.zoho.${this.config.dc}/api/accounts/${accountId}/updatemessage`;
    try {
      await this.http.put(url, {
        mode: 'moveToFolder',
        destfolderid: inboxFolderId,
        messageId: [ref.sourceMessageId],
      });
    } catch (err) {
      throw axiosErrorDetails(err, `Zoho moveToFolder(Inbox) failed for ${ref.sourceMessageId}`);
    }
  }

  private async getInboxFolderId(accountId: string): Promise<string> {
    if (this.inboxFolderId) return this.inboxFolderId;
    const folders = await this.getFolders(accountId);
    const inbox = folders.find((f) => f.folderName.toLowerCase() === 'inbox');
    if (!inbox) throw new Error('Zoho Inbox folder not found');
    this.inboxFolderId = inbox.folderId;
    return inbox.folderId;
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

    const resp = await axios.post<ZohoTokenResponse>(
      `https://accounts.zoho.${this.config.dc}/oauth/v2/token`,
      params,
      { timeout: 30_000 }
    );

    this.accessToken = resp.data.access_token;
    const expiresInSeconds = Number(resp.data.expires_in) || DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    this.tokenExpiresAt = Date.now() + expiresInSeconds * 1000;
    this.http.defaults.headers.common['Authorization'] = `Zoho-oauthtoken ${this.accessToken}`;
  }

  private async discoverAccountId(): Promise<string> {
    try {
      const resp = await this.http.get<ZohoListResponse<ZohoAccount>>(
        `https://mail.zoho.${this.config.dc}/api/accounts`
      );
      const accounts = resp.data.data;
      if (!accounts || accounts.length === 0) throw new Error('No Zoho accounts found');
      return accounts[0].accountId;
    } catch (err) {
      throw axiosErrorDetails(err, 'Zoho discoverAccountId failed');
    }
  }

  private async getFolders(accountId: string): Promise<ZohoFolder[]> {
    try {
      const resp = await this.http.get<ZohoListResponse<ZohoFolder>>(
        `https://mail.zoho.${this.config.dc}/api/accounts/${accountId}/folders`
      );
      return resp.data.data ?? [];
    } catch (err) {
      throw axiosErrorDetails(err, 'Zoho getFolders failed');
    }
  }

  private async paginateFolder(
    accountId: string,
    folder: ZohoFolder,
    since: Date | undefined,
    hardCap: number | undefined,
    collected: MessageMetadata[]
  ): Promise<void> {
    const url = `https://mail.zoho.${this.config.dc}/api/accounts/${accountId}/messages/view`;
    let start = 1;
    let iterations = 0;

    while (true) {
      if (++iterations > PAGINATION_CIRCUIT_BREAKER) {
        throw new Error('Zoho pagination circuit breaker triggered');
      }

      const params = {
        folderId: folder.folderId,
        start,
        limit: MESSAGES_PER_PAGE,
        sortBy: 'date',
        sortorder: 'false',
        status: 'all',
        threadedMails: 'false',
      };

      let messages: ZohoMessageListEntry[];
      try {
        const resp = await this.http.get<ZohoListResponse<ZohoMessageListEntry>>(url, { params });
        messages = resp.data.data ?? [];
      } catch (err) {
        throw axiosErrorDetails(err, `Zoho view messages failed for ${folder.folderName}`);
      }

      if (messages.length === 0) return;

      for (const m of messages) {
        const receivedAt = new Date(Number(m.receivedTime ?? m.receivedtime ?? 0));
        if (since && receivedAt < since) return;
        collected.push({
          id: m.messageId,
          receivedAt,
          subject: m.subject,
          from: m.sender,
          folderId: folder.folderId,
          folderName: folder.folderName,
          rawSize: m.size !== undefined ? Number(m.size) : undefined,
        });
        if (hardCap !== undefined && collected.length >= hardCap) return;
      }

      if (messages.length < MESSAGES_PER_PAGE) return;
      start += messages.length;
    }
  }
}
