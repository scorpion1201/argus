export type ProbeStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface ProbeNodeResult {
  id: string;
  name: string;
  region?: string;
  latencyMs?: number;
  lossPct?: number;
  status: ProbeStatus;
  message?: string;
  checkedAt: string;
  raw?: Record<string, unknown>;
}

export interface ProbeResponse {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    down: number;
    unknown: number;
    avgLatencyMs: number | null;
  };
  nodes: ProbeNodeResult[];
  stderr?: string;
  error?: string;
  raw?: unknown;
}
