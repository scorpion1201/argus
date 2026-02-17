import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('node:child_process', () => ({
  spawn: jest.fn()
}));

jest.mock('node:fs', () => ({
  readFileSync: jest.fn()
}));

type MockChild = EventEmitter & {
  stderr: EventEmitter;
  kill: jest.Mock;
};

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

const baseEnv = { ...process.env };

async function loadRunDerpprobe() {
  const mod = await import('./derpprobe');
  return mod.runDerpprobe;
}

describe('Execute derpprobe fn', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...baseEnv };
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...baseEnv };
  });

  it('strips json args, appends derp-map, parses nodes, and treats code=1+healthy as ok', async () => {
    process.env.DERPPROBE_ARGS = '--json -once --foo bar';
    process.env.DERPPROBE_DERP_MAP = '/tmp/derp-map.json';

    const { spawn } = jest.requireMock('node:child_process') as {
      spawn: jest.Mock;
    };
    const { readFileSync } = jest.requireMock('node:fs') as {
      readFileSync: jest.Mock;
    };

    readFileSync.mockReturnValue(
      JSON.stringify({
        Regions: {
          SEA: { RegionCode: 'sea', RegionID: 1 },
          NYC: { RegionCode: 'nyc', RegionID: 2 }
        }
      })
    );

    const child = createMockChild();
    spawn.mockReturnValue(child);

    const runDerpprobe = await loadRunDerpprobe();
    const resultPromise = runDerpprobe();

    child.stderr.emit('data', Buffer.from('good: derp/nyc/us-east/udp: 31ms\n'));
    child.stderr.emit('data', Buffer.from('good: derp/sea/us-west/udp: 20ms\n'));
    child.emit('close', 1);

    const result = await resultPromise;

    expect(spawn).toHaveBeenCalledWith(
      'derpprobe',
      ['-once', '--foo', 'bar', '-derp-map', '/tmp/derp-map.json'],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] })
    );
    expect(readFileSync).toHaveBeenCalledWith('/tmp/derp-map.json', 'utf8');

    expect(result.ok).toBe(true);
    expect(result.summary.total).toBe(2);
    expect(result.summary.healthy).toBe(2);
    expect(result.summary.degraded).toBe(0);
    expect(result.summary.down).toBe(0);

    expect(result.nodes.map((node) => node.id)).toEqual(['sea-us-west', 'nyc-us-east']);
    expect(result.nodes.every((node) => node.status === 'healthy')).toBe(true);
    expect(result.nodes.every((node) => node.lossPct === 0)).toBe(true);
  });

  it('returns not ok with parsed down node and exit-code error message', async () => {
    process.env.DERPPROBE_ARGS = '-once';

    const { spawn } = jest.requireMock('node:child_process') as {
      spawn: jest.Mock;
    };

    const child = createMockChild();
    spawn.mockReturnValue(child);

    const runDerpprobe = await loadRunDerpprobe();
    const resultPromise = runDerpprobe();

    child.stderr.emit('data', Buffer.from('bad: derp/lhr/eu-west/tcp: i/o timeout\n'));
    child.emit('close', 2);

    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe('derpprobe exited with code 2');
    expect(result.summary.total).toBe(1);
    expect(result.summary.down).toBe(1);
    expect(result.nodes[0]?.status).toBe('down');
    expect(result.nodes[0]?.message).toContain('tcp: i/o timeout');
  });

  it('returns spawn error', async () => {
    const { spawn } = jest.requireMock('node:child_process') as {
      spawn: jest.Mock;
    };

    const child = createMockChild();
    spawn.mockReturnValue(child);

    const runDerpprobe = await loadRunDerpprobe();
    const resultPromise = runDerpprobe();

    child.emit('error', new Error('spawn failed'));

    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe('spawn failed');
    expect(result.nodes).toEqual([]);
    expect(result.summary.total).toBe(0);
  });

  it('enforces minimum timeout for -once and kills process on timeout', async () => {
    jest.useFakeTimers();

    process.env.DERPPROBE_ARGS = '-once';
    process.env.DERPPROBE_TIMEOUT_MS = '10';

    const { spawn } = jest.requireMock('node:child_process') as {
      spawn: jest.Mock;
    };

    const child = createMockChild();
    spawn.mockReturnValue(child);

    const runDerpprobe = await loadRunDerpprobe();
    const resultPromise = runDerpprobe();

    await jest.advanceTimersByTimeAsync(64_999);
    expect(child.kill).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('derpprobe timed out after 65000ms');
    expect(result.summary.total).toBe(0);
  });
});
