import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/main/config-store';
import type { ConnectionProfile } from '../src/shared/types';

const profile: ConnectionProfile = { id: 'one', name: 'Studio Mac', host: 'mac.local', port: 5900, scale: 'fit', transmissionScale: 'original', viewOnly: false };
let directory: string;
let path: string;
let store: ConfigStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'maclink-settings-'));
  path = join(directory, 'connections.json');
  store = new ConfigStore(path);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('ConfigStore', () => {
  it('starts empty and round trips profiles without preserving credentials', async () => {
    expect(await store.load()).toEqual({ version: 1, connections: [] });
    await store.save([{ ...profile, password: 'never persist this', username: 'secret user' } as ConnectionProfile]);
    expect(await store.load()).toEqual({ version: 1, connections: [profile] });
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain('password');
    expect(text).not.toContain('secret user');
  });

  it('serializes overlapping saves and supports deleting the last connection', async () => {
    const last = { ...profile, name: 'Last write', scale: 'actual' as const };
    await Promise.all([store.save([profile]), store.save([last])]);
    expect((await store.load()).connections).toEqual([last]);
    await store.save([]);
    expect((await store.load()).connections).toEqual([]);
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loads old version-one profiles as original transmission without rewriting them', async () => {
    const legacy: Partial<ConnectionProfile> = { ...profile };
    delete legacy.transmissionScale;
    const original = JSON.stringify({ version: 1, connections: [legacy] });
    await writeFile(path, original);
    expect(await store.load()).toEqual({ version: 1, connections: [profile] });
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('persists half transmission independently of display scaling', async () => {
    const half: ConnectionProfile = { ...profile, scale: 'actual', transmissionScale: 'half' };
    await store.save([half]);
    expect(await store.load()).toEqual({ version: 1, connections: [half] });
  });

  it.each(['{broken', JSON.stringify({ version: 2, connections: [] }), JSON.stringify({ version: 1, connections: [{ id: 'invalid' }] })])(
    'preserves an unreadable or incompatible configuration: %s', async (original) => {
      await writeFile(path, original);
      await expect(store.load()).rejects.toThrow('原文件已保留');
      await expect(store.save([profile])).rejects.toThrow('原文件已保留');
      expect(await readFile(path, 'utf8')).toBe(original);
    },
  );

  it('checks an existing configuration even if save is called before load', async () => {
    await writeFile(path, '{bad');
    await expect(new ConfigStore(path).save([profile])).rejects.toThrow('原文件已保留');
    expect(await readFile(path, 'utf8')).toBe('{bad');
  });

  it('rejects malformed profile values at the persistence boundary', () => {
    expect(() => store.save([{ ...profile, port: 0 }])).toThrow('端口');
    expect(() => store.save([profile, profile])).toThrow('重复');
    expect(() => store.save([{ ...profile, transmissionScale: 'quarter' } as unknown as ConnectionProfile])).toThrow('显示设置');
  });
});
