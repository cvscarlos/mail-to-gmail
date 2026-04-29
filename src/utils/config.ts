import { z } from 'zod';

const configSchema = z.object({
  APP_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  STATE_DB_PATH: z.string().default('./mail-to-gmail.db'),
  CONFIG_PATH: z.string().default('./config.yaml'),
  DRY_RUN: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false),
});

type AppEnv = z.infer<typeof configSchema>;

export const loadAppEnv = (): AppEnv => {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
};
