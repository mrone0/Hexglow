import {useEffect, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {AUGMENT_LEVELS,augmentRoundLabel} from './level';
import {type ScoredCandidate, type ScoreResult} from './liveRecommendation';
import {overlayPresentation} from './overlayPresentation';
import {normalizeRecommendationStatus, type RecommendationStatus} from './recommendationStatus';
import './overlay.css';

export type OverlayCandidate = ScoredCandidate;
export type OverlayState = {
  level: number | null;
  status: 'idle' | 'capturing' | 'ocr' | 'matched' | 'error';
  message: string;
  lines: string[];
  candidates: OverlayCandidate[];
  rankingReliable?: boolean;
  modelScoresValid?: boolean;
  profile?: ScoreResult['profile'];
  source?: ScoreResult['source'];
  contextChanged?: boolean;
  analysis?: RecommendationStatus;
};

const RARITY_LABEL: Record<string, string> = {silver: '银', gold: '金', prismatic: '棱彩'};
const CATEGORY_LABEL: Record<string, string> = {damage: '输出', utility: '功能', defense: '防御', economy: '经济'};

const initial: OverlayState = {
  level: null,
  status: 'idle',
  message: '等待识别结果',
  lines: [],
  candidates: [],
  rankingReliable: false,
};

export type OverlayPayload = {sequence: number; level: number | null; reset?: boolean; ranking: ScoreResult; analysis?: RecommendationStatus};
export type OverlayPublication = {sequence: number; state: OverlayState};

export function reduceOverlayPublication(current: OverlayPublication, payload: OverlayPayload | null): OverlayPublication {
  if (!payload || !Number.isSafeInteger(payload.sequence) || payload.sequence <= current.sequence) return current;
  return {
    sequence: payload.sequence,
    state: payload.reset || payload.level === null
      ? {...initial}
      : {level: payload.level, status: 'matched', message: payload.ranking?.summary || '候选已识别', lines: [], candidates: payload.ranking?.ranking ?? [], rankingReliable: payload.ranking?.rankingReliable === true, modelScoresValid:payload.ranking?.modelScoresValid === true, profile: payload.ranking?.profile, source: payload.ranking?.source, contextChanged: payload.ranking?.contextChanged === true, analysis: normalizeRecommendationStatus(payload.analysis)},
  };
}

export function OverlayCandidates({result, analysis}: {result: ScoreResult; analysis?: RecommendationStatus}) {
  const presentation = overlayPresentation(result, analysis);
  return <>{presentation.candidates.map((candidate, index) => (
    <article className={candidate.recommended ? 'overlay-item top' : 'overlay-item'} key={candidate.id}>
      <div className="overlay-item-meta">
        {candidate.rank !== null && <span className="overlay-rank">{candidate.tied ? '并列' : ''}第{candidate.rank}</span>}
        {candidate.rank === null && <span className="overlay-option">候选 {String(index + 1).padStart(2, '0')}</span>}
        {candidate.recommended && <span className="overlay-recommendation" title="当前候选中的模型评分最高，不代表胜率">{candidate.recommendationLabel}</span>}
        {candidate.alreadyOwned && <span className="overlay-analysis-note">已拥有</span>}
      </div>
      <div className="overlay-item-head">
        <h3>{candidate.name}</h3>
        <div className="overlay-score-block">
          {candidate.displayScore !== null
            ? <b className="overlay-score" aria-label={`模型比较分 ${candidate.displayScore}，非胜率`}>{candidate.displayScore}</b>
            : <span className="overlay-score-placeholder" aria-label={candidate.alreadyOwned ? '已拥有，不参与推荐' : result.source === 'model' ? '已分析 · 未评分' : '尚无模型评分'}>—</span>}
        </div>
      </div>
      <details className="overlay-details">
      <summary aria-label={`查看 ${candidate.name} 的完整效果与分析`}><span className="overlay-effect">{candidate.description}</span><span className="overlay-details-toggle">效果与分析 <i aria-hidden="true"/></span></summary>
      <span className="overlay-attributes">{[RARITY_LABEL[candidate.rarity] ?? candidate.rarity, CATEGORY_LABEL[candidate.category] ?? candidate.category].filter(Boolean).join(' · ')}</span>
      {candidate.reason && <small className="overlay-reason">{candidate.reason}</small>}
      {candidate.evidence.length > 0 && <ul className="overlay-evidence" aria-label="已知依据">{candidate.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      {!!candidate.risks?.length && <small className="overlay-risks">⚠ {candidate.risks.join('；')}</small>}
      </details>
    </article>
  ))}</>;
}

export function OverlayApp() {
  const [state, setState] = useState<OverlayState>(initial);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let publication: OverlayPublication = {sequence: -1, state: initial};
    const stops: (() => void)[] = [];
    const apply = (payload: OverlayPayload | null) => {
      if (!active) return;
      const next = reduceOverlayPublication(publication, payload);
      if (next === publication) return;
      publication = next;
      setState(next.state);
      if (payload?.reset) setCollapsed(false);
    };
    const subscribe = async <T,>(name: string, callback: (payload: T) => void) => {
      const stop = await listen<T>(name, event => {if (active) callback(event.payload);});
      if (active) stops.push(stop); else stop();
    };
    const register = async () => {
      await Promise.all([
        subscribe<OverlayPayload>('overlay:state', apply),
        subscribe<{level: number}>('overlay:level', payload => {setCollapsed(false);setState(current => ({...current, level: payload.level}));}),
        subscribe<{collapsed: boolean}>('overlay:collapsed', payload => setCollapsed(payload.collapsed)),
      ]);
      if (!active) return;
      // 先注册监听，再读取缓存；序号阻止较晚返回的旧快照覆盖新事件。
      apply(await invoke('overlay_ready', {level: null}));
    };
    void register().catch(error => {
      if (active) setState(current => ({...current, status: 'error', message: String(error)}));
    });
    return () => {active = false;stops.forEach(stop => stop());};
  }, []);

  const close = () => {
    if (isTauri()) void invoke('overlay_close').catch(() => undefined);
  };

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (isTauri()) void invoke('overlay_set_collapsed', {collapsed: next}).catch(() => undefined);
  };

  return <OverlayView state={state} collapsed={collapsed} onClose={close} onToggleCollapse={toggleCollapse}/>;
}

/** Pure view shared by the native sidebar and isolated visual fixtures. */
export function OverlayView({state, collapsed=false, onClose, onToggleCollapse}: {
  state: OverlayState;
  collapsed?: boolean;
  onClose: () => void;
  onToggleCollapse: () => void;
}) {
  const band = state.level === null ? null : AUGMENT_LEVELS.includes(state.level as 1 | 7 | 11 | 15) ? state.level : null;
  const result: ScoreResult = {ranking: state.candidates, summary: state.message, rankingReliable: state.rankingReliable, modelScoresValid:state.modelScoresValid, profile: state.profile, source: state.source,contextChanged:state.contextChanged};
  const presentation = overlayPresentation(result, state.analysis);
  const regionUnconfirmed=state.analysis?.code==='choice-region-unavailable'&&['waiting','analyzing'].includes(state.analysis.phase);
  const modeLabel = regionUnconfirmed?presentation.label:result.source==='model' && !presentation.candidates.some(candidate=>candidate.displayScore!==null)
    ? presentation.candidates.length>0 && presentation.candidates.every(candidate=>candidate.alreadyOwned) ? '本组均已拥有' : '已分析 · 未评分'
    : result.source!=='model' && state.analysis?.phase==='waiting' && state.analysis.code==='request-cooldown' ? '等待请求间隔' : presentation.label;
  const tone = state.status === 'error' ? 'failed' : regionUnconfirmed?'previous':result.source === 'model' ? state.contextChanged ? 'previous' : 'complete' : normalizeRecommendationStatus(state.analysis).phase;

  if (collapsed) {
    return (
      <div className="overlay-root is-collapsed">
        <button className="overlay-handle" onClick={onToggleCollapse} aria-label="展开侧栏" title="展开海克斯侧栏">
          <span className="overlay-handle-mark">◇</span>
          <span className="overlay-handle-text">HEXGLOW</span>
          {band !== null && <span className="overlay-handle-level">{augmentRoundLabel(band)}</span>}
        </button>
      </div>
    );
  }

  return (
    <div className="overlay-root">
      <section className="overlay-card" data-tone={tone}>
        <header className="overlay-head">
          <div className="overlay-title">
            <span className="overlay-brand">HEXGLOW</span>
            <strong>{result.source === 'model' ? '模型推荐' : '海克斯候选'}</strong>
          </div>
          <span className="overlay-level">{band ? augmentRoundLabel(band) : '待识别'}</span>
          <div className="overlay-actions">
            <button className="overlay-close" onClick={onToggleCollapse} aria-label="折叠侧栏" title="折叠为竖条">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 5 5-5 5"/></svg>
            </button>
            <button className="overlay-close" onClick={onClose} aria-label="关闭侧栏" title="关闭">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg>
            </button>
          </div>
        </header>
        <div className="overlay-context" role="status" aria-live="polite" aria-atomic="true">
          <div className="overlay-context-line">
            <span className="overlay-champion">{state.profile?.champion || '本轮选择'}</span>
            <span className="overlay-mode" title={state.candidates.length ? presentation.status : state.message}><i aria-hidden="true"/>{modeLabel}</span>
          </div>
          {(tone==='blocked'||tone==='failed'||state.status==='error') && <p className="overlay-status" data-status={state.status}>{state.status==='error' ? state.message : state.analysis?.message}</p>}
          {tone==='previous' && <p className="overlay-status">局势已变化，以下为此前评分。</p>}
        </div>
        <div className="overlay-list" tabIndex={0} aria-label="本轮海克斯候选，可滚动查看完整内容">
          {state.candidates.length ? (
            <OverlayCandidates result={result} analysis={state.analysis} />
          ) : state.lines.length ? (
            <div className="overlay-empty">
              <span>◇</span>
              <p>识别到的屏幕文本：</p>
              <div className="overlay-lines">
                {state.lines.map((line, index) => (
                  <small key={`${index}-${line}`}>{line}</small>
                ))}
              </div>
              <small>匹配候选后，可在主窗口手动分析，或在设置中开启自动推荐。</small>
            </div>
          ) : (
            <div className="overlay-empty">
              <span>◇</span>
              <p>截屏识别后显示候选与效果；自动推荐按已保存设置与数据授权触发。</p>
              <small>不展示胜率 · 结果仅本机可见</small>
            </div>
          )}
        </div>
        <footer className="overlay-foot"><span>{presentation.footnote}</span><span className="overlay-foot-hint" aria-hidden="true">点按效果展开</span></footer>
      </section>
    </div>
  );
}
