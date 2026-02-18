'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ProbeNodeResult, ProbeResponse } from '@/lib/types';

const REFRESH_MS = 15_000;
const THEME_STORAGE_KEY = 'argus-theme-mode';

type ThemeMode = 'light' | 'dark' | 'system';

const statusLabels: Record<ProbeNodeResult['status'], string> = {
  healthy: '정상',
  degraded: '지연',
  down: '장애',
  unknown: '미확인'
};

const statusClass = (status: ProbeNodeResult['status']): string => {
  if (status === 'healthy') return 'status status-healthy';
  if (status === 'degraded') return 'status status-degraded';
  if (status === 'down') return 'status status-down';
  return 'status status-unknown';
};

const formatMs = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '-';
  if (value <= 0.4) {
    return '0 ms';
  }
  if (value < 1) {
    const rounded = Number(value.toFixed(2));
    if (rounded === 0) {
      return '0 ms';
    }
    return `${rounded.toFixed(2)} ms`;
  }
  return `${Math.round(value)} ms`;
};

const ThemeIcon = ({ mode }: { mode: ThemeMode }) => {
  if (mode === 'light') {
    return (
      <span className="theme-icon" aria-hidden>
        ☀
      </span>
    );
  }

  if (mode === 'dark') {
    return (
      <span className="theme-icon" aria-hidden>
        ☾
      </span>
    );
  }

  return (
    <svg
      className="theme-icon theme-icon-svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3.5" y="4.5" width="17" height="11.5" rx="1.8" />
      <path d="M9.2 19.5h5.6" />
      <path d="M12 16v3.5" />
    </svg>
  );
};

const Dashboard = () => {
  const [data, setData] = useState<ProbeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [themeFabOpen, setThemeFabOpen] = useState(false);

  const applyTheme = useCallback((mode: ThemeMode) => {
    document.documentElement.setAttribute('color-theme', mode);
  }, []);

  const fetchProbe = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/probe', { cache: 'no-store' });
      const json = (await response.json()) as ProbeResponse;
      setData(json);

      if (!response.ok) {
        setError(json.error || json.stderr || 'derpprobe 실행 중 오류가 발생했습니다.');
      } else {
        setError(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '네트워크 오류';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProbe();
  }, [fetchProbe]);

  useEffect(() => {
    if (!autoUpdate) {
      return;
    }
    const timer = window.setInterval(fetchProbe, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [fetchProbe, autoUpdate]);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    const initialTheme: ThemeMode =
      savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system' ? savedTheme : 'system';
    setThemeMode(initialTheme);
    applyTheme(initialTheme);
  }, [applyTheme]);

  const onChangeTheme = useCallback(
    (mode: ThemeMode) => {
      setThemeMode(mode);
      applyTheme(mode);
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    },
    [applyTheme]
  );

  const nodes = data?.nodes ?? [];
  const checkedAtText = data?.checkedAt
    ? new Date(data.checkedAt).toLocaleString('ko-KR')
    : '아직 없음';
  return (
    <div className="page">
      <div className={themeFabOpen ? 'theme-fab is-open' : 'theme-fab'}>
        <div className="theme-fab-menu" role="group" aria-label="컬러 모드">
          <button
            type="button"
            className={themeMode === 'light' ? 'theme-btn is-active' : 'theme-btn'}
            onClick={() => {
              onChangeTheme('light');
              setThemeFabOpen(false);
            }}
            aria-label="Light mode"
            title="Light mode"
          >
            <ThemeIcon mode="light" />
          </button>
          <button
            type="button"
            className={themeMode === 'dark' ? 'theme-btn is-active' : 'theme-btn'}
            onClick={() => {
              onChangeTheme('dark');
              setThemeFabOpen(false);
            }}
            aria-label="Dark mode"
            title="Dark mode"
          >
            <ThemeIcon mode="dark" />
          </button>
          <button
            type="button"
            className={themeMode === 'system' ? 'theme-btn is-active' : 'theme-btn'}
            onClick={() => {
              onChangeTheme('system');
              setThemeFabOpen(false);
            }}
            aria-label="System mode"
            title="System mode"
          >
            <ThemeIcon mode="system" />
          </button>
        </div>
        <button
          type="button"
          className="theme-fab-toggle"
          onClick={() => setThemeFabOpen((prev) => !prev)}
          aria-label="Select color scheme"
          title="Select color scheme"
          aria-expanded={themeFabOpen}
        >
          <ThemeIcon mode={themeMode} />
        </button>
      </div>
      <div className="content-stack">
        <section className="hero">
          <div>
            <p className="eyebrow">ARGUS</p>
            <h1>DERP Control Plane</h1>
            <p className="subtitle">DERP(Designated Encrypted Relay for Packets) 서버 지표들을 수집해 시각화합니다.</p>
          </div>
          <div className="hero-controls">
            <button
              type="button"
              className={autoUpdate ? 'auto-badge auto-toggle is-active' : 'auto-badge auto-toggle'}
              onClick={() => setAutoUpdate((prev) => !prev)}
              aria-live="polite"
            >
              <span className="auto-icon" aria-hidden>
                ↻
              </span>
              {autoUpdate ? '자동 업데이트' : '수동 업데이트'}
            </button>
            <button className="refresh-btn" onClick={fetchProbe} disabled={loading || autoUpdate}>
              {loading || autoUpdate ? '수집 중...' : '지금 새로고침'}
            </button>
          </div>
        </section>

        <section className="grid">
          <article className="card">
            <p className="card-label">전체 노드</p>
            <p className="card-value">{data?.summary.total ?? 0}</p>
          </article>
          <article className="card ok">
            <p className="card-label">정상</p>
            <p className="card-value">{data?.summary.healthy ?? 0}</p>
          </article>
          <article className="card warn">
            <p className="card-label">지연</p>
            <p className="card-value">{data?.summary.degraded ?? 0}</p>
          </article>
          <article className="card err">
            <p className="card-label">장애</p>
            <p className="card-value">{data?.summary.down ?? 0}</p>
          </article>
        </section>

        <section className="panel">
          <div className="panel-top">
            <h2>실시간 상태</h2>
            <p>
              평균 지연시간: <strong>{formatMs(data?.summary.avgLatencyMs)}</strong> · <strong>{checkedAtText}</strong>
            </p>
          </div>

          {error && <div className="alert">오류: {error}</div>}

          <div className="table-wrap">
            <table>
              <colgroup>
                <col className="col-node" />
                <col className="col-region" />
                <col className="col-status" />
                <col className="col-latency" />
                <col className="col-latency" />
                <col className="col-loss" />
                <col className="col-message" />
              </colgroup>
              <thead>
                <tr>
                  <th className="col-center">노드</th>
                  <th className="col-center">리전</th>
                  <th className="col-center">상태</th>
                  <th className="col-center">지연시간</th>
                  <th className="col-center">평균 지연시간</th>
                  <th className="col-center">손실률</th>
                  <th className="col-message-head">메시지</th>
                </tr>
              </thead>
              <tbody>
                {nodes.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      표시할 노드 데이터가 없습니다.
                    </td>
                  </tr>
                )}

                {nodes.map((node) => (
                  <tr key={node.id}>
                    <td className="col-center">{node.name}</td>
                    <td className="col-center">{node.region || '-'}</td>
                    <td className="col-center">
                      <span className={statusClass(node.status)}>{statusLabels[node.status]}</span>
                    </td>
                    <td className="col-center">{formatMs(node.latencyMs)}</td>
                    <td className="col-center">{formatMs(node.avgLatencyMs)}</td>
                    <td className="col-center">{node.lossPct !== undefined ? `${node.lossPct}%` : '-'}</td>
                    <td className={node.message ? 'col-message-cell' : 'col-message-cell col-message-empty'}>
                      {node.message || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <footer className="footer">
        <p>2026 © Seongwoo Park. All Rights Reserved.</p>
      </footer>
    </div>
  );
};

export default Dashboard;
