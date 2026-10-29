import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConnectionProfile, Settings } from '../shared/types';

function connection(value: unknown): ConnectionProfile {
  if (!value || typeof value !== 'object') throw new Error('连接条目格式错误。');
  const input = value as Partial<ConnectionProfile>;
  if (typeof input.id !== 'string' || !input.id || typeof input.name !== 'string' || !input.name.trim() ||
      typeof input.host !== 'string' || !input.host.trim() || !Number.isInteger(input.port) ||
      (input.port as number) < 1 || (input.port as number) > 65535 ||
      (input.scale !== 'fit' && input.scale !== 'actual') || typeof input.viewOnly !== 'boolean' ||
      (input.transmissionScale !== undefined && input.transmissionScale !== 'original' && input.transmissionScale !== 'half')) {
    throw new Error('连接条目缺少有效的名称、地址、端口或显示设置。');
  }
  // Persist only the public profile fields, never credentials supplied by a caller.
  return {
    id: input.id, name: input.name.trim(), host: input.host.trim(), port: input.port as number,
    scale: input.scale, transmissionScale: input.transmissionScale ?? 'original', viewOnly: input.viewOnly,
  };
}

function connections(value: unknown): ConnectionProfile[] {
  if (!Array.isArray(value)) throw new Error('连接列表格式错误。');
  const result = value.map(connection);
  if (new Set(result.map((profile) => profile.id)).size !== result.length) throw new Error('连接标识重复。');
  return result;
}

export class ConfigStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async load(): Promise<Settings> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1) {
        throw new Error('配置版本不受支持，请使用兼容版本打开。');
      }
      return { version: 1, connections: connections((data as Settings).connections) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, connections: [] };
      throw new Error(`无法读取连接配置，原文件已保留：${(error as Error).message}`);
    }
  }

  save(input: ConnectionProfile[]): Promise<void> {
    const profiles = connections(input);
    const write = this.writes.then(async () => {
      // Refuse to overwrite unreadable or newer settings, including before first load.
      await this.load();
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, connections: profiles }, null, 2)}\n`, 'utf8');
      await rename(temporary, this.path);
    });
    this.writes = write.then(() => undefined, () => undefined);
    return write;
  }
}
