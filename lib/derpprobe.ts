import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProbeNodeResult, ProbeResponse, ProbeStatus } from './types';

const DEFAULT_TIMEOUT_MS = 75_000;
const MIN_ONCE_TIMEOUT_MS = 65_000;
const PROBE_WINDOW_SIZE = 10;
const CALIBRATION_WINDOW_MINS = 10;
const CALIBRATION_FALLBACK_MS = 10;
const CALIBRATION_WARMUP_MINS = 2;

type NodeProbeSample = {
  success: boolean;
  latencyMs?: number;
};

type DelayPoint = {
  timestamp: number;
  rtt: number;
};

type LatencyCalibrator = (currentRtt: number, currentTime: number) => number;

const nodeProbeHistory = new Map<string, NodeProbeSample[]>();
const nodeLatencyCalibrators = new Map<string, LatencyCalibrator>();

function createLatencyCalibrator(
  windowMins: number,
  fallbackMs: number,
  warmupMins: number
): LatencyCalibrator {
  const windowSize = windowMins * 60 * 1000;
  const warmupPeriod = warmupMins * 60 * 1000;
  const startTime = Date.now();
  const deque: DelayPoint[] = [];

  return (currentRtt: number, currentTime: number): number => {
    while (deque.length > 0 && currentTime - deque[0].timestamp > windowSize) {
      deque.shift();
    }

    while (deque.length > 0 && deque[deque.length - 1].rtt >= currentRtt) {
      deque.pop();
    }

    deque.push({ timestamp: currentTime, rtt: currentRtt });

    let baseline = deque[0]?.rtt ?? currentRtt;
    if (currentTime - startTime < warmupPeriod && baseline > fallbackMs) {
      baseline = fallbackMs;
    }

    const netDelay = Math.max(0, currentRtt - baseline);
    return Number(netDelay.toFixed(2));
  };
}

function getNodeLatencyCalibrator(nodeId: string): LatencyCalibrator {
  const existing = nodeLatencyCalibrators.get(nodeId);
  if (existing) {
    return existing;
  }

  const created = createLatencyCalibrator(
    CALIBRATION_WINDOW_MINS,
    CALIBRATION_FALLBACK_MS,
    CALIBRATION_WARMUP_MINS
  );
  nodeLatencyCalibrators.set(nodeId, created);
  return created;
}

function parseArgs(argsText: string): string[] {
  if (!argsText.trim()) {
    return ['-once'];
  }

  return argsText
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token !== '-json' && token !== '--json' && !token.startsWith('--json='));
}

function hasDerpMapFlag(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '-derp-map' || token === '--derp-map') {
      return true;
    }
    if (token.startsWith('-derp-map=') || token.startsWith('--derp-map=')) {
      return true;
    }
  }
  return false;
}

function appendDerpMapArg(args: string[], derpMap: string | undefined): string[] {
  if (!derpMap || !derpMap.trim()) {
    return args;
  }
  if (hasDerpMapFlag(args)) {
    return args;
  }
  return [...args, '-derp-map', derpMap.trim()];
}

function hasOnceFlag(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '-once' || token === '--once') {
      return true;
    }
    if (token.startsWith('-once=') || token.startsWith('--once=')) {
      return true;
    }
  }
  return false;
}

function resolveTimeoutMs(baseTimeoutMs: number, args: string[]): number {
  if (hasOnceFlag(args) && baseTimeoutMs < MIN_ONCE_TIMEOUT_MS) {
    return MIN_ONCE_TIMEOUT_MS;
  }
  return baseTimeoutMs;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function summarize(nodes: ProbeNodeResult[]): ProbeResponse['summary'] {
  const summary = {
    total: nodes.length,
    healthy: 0,
    degraded: 0,
    down: 0,
    unknown: 0,
    avgLatencyMs: null as number | null
  };

  let latencyTotal = 0;
  let latencyCount = 0;

  for (const node of nodes) {
    summary[node.status] += 1;

    if (typeof node.latencyMs === 'number') {
      latencyTotal += node.latencyMs;
      latencyCount += 1;
    }
  }

  summary.avgLatencyMs = latencyCount > 0 ? Math.round(latencyTotal / latencyCount) : null;
  return summary;
}

function updateNodeLossFromHistory(nodes: ProbeNodeResult[]): void {
  const now = Date.now();
  for (const node of nodes) {
    if (typeof node.latencyMs === 'number') {
      const calibrator = getNodeLatencyCalibrator(node.id);
      node.latencyMs = calibrator(node.latencyMs, now);
    }

    const success = node.status === 'healthy' || node.status === 'degraded';
    const history = nodeProbeHistory.get(node.id) ?? [];
    history.push({ success, latencyMs: node.latencyMs });
    if (history.length > PROBE_WINDOW_SIZE) {
      history.splice(0, history.length - PROBE_WINDOW_SIZE);
    }
    nodeProbeHistory.set(node.id, history);

    const successCount = history.filter((sample) => sample.success).length;
    const successRate = successCount / history.length;
    node.lossPct = Math.round((1 - successRate) * 100);

    const latencySamples = history
      .map((sample) => sample.latencyMs)
      .filter((value): value is number => typeof value === 'number');
    if (latencySamples.length > 0) {
      const avg = latencySamples.reduce((total, value) => total + value, 0) / latencySamples.length;
      node.avgLatencyMs = avg >= 1 ? Math.round(avg) : Number(avg.toFixed(2));
    } else {
      node.avgLatencyMs = undefined;
    }
  }
}

function parseLatencyMs(text: string): number | undefined {
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(ms|µs|μs|us)\b/i);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const unit = match[2].toLowerCase();
  const valueMs = unit === 'ms' ? Math.round(value) : Number((value / 1000).toFixed(2));
  return Number.isFinite(valueMs) ? valueMs : undefined;
}

function normalizeProbeMessage(probeType: string, resultText: string): string {
  if (probeType === 'udp6' && resultText.includes('network is unreachable')) {
    return 'udp6: network is unreachable';
  }
  return `${probeType}: ${resultText}`;
}

function stripLogPrefix(line: string): string {
  return line.replace(/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+/, '').trim();
}

function loadRegionIdMapFromDerpMap(derpMapLocation?: string): Map<string, number> {
  if (!derpMapLocation || !derpMapLocation.trim()) {
    return new Map();
  }

  try {
    const path = derpMapLocation.startsWith('file://')
      ? fileURLToPath(derpMapLocation)
      : derpMapLocation;
    const content = readFileSync(path, 'utf8');
    const parsed = JSON.parse(content) as { Regions?: Record<string, unknown> };
    const regions = parsed.Regions;
    if (!regions || typeof regions !== 'object') {
      return new Map();
    }

    const map = new Map<string, number>();
    for (const value of Object.values(regions)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const region = value as Record<string, unknown>;
      const regionCode =
        typeof region.RegionCode === 'string' ? region.RegionCode.trim().toLowerCase() : '';
      const regionId = toNumber(region.RegionID);
      if (!regionCode || regionId === undefined) {
        continue;
      }
      map.set(regionCode, regionId);
    }
    return map;
  } catch {
    return new Map();
  }
}

function regionSortValue(node: ProbeNodeResult, regionIdMap: Map<string, number>): number | undefined {
  const codeFromName = node.name.trim().toLowerCase();
  const codeFromId = node.id.split('-')[0]?.trim().toLowerCase();
  const codeFromRegion = (node.region || '').trim().toLowerCase();
  return (
    regionIdMap.get(codeFromName) ??
    regionIdMap.get(codeFromId) ??
    regionIdMap.get(codeFromRegion)
  );
}

function parseNodesFromProbeLog(
  stderr: string,
  checkedAt: string,
  regionIdMap: Map<string, number>
): ProbeNodeResult[] {
  const lines = stderr
    .split('\n')
    .map((line) => stripLogPrefix(line))
    .filter(Boolean);
  const isIpv6UnsupportedNetwork = lines.some(
    (line) =>
      line.includes('/udp6:') &&
      line.includes('network is unreachable') &&
      (line.includes('write udp [::]') || line.includes('dial udp [::]'))
  );

  type TempNode = {
    id: string;
    name: string;
    region?: string;
    good: number;
    bad: number;
    badUdp6: number;
    nonUdp6Error: boolean;
    udpLatencyMs?: number;
    messages: string[];
  };

  const map = new Map<string, TempNode>();
  const lineRegex = /^(good|bad):\s+derp\/([^:]+):\s*(.+)$/;

  for (const line of lines) {
    const match = line.match(lineRegex);
    if (!match) {
      continue;
    }

    const level = match[1];
    const path = match[2];
    const resultText = match[3];
    const segments = path.split('/');
    if (segments.length < 3) {
      continue;
    }

    const shortRegion = segments[0];
    const cloudRegion = segments[1];
    const probeType = segments[segments.length - 1];
    const id = `${shortRegion}-${cloudRegion}`;
    const node = map.get(id) || {
      id,
      name: shortRegion,
      region: cloudRegion,
      good: 0,
      bad: 0,
      badUdp6: 0,
      nonUdp6Error: false,
      udpLatencyMs: undefined,
      messages: []
    };

    if (level === 'good') {
      node.good += 1;
      if (probeType === 'udp') {
        const latency = parseLatencyMs(resultText);
        if (latency !== undefined) {
          node.udpLatencyMs = latency;
        }
      }
    } else {
      node.bad += 1;
      node.messages.push(normalizeProbeMessage(probeType, resultText));
      if (probeType === 'udp6' && resultText.includes('network is unreachable')) {
        if (!isIpv6UnsupportedNetwork) {
          node.badUdp6 += 1;
        }
      } else {
        node.nonUdp6Error = true;
      }
    }

    map.set(id, node);
  }

  const nodes: ProbeNodeResult[] = [];
  for (const node of map.values()) {
    let status: ProbeStatus = 'unknown';
    if (node.nonUdp6Error || (node.bad > 0 && node.good === 0)) {
      status = 'down';
    } else if (node.badUdp6 > 0) {
      status = 'degraded';
    } else if (node.good > 0) {
      status = 'healthy';
    }

    nodes.push({
      id: node.id,
      name: node.name,
      region: node.region,
      latencyMs: node.udpLatencyMs,
      status,
      message: node.messages.length > 0 ? node.messages.join(' | ') : undefined,
      checkedAt
    });
  }

  nodes.sort((a, b) => {
    const aOrder = regionSortValue(a, regionIdMap);
    const bOrder = regionSortValue(b, regionIdMap);

    if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    if (aOrder !== undefined && bOrder === undefined) {
      return -1;
    }
    if (aOrder === undefined && bOrder !== undefined) {
      return 1;
    }

    if (a.name !== b.name) {
      return a.name.localeCompare(b.name);
    }
    return (a.region || '').localeCompare(b.region || '');
  });

  return nodes;
}

export async function runDerpprobe(): Promise<ProbeResponse> {
  const startedAt = Date.now();
  const command = process.env.DERPPROBE_BIN || 'derpprobe';
  const args = appendDerpMapArg(
    parseArgs(process.env.DERPPROBE_ARGS || ''),
    process.env.DERPPROBE_DERP_MAP
  );
  const configuredTimeoutMs = toNumber(process.env.DERPPROBE_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = resolveTimeoutMs(configuredTimeoutMs, args);
  const regionIdMap = loadRegionIdMapFromDerpMap(process.env.DERPPROBE_DERP_MAP);

  return await new Promise<ProbeResponse>((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env
    });

    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');

      const checkedAt = new Date().toISOString();
      resolve({
        ok: false,
        checkedAt,
        durationMs: Date.now() - startedAt,
        summary: {
          total: 0,
          healthy: 0,
          degraded: 0,
          down: 0,
          unknown: 0,
          avgLatencyMs: null
        },
        nodes: [],
        stderr,
        error: `derpprobe timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err: Error) => {
      if (settled) {
        return;
      }

      clearTimeout(timeout);
      settled = true;
      const checkedAt = new Date().toISOString();

      resolve({
        ok: false,
        checkedAt,
        durationMs: Date.now() - startedAt,
        summary: {
          total: 0,
          healthy: 0,
          degraded: 0,
          down: 0,
          unknown: 0,
          avgLatencyMs: null
        },
        nodes: [],
        stderr,
        error: err.message
      });
    });

    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }

      clearTimeout(timeout);
      settled = true;

      const checkedAt = new Date().toISOString();
      const nodes = parseNodesFromProbeLog(stderr, checkedAt, regionIdMap);
      updateNodeLossFromHistory(nodes);
      const summary = summarize(nodes);
      const ok = code === 0 || (code === 1 && nodes.every(node => node.status === 'healthy'));

      resolve({
        ok,
        checkedAt,
        durationMs: Date.now() - startedAt,
        summary,
        nodes,
        stderr: stderr.trim() || undefined,
        error:
          !ok && code !== null
            ? `derpprobe exited with code ${code}`
            : !ok
              ? 'derpprobe exited with an unknown error'
              : undefined
      });
    });
  });
}
