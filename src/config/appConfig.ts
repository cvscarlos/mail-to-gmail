import fs from 'fs';
import { z } from 'zod';
import YAML from 'yaml';
import type { AppConfig, DestinationConfig, SourceConfig } from '../core/types.js';

const nameRegex = /^[a-z][a-z0-9-]*$/;
const credentialsPrefixRegex = /^[A-Z][A-Z0-9_]*$/;

const scheduleSchema = z.object({
  intervalMinutes: z.number().positive(),
  lookbackDays: z.number().int().nonnegative(),
  maxMessagesPerRun: z.number().int().positive(),
});

const filterSchema = z
  .object({
    subjectContains: z.array(z.string()).optional(),
    fromContains: z.array(z.string()).optional(),
    toContains: z.array(z.string()).optional(),
    listIdContains: z.array(z.string()).optional(),
  })
  .default({});

const destinationSchema = z.object({
  name: z.string().regex(nameRegex, 'destination name: lowercase alphanumeric + hyphens'),
  credentialsPrefix: z.string().regex(credentialsPrefixRegex, 'credentialsPrefix: uppercase + underscores'),
  mailbox: z.string().default('INBOX'),
});

const zohoSourceSchema = z.object({
  name: z.string().regex(nameRegex, 'source name: lowercase alphanumeric + hyphens'),
  enabled: z.boolean().default(true),
  type: z.literal('zoho-api'),
  credentialsPrefix: z.string().regex(credentialsPrefixRegex),
  destination: z.string().regex(nameRegex),
  folders: z.array(z.string()).optional(),
  excludeFolders: z.array(z.string()).optional(),
  idle: z.literal(false).default(false),
  schedule: scheduleSchema,
  filter: filterSchema,
});

const imapSourceSchema = z.object({
  name: z.string().regex(nameRegex, 'source name: lowercase alphanumeric + hyphens'),
  enabled: z.boolean().default(true),
  type: z.literal('imap'),
  preset: z.enum(['yahoo', 'outlook']).optional(),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  tls: z.boolean().optional(),
  credentialsPrefix: z.string().regex(credentialsPrefixRegex),
  destination: z.string().regex(nameRegex),
  folders: z.array(z.string()).optional(),
  excludeFolders: z.array(z.string()).optional(),
  idle: z.boolean().default(false),
  idleFolder: z.string().default('INBOX'),
  schedule: scheduleSchema,
  filter: filterSchema,
});

const sourceSchema = z.discriminatedUnion('type', [zohoSourceSchema, imapSourceSchema]);

const appConfigSchema = z
  .object({
    destinations: z.array(destinationSchema).min(1, 'at least one destination is required'),
    sources: z.array(sourceSchema).min(1, 'at least one source is required'),
  })
  .superRefine((cfg, ctx) => {
    const destNames = new Set<string>();
    cfg.destinations.forEach((d, idx) => {
      if (destNames.has(d.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate destination name: "${d.name}"`,
          path: ['destinations', idx, 'name'],
        });
      }
      destNames.add(d.name);
    });

    const sourceNames = new Set<string>();
    cfg.sources.forEach((s, idx) => {
      if (sourceNames.has(s.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate source name: "${s.name}"`,
          path: ['sources', idx, 'name'],
        });
      }
      sourceNames.add(s.name);

      if (!destNames.has(s.destination)) {
        ctx.addIssue({
          code: 'custom',
          message: `Source "${s.name}" references unknown destination "${s.destination}". Known destinations: ${[...destNames].join(', ') || '(none)'}.`,
          path: ['sources', idx, 'destination'],
        });
      }

      if (s.type === 'imap' && !s.preset && !s.host) {
        ctx.addIssue({
          code: 'custom',
          message: `IMAP source "${s.name}" must specify either "preset" or "host".`,
          path: ['sources', idx],
        });
      }
    });
  });

export function loadAppConfig(path: string): AppConfig {
  if (!fs.existsSync(path)) {
    throw new Error(
      `Config file not found at "${path}". Copy config.example.yaml → config.yaml (or set CONFIG_PATH).`
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(path, 'utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid YAML in ${path}: ${message}`);
  }

  const result = appConfigSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`
    );
    throw new Error(`Invalid ${path}:\n${lines.join('\n')}`);
  }
  return result.data satisfies AppConfig;
}

export function getDestination(cfg: AppConfig, name: string): DestinationConfig {
  const dest = cfg.destinations.find((d) => d.name === name);
  if (!dest) {
    throw new Error(
      `Destination "${name}" not found. Known: ${cfg.destinations.map((d) => d.name).join(', ') || '(none)'}.`
    );
  }
  return dest;
}

export function getSource(cfg: AppConfig, name: string): SourceConfig {
  const src = cfg.sources.find((s) => s.name === name);
  if (!src) {
    throw new Error(
      `Source "${name}" not found. Known: ${cfg.sources.map((s) => s.name).join(', ') || '(none)'}.`
    );
  }
  return src;
}

export const IMAP_PRESETS: Record<string, { host: string; port: number; tls: boolean }> = {
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, tls: true },
  outlook: { host: 'outlook.office365.com', port: 993, tls: true },
};

export function resolveImapEndpoint(src: Extract<SourceConfig, { type: 'imap' }>): {
  host: string;
  port: number;
  tls: boolean;
} {
  if (src.preset) {
    const preset = IMAP_PRESETS[src.preset];
    return {
      host: src.host ?? preset.host,
      port: src.port ?? preset.port,
      tls: src.tls ?? preset.tls,
    };
  }
  return {
    host: src.host!,
    port: src.port ?? 993,
    tls: src.tls ?? true,
  };
}
