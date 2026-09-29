import {useEffect, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {AUGMENT_LEVELS} from './level';
import type {OcrScan,ScoreResult} from './main';
import './overlay.css';

export type OverlayCandidate = {id: string; name: string; description: string; score?: number; reason?: string; risks?: string[]; rarity?: string; category?: string};
export type OverlayState = {
  level: number | null;
  status: 'idle' | 'capturing' | 'ocr' | 'matched' | 'error';
  message: string;
  lines: string[];
  candidates: OverlayCandidate[];
};

const RARITY_LABEL: Record<string, string> = {silver: '银', gold: '金', prismatic: '棱彩'};
const CATEGORY_LABEL: Record<string, string> = {damage: '输出', utility: '功能', defense: '防御', economy: '经济'};

const initial: OverlayState = {
  level: null,
  status: 'idle',
  message: '等待等级触发',
  lines: [],
  candidates: [],
};

export function OverlayApp() {
  const [state, setState] = useState<OverlayState>(initial);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke('overlay_ready', {level: null}).catch(() => undefined);
    let active = true;
    let stop: (() => void) | undefined;
    let stopOcr: (() => void) | undefined;
    void listen<{level: number}>('overlay:level', (event) => {
      if (!active) return;
      const level = event.payload?.level ?? null;
      setCollapsed(false); // Rust 侧主动弹出，前端跟随展开
      setState((current) => ({...current, level, lines: [], status: 'capturing', message: '已检测到海克斯等级，截屏识别中…'}));
    })
      .then((unlisten) => (active ? (stop = unlisten) : unlisten()))
      .catch(() => {
        if (active) setState((current) => ({...current, status: 'error', message: '无法接收主窗口事件'}));
      });
    let stopCollapsed: (() => void) | undefined;
    void listen<{collapsed: boolean; reason?: string}>('overlay:collapsed', (event) => {
      if (!active) return;
      if (event.payload?.collapsed) setCollapsed(true); // 无人交互自动收起
    })
      .then((unlisten) => (active ? (stopCollapsed = unlisten) : unlisten()))
      .catch(() => undefined);
    void listen<{level: number; scan?: OcrScan; error?: string}>('overlay:ocr', (event) => {
      if (!active) return;
      const {scan, error} = event.payload ?? {};
      if (error) {
        setState((current) => ({...current, status: 'error', message: error, lines: []}));
        return;
      }
      const lines = scan?.lines ?? [];
      setState((current) => ({
        ...current,
        status: 'ocr',
        message: `识别完成 · ${lines.length} 条文本 · ${scan?.elapsedMs ?? 0}ms`,
        lines: lines.map((line) => line.text),
      }));
    })
      .then((unlisten) => (active ? (stopOcr = unlisten) : unlisten()))
      .catch(() => undefined);
    let stopScored: (() => void) | undefined;
    void listen<{level: number; ranking?: ScoreResult}>('overlay:scored', (event) => {
      if (!active) return;
      const ranking = event.payload?.ranking?.ranking ?? [];
      if (!ranking.length) return;
      setState((current) => ({
        ...current,
        status: 'matched',
        message: event.payload?.ranking?.summary || '本地规则排序完成',
        lines: [],
        candidates: ranking.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          score: item.score,
          reason: item.reason,
          risks: item.risks,
          rarity: item.rarity,
          category: item.category,
        })),
      }));
    })
      .then((unlisten) => (active ? (stopScored = unlisten) : unlisten()))
      .catch(() => undefined);
    return () => {
      active = false;
      stop?.();
      stopOcr?.();
      stopScored?.();
      stopCollapsed?.();
    };
  }, []);

  const close = () => {
    if (isTauri()) void invoke('overlay_close').catch(() => undefined);
  };

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (isTauri()) void invoke('overlay_set_collapsed', {collapsed: next}).catch(() => undefined);
  };

  const band = state.level === null ? null : AUGMENT_LEVELS.includes(state.level as 1 | 7 | 11 | 15) ? state.level : null;

  if (collapsed) {
    return (
      <div className="overlay-root is-collapsed">
        <button className="overlay-handle" onClick={toggleCollapse} aria-label="展开侧栏" title="展开海克斯侧栏">
          <span className="overlay-handle-mark">◇</span>
          <span className="overlay-handle-text">HEXGLOW</span>
          {band !== null && <span className="overlay-handle-level">Lv.{band}</span>}
        </button>
      </div>
    );
  }

  return (
    <div className="overlay-root">
      <section className="overlay-card">
        <header className="overlay-head">
          <div>
            <span className="overlay-brand">HEXGLOW</span>
            <strong>海克斯推荐</strong>
          </div>
          <span className="overlay-level">{band ? `Lv.${band}` : '待触发'}</span>
          <div className="overlay-actions">
            <button className="overlay-close" onClick={toggleCollapse} aria-label="折叠侧栏" title="折叠为竖条">
              –
            </button>
            <button className="overlay-close" onClick={close} aria-label="关闭侧栏" title="关闭">
              ×
            </button>
          </div>
        </header>
        <p className="overlay-status" data-status={state.status}>
          <i />
          {state.message}
        </p>
        <div className="overlay-list">
          {state.candidates.length ? (
            state.candidates.map((candidate, index) => (
              <article className={index === 0 ? 'overlay-item top' : 'overlay-item'} key={candidate.id}>
                <div className="overlay-item-head">
                  <span className="overlay-rank">{String(index + 1).padStart(2, '0')}</span>
                  <h3>{candidate.name}</h3>
                  {typeof candidate.score === 'number' && <b className="overlay-score">{candidate.score}</b>}
                </div>
                {typeof candidate.score === 'number' && (
                  <span className="overlay-meter">
                    <i style={{width: `${Math.max(6, Math.min(100, candidate.score))}%`}} />
                  </span>
                )}
                <div className="overlay-chips">
                  {candidate.rarity && <span className={`chip rarity-${candidate.rarity}`}>{RARITY_LABEL[candidate.rarity] ?? candidate.rarity}</span>}
                  {candidate.category && <span className="chip">{CATEGORY_LABEL[candidate.category] ?? candidate.category}</span>}
                </div>
                <p className="overlay-effect">{candidate.description}</p>
                {candidate.reason && <small className="overlay-reason">{candidate.reason}</small>}
                {!!candidate.risks?.length && <small className="overlay-risks">⚠ {candidate.risks.join('；')}</small>}
              </article>
            ))
          ) : state.lines.length ? (
            <div className="overlay-empty">
              <span>◇</span>
              <p>识别到的屏幕文本：</p>
              <div className="overlay-lines">
                {state.lines.map((line, index) => (
                  <small key={`${index}-${line}`}>{line}</small>
                ))}
              </div>
              <small>下一步将按本地规则匹配候选。</small>
            </div>
          ) : (
            <div className="overlay-empty">
              <span>◇</span>
              <p>截屏识别后，候选海克斯会按本地规则排序显示在这里。</p>
              <small>不展示胜率 · 结果仅本机可见</small>
            </div>
          )}
        </div>
        <footer className="overlay-foot">等级 1 / 7 / 11 / 15 自动触发</footer>
      </section>
    </div>
  );
}
