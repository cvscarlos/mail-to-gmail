import fs from 'fs';
import YAML from 'yaml';

export interface LoadedYamlConfig {
  destinations: unknown[];
  sources: unknown[];
}

export function loadYamlConfig(path: string): LoadedYamlConfig {
  if (!fs.existsSync(path)) {
    return { destinations: [], sources: [] };
  }
  const parsed = YAML.parse(fs.readFileSync(path, 'utf-8')) as
    | { destinations?: unknown[]; sources?: unknown[] }
    | undefined
    | null;
  return {
    destinations: parsed?.destinations ?? [],
    sources: parsed?.sources ?? [],
  };
}

export function saveYamlConfig(path: string, config: LoadedYamlConfig): void {
  const yaml = YAML.stringify(config, { indent: 2, lineWidth: 0 });
  fs.writeFileSync(path, yaml);
}

export function hasDuplicate(entries: Array<{ name?: string }>, name: string): boolean {
  return entries.some((e) => e.name === name);
}

export function appendEnvKeys(
  envPath: string,
  entries: Array<{ key: string; value: string }>
): void {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const existingKeys = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.split('=')[0]?.trim())
      .filter(Boolean)
  );

  const toAppend = entries.filter((e) => !existingKeys.has(e.key));
  if (toAppend.length === 0) return;

  const suffix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const block = toAppend.map((e) => `${e.key}=${e.value}`).join('\n') + '\n';
  fs.appendFileSync(envPath, `${suffix}${block}`);
}
