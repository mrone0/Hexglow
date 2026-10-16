import type {ScoreResult} from './liveRecommendation';
import {normalizeRecommendationStatus, type RecommendationStatus} from './recommendationStatus';

const validScore = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/** Show validated model scores without treating evidence confidence as a win probability. */
export function overlayPresentation(result: ScoreResult, analysis?: RecommendationStatus) {
  const state = normalizeRecommendationStatus(analysis);
  const regionUnconfirmed=state.code==='choice-region-unavailable'&&['waiting','analyzing'].includes(state.phase);
  const recognitionLabels: Record<RecommendationStatus['phase'], {label: string; chip: string}> = {
    waiting: {label: '已识别 · 待分析', chip: '待模型分析'},
    preparing: {label: '已识别 · 准备分析', chip: '准备分析'},
    analyzing: {label: '模型分析中', chip: '分析中'},
    blocked: {label: '自动分析暂停', chip: '分析暂停'},
    failed: {label: '模型分析失败', chip: '分析失败'},
    complete: {label: '已分析 · 待同步', chip: '等待结果同步'},
  };
  const recognition = state.phase === 'analyzing' && state.code === 'result-received'
    ? {label: '评分已返回 · 同步中', chip: '同步评分'}
    : state.phase === 'waiting' && state.code === 'refreshing-context'
      ? {label: '正在确认轮次', chip: '同步轮次'}
    : state.phase === 'waiting' && ['confirming-ocr', 'incomplete-ocr', 'ineligible-choice'].includes(state.code)
      ? {label: '候选复核中', chip: '复核候选'}
      : recognitionLabels[state.phase];
  const scored = !regionUnconfirmed && result.source === 'model' && result.modelScoresValid === true && result.ranking.length > 0 &&
    result.ranking.every(candidate => validScore(candidate.score));
  const candidates = result.ranking.map(candidate => ({...candidate,
    evidence: Array.isArray(candidate.evidence) ? candidate.evidence.filter(item => typeof item === 'string' && !!item.trim()) : [],
    displayScore: scored && !candidate.alreadyOwned ? candidate.score! : null,
  }));
  const ordered = scored ? [...candidates].sort((a, b) => (b.displayScore ?? -1) - (a.displayScore ?? -1)) : candidates;
  const bestScore = scored ? ordered[0]?.displayScore : null;
  const tiedBest = bestScore !== null && ordered.filter(candidate => candidate.displayScore === bestScore).length > 1;
  return {
    label: regionUnconfirmed?'此前候选 · 复核中':result.source === 'model' ? result.contextChanged ? '已分析 · 此前结果' : '已分析' : recognition.label,
    status: `${result.profile?.champion ? `${result.profile.champion} · ` : ''}${regionUnconfirmed?state.message:result.source === 'model' ? scored ? '按模型评分排序' : '已分析 · 暂无可用评分' : state.message}`,
    analysisChip: regionUnconfirmed?'复核候选':recognition.chip,
    footnote: regionUnconfirmed?'区域复核中 · 未发布新推荐':result.source === 'model' ? `${scored ? '模型评分，非胜率' : '已分析 · 未评分'}${result.contextChanged ? ' · 此前结果' : ''}` : '识别免费 · 自动分析按设置触发',
    candidates: ordered.map(candidate => ({...candidate,
      rank: candidate.displayScore !== null ? 1 + ordered.filter(other => other.displayScore !== null && other.displayScore > candidate.displayScore!).length : null,
      tied: candidate.displayScore !== null && ordered.filter(other => other.displayScore === candidate.displayScore).length > 1,
      recommended: candidate.displayScore !== null && candidate.displayScore === bestScore,
      recommendationLabel: tiedBest ? '并列综合推荐' : '综合推荐',
    })),
  };
}
