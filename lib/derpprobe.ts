import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProbeNodeResult, ProbeResponse, ProbeStatus } from './types';

const DEFAULT_TIMEOUT_MS = 75_000;
const MIN_ONCE_TIMEOUT_MS = 65_000;

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

function normalizeStatus(latencyMs?: number, lossPct?: number, err?: string): ProbeStatus {
  if (err && err.length > 0) {
    return 'down';
  }
  if (latencyMs === undefined) {
    return 'unknown';
  }
  if (lossPct !== undefined && lossPct >= 20) {
    return 'degraded';
  }
  if (latencyMs >= 180) {
    return 'degraded';
  }
  return 'healthy';
}

function flattenObjects(input: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];

  function visit(node: unknown): void {
    if (!node) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      out.push(obj);
      Object.values(obj).forEach(visit);
    }
  }

  visit(input);
  return out;
}

function pickNodeRecords(raw: unknown): ProbeNodeResult[] {
  const checkedAt = new Date().toISOString();
  const objects = flattenObjects(raw);

  const seen = new Set<string>();
  const nodes: ProbeNodeResult[] = [];

  for (const obj of objects) {
    const id =
      (typeof obj.id === 'string' && obj.id) ||
      (typeof obj.node === 'string' && obj.node) ||
      (typeof obj.name === 'string' && obj.name) ||
      (typeof obj.regionCode === 'string' && obj.regionCode) ||
      '';

    const latencyMs =
      toNumber(obj.latencyMs) ??
      toNumber(obj.latency_ms) ??
      toNumber(obj.latency) ??
      toNumber(obj.pingMs);

    const lossPct =
      toNumber(obj.lossPct) ?? toNumber(obj.loss_pct) ?? toNumber(obj.packetLossPct);

    const err =
      (typeof obj.error === 'string' && obj.error) ||
      (typeof obj.err === 'string' && obj.err) ||
      (typeof obj.message === 'string' && obj.message) ||
      undefined;

    if (!id && latencyMs === undefined && lossPct === undefined && !err) {
      continue;
    }

    const key = id || JSON.stringify(obj);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const status = normalizeStatus(latencyMs, lossPct, err);
    nodes.push({
      id: id || `node-${nodes.length + 1}`,
      name:
        (typeof obj.name === 'string' && obj.name) ||
        (typeof obj.nodeName === 'string' && obj.nodeName) ||
        id ||
        `Node ${nodes.length + 1}`,
      region:
        (typeof obj.region === 'string' && obj.region) ||
        (typeof obj.regionName === 'string' && obj.regionName) ||
        (typeof obj.regionCode === 'string' && obj.regionCode) ||
        undefined,
      latencyMs,
      lossPct,
      status,
      message: err,
      checkedAt,
      raw: obj
    });
  }

  return nodes;
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

function parseOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const parsedLines: unknown[] = [];
    for (const line of lines) {
      try {
        parsedLines.push(JSON.parse(line));
      } catch {
        // skip non-JSON lines
      }
    }

    if (parsedLines.length > 0) {
      return parsedLines;
    }

    return { text };
  }
}

function parseLatencyMs(text: string): number | undefined {
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)ms/);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.round(value) : undefined;
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

  type TempNode = {
    id: string;
    name: string;
    region?: string;
    good: number;
    bad: number;
    badUdp6: number;
    nonUdp6Error: boolean;
    latencySamples: number[];
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
      latencySamples: [],
      messages: []
    };

    if (level === 'good') {
      node.good += 1;
      const latency = parseLatencyMs(resultText);
      if (latency !== undefined) {
        node.latencySamples.push(latency);
      }
    } else {
      node.bad += 1;
      node.messages.push(normalizeProbeMessage(probeType, resultText));
      if (probeType === 'udp6' && resultText.includes('network is unreachable')) {
        node.badUdp6 += 1;
      } else {
        node.nonUdp6Error = true;
      }
    }

    map.set(id, node);
  }

  const nodes: ProbeNodeResult[] = [];
  for (const node of map.values()) {
    const avgLatencyMs =
      node.latencySamples.length > 0
        ? Math.round(
            node.latencySamples.reduce((total, value) => total + value, 0) /
              node.latencySamples.length
          )
        : undefined;

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
      latencyMs: avgLatencyMs,
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

function isIpv6OnlyProbeFailure(stderr: string): boolean {
  const lines = stderr
    .split('\n')
    .map((line) => stripLogPrefix(line))
    .filter(Boolean);

  const badLines = lines.filter((line) => line.startsWith('bad: derp/'));
  if (badLines.length === 0) {
    return false;
  }

  const goodUdp6Lines = lines.filter((line) => line.startsWith('good: derp/') && line.includes('/udp6:'));
  const goodNonUdp6Lines = lines.filter(
    (line) => line.startsWith('good: derp/') && !line.includes('/udp6:')
  );
  if (goodUdp6Lines.length > 0 || goodNonUdp6Lines.length === 0) {
    return false;
  }

  const allBadAreUdp6Unreachable = badLines.every(
    (line) => line.includes('/udp6:') && line.includes('network is unreachable')
  );
  if (!allBadAreUdp6Unreachable) {
    return false;
  }

  const badNonUdp6Lines = badLines.filter((line) => !line.includes('/udp6:'));
  if (badNonUdp6Lines.length > 0) {
    return false;
  }

  // Host-side IPv6 미구성의 전형적인 에러 형태를 추가로 확인한다.
  return badLines.every((line) => line.includes('write udp [::]') || line.includes('dial udp [::]'));
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
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });

    let stdout = '';
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

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

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
      const raw = parseOutput(stdout);
      const rawNodes = pickNodeRecords(raw);
      const nodes =
        rawNodes.length > 0 ? rawNodes : parseNodesFromProbeLog(stderr, checkedAt, regionIdMap);
      const summary = summarize(nodes);
      const ok = code === 0 || (code === 1 && isIpv6OnlyProbeFailure(stderr));

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
              : undefined,
        raw
      });
    });
  });
}
