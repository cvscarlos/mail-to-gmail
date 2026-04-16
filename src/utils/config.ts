import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  APP_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  STATE_DB_PATH: z.string().default('./mail-bridge.db'),

  ZOHO_DC: z.enum(['com', 'eu', 'in', 'com.au', 'com.cn']).default('com'),
  ZOHO_CLIENT_ID: z.string(),
  ZOHO_CLIENT_SECRET: z.string(),
  ZOHO_REFRESH_TOKEN: z.string(),
  ZOHO_ACCOUNT_ID: z.string().optional(),

  GMAIL_EMAIL: z.string().email(),
  GMAIL_APP_PASSWORD: z.string(),
  GMAIL_TARGET_MAILBOX: z.string().default('INBOX'),

  SYNC_LOOKBACK_DAYS: z.coerce.number().default(1),
  MAX_MESSAGES_PER_RUN: z.coerce.number().default(100),
  CONCURRENCY: z.coerce.number().default(5),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(300),

  DRY_RUN: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false),
  FILTER_CONFIG_PATH: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (): Config => {
  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid configuration:', result.error.flatten().fieldErrors);
    process.exit(1);
  }

  return result.data;
};
