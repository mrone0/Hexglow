import {useEffect, useState} from 'react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {AUGMENT_LEVELS,augmentRoundLabel} from './level';
import {assessmentLabel, localRankingPresentation, type ScoredCandidate, type ScoreResult} from './liveRecommendation';
import './overlay.css';

export type OverlayCandidate = ScoredCandidate;
export type OverlayState = {
  level: number | null;
  status: 'idle' | 'capturing' | 'ocr' | 'matched' | 'error';
  message: string;
  lines: string[];
  candidates: OverlayCandidate[];
  rankingReliable?: boolean;
  profile?: ScoreResult['profile'];
  source?: ScoreResult['source'];
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

export type OverlayPayload = {sequence: number; level: number | null; reset?: boolean; ranking: ScoreResult};
export type OverlayPublication = {sequence: number; state: OverlayState};

export function reduceOverlayPublication(current: OverlayPublication, payload: OverlayPayload | null): OverlayPublication {
  if (!payload || !Number.isSafeInteger(payload.sequence) || payload.sequence <= current.sequence) return current;
  return {
    sequence: payload.sequence,
    state: payload.reset || payload.level === null
      ? {...initial}
      : {level: payload.level, status: 'matched', message: payload.ranking?.summary || '候选已识别', lines: [], candidates: payload.ranking?.ranking ?? [], rankingReliable: payload.ranking?.rankingReliable === true, profile: payload.ranking?.profile, source: payload.ranking?.source},
  };
}

export function OverlayCandidates({result}: {result: ScoreResult}) {
  const presentation = localRankingPresentation(result);
  return <>{presentation.candidates.map(candidate => (
    <article className={candidate.rank === 1 ? 'overlay-item top' : 'overlay-item'} key={candidate.id}>
      <div className="overlay-item-head">
        {candidate.rank !== null && <span className="overlay-rank">{candidate.tied ? '并列' : ''}第{candidate.rank}</span>}
        <h3>{candidate.name}</h3>
        {candidate.displayScore !== null && <b className="overlay-score" aria-label={`模型比较分 ${candidate.displayScore}，非胜率`}>{candidate.displayScore}</b>}
      </div>
      {candidate.displayScore !== null && <span className="overlay-meter" aria-hidden="true"><i style={{width: `${candidate.displayScore}%`}} /></span>}
      <div className="overlay-chips">
        {candidate.rarity && <span className={`chip rarity-${candidate.rarity}`}>{RARITY_LABEL[candidate.rarity] ?? candidate.rarity}</span>}
        {candidate.category && <span className="chip">{CATEGORY_LABEL[candidate.category] ?? candidate.category}</span>}
        <span className="chip">{candidate.alreadyOwned ? '已拥有 · 不作为新选择' : result.source === 'recognition' ? '待模型分析' : assessmentLabel(candidate.assessment)}</span>
      </div>
      <p className="overlay-effect">{candidate.description}</p>
      {candidate.reason && <small className="overlay-reason">{candidate.reason}</small>}
      {candidate.evidence.length > 0 && <ul className="overlay-evidence" aria-label="已知依据">{candidate.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      {!!candidate.risks?.length && <small className="overlay-risks">⚠ {candidate.risks.join('；')}</small>}
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

  const band = state.level === null ? null : AUGMENT_LEVELS.includes(state.level as 1 | 7 | 11 | 15) ? state.level : null;
  const result: ScoreResult = {ranking: state.candidates, summary: state.message, rankingReliable: state.rankingReliable, profile: state.profile, source: state.source};
  const presentation = localRankingPresentation(result);

  if (collapsed) {
    return (
      <div className="overlay-root is-collapsed">
        <button className="overlay-handle" onClick={toggleCollapse} aria-label="展开侧栏" title="展开海克斯侧栏">
          <span className="overlay-handle-mark">◇</span>
          <span className="overlay-handle-text">HEXGLOW</span>
          {band !== null && <span className="overlay-handle-level">{augmentRoundLabel(band)}</span>}
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
            <strong>{result.source === 'model' ? '模型推荐' : '海克斯候选'}</strong>
            <span className="overlay-mode" title="识别本身不评分、不调用模型；默认手动分析，开启自动推荐后按设置触发">
              {presentation.label}
            </span>
          </div>
          <span className="overlay-level">{band ? augmentRoundLabel(band) : '待识别'}</span>
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
          {state.candidates.length ? presentation.summary : state.message}
        </p>
        <div className="overlay-list" tabIndex={0} aria-label="本轮海克斯候选，可滚动查看完整内容">
          {state.candidates.length ? (
            <OverlayCandidates result={result} />
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
              <p>截屏识别后显示候选与效果；默认手动分析，开启自动推荐后按设置触发。</p>
              <small>不展示胜率 · 结果仅本机可见</small>
            </div>
          )}
        </div>
        <footer className="overlay-foot">{result.source === 'model' ? presentation.reliable ? '模型比较分，不代表胜率' : '模型依据不足，暂不排名或给分' : '识别本身不收费 · 自动推荐需单独开启'} · 滚动查看完整内容</footer>
      </section>
    </div>
  );
}
