import type {Recommendation, Session} from './domain';
import {augmentBand, ownLevel} from './level';
import {modelContextKey} from './modelPublication';

export type ScoredCandidate = {
  id: string;
  name: string;
  description: string;
  rarity: string;
  category: string;
  score?: number;
  reason: string;
  risks: string[];
  assessment?: 'supported' | 'limited' | 'unresolved';
  evidence?: string[];
  displayScore?: number | null;
  confidence?: number | null;
  alreadyOwned?: boolean;
};

export type ScoreResult = {
  ranking: ScoredCandidate[];
  summary: string;
  rankingReliable?: boolean;
  source?: 'model' | 'recognition';
  profile?: {champion?: string; role?: string; ranged?: boolean | null; damage?: string};
};

export const assessmentLabel = (assessment: ScoredCandidate['assessment']) =>
  assessment === 'supported' ? '模型依据已提供' : assessment === 'unresolved' ? '结果待核验' : '依据有限';

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
const finiteScore = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const usableConfidence = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 1;

/** Recognition supplies identity/effect text, never a heuristic recommendation. */
export function recognizedCandidates(session: Session): ScoreResult {
  const seen = new Set<string>();
  const candidates = session.candidates.filter(candidate => {
    if (!candidate.id.trim() || !candidate.name.trim() || seen.has(candidate.id)) return false;
    seen.add(candidate.id); return true;
  });
  return {
    source: 'recognition', rankingReliable: false, summary: '已识别 · 待模型分析',
    profile: {champion: session.players.find(player => player.id === session.ownPlayerId)?.champion},
    ranking: candidates.map(candidate => ({id: candidate.id, name: candidate.name, description: candidate.description,
      rarity: '', category: '', reason: '', risks: [], assessment: 'limited', evidence: [], displayScore: null})),
  };
}

/** Associate an authorized model result only with the exact, complete candidate set. */
export function modelRecommendation(session: Session, recommendation: Recommendation): ScoreResult {
  const recognized = recognizedCandidates(session);
  const items = Array.isArray(recommendation.ranking) ? recommendation.ranking.filter(item => item && typeof item === 'object') : [];
  const ids = session.candidates.map(candidate => candidate.id);
  const exact = ids.length >= 2 && recognized.ranking.length === ids.length && new Set(ids).size === ids.length &&
    recommendation.ranking.length === ids.length && items.length === ids.length && items.every(item => ids.includes(item.candidateId)) && new Set(items.map(item => item.candidateId)).size === ids.length;
  const dynamic = recommendation.engine?.scoringMode === 'dynamic-model-v1';
  const ranking = recognized.ranking.map(candidate => {
    const matches = items.filter(item => item.candidateId === candidate.id);
    const item = matches.length === 1 ? matches[0] : undefined;
    const references = Array.isArray(item?.factors) ? item.factors.flatMap(factor => strings(factor?.references).map(reference => `引用：${reference}`)) : [];
    const evidence = [...new Set([...strings(item?.evidence), ...references])];
    const reason = typeof item?.reason === 'string' ? item.reason : '';
    const alreadyOwned = item?.alreadyOwned === true;
    const supported = !alreadyOwned && exact && dynamic && !!candidate.description.trim() && finiteScore(item?.score) &&
      usableConfidence(item?.confidence) && !!reason.trim() && evidence.length > 0;
    const risks = [...strings(item?.risks)];
    if (!exact) risks.push('模型返回的候选 ID 不完整、重复或不匹配，暂不排序。');
    if (!dynamic) risks.push('结果未标明动态模型评分方式，不沿用历史融合分。');
    if (alreadyOwned) risks.push('当前对局已拥有，不作为新的选择。');
    else if (!supported) risks.push('模型评分、置信度或依据尚不足，暂不判断优劣。');
    return {...candidate, score: finiteScore(item?.score) ? item.score : undefined, reason, risks, evidence,
      confidence: item?.confidence, alreadyOwned, assessment: supported ? 'supported' as const : 'limited' as const,
      displayScore: supported ? item!.score : null};
  });
  const rankingReliable = ranking.length >= 2 && ranking.every(candidate => candidate.assessment === 'supported');
  return {...recognized, source: 'model', rankingReliable,
    summary: typeof recommendation.summary === 'string' ? recommendation.summary : '模型比较结果',
    ranking: ranking.map(candidate => ({...candidate, displayScore: rankingReliable ? candidate.displayScore : null}))};
}

/** Legacy heuristic scores are not permission to present a reliable recommendation. */
export function localRankingPresentation(result: ScoreResult) {
  const candidates = result.ranking.map(candidate => ({
    ...candidate,
    assessment: candidate.assessment === 'supported' || candidate.assessment === 'unresolved' ? candidate.assessment : 'limited' as const,
    evidence: Array.isArray(candidate.evidence) ? candidate.evidence.filter(item => typeof item === 'string' && item.trim()) : [],
  }));
  const reliable = result.source === 'model' && result.rankingReliable === true && candidates.length > 0 && candidates.every(candidate =>
    !candidate.alreadyOwned && candidate.assessment === 'supported' && candidate.evidence.length > 0 && usableConfidence(candidate.confidence) &&
    typeof candidate.displayScore === 'number' && Number.isFinite(candidate.displayScore) && candidate.displayScore >= 0 && candidate.displayScore <= 100);
  const ordered = reliable ? [...candidates].sort((a, b) => b.displayScore! - a.displayScore!) : candidates;
  return {
    reliable,
    source: result.source,
    label: result.source === 'model' ? '模型推荐' : result.source === 'recognition' ? '已识别 · 待模型分析' : '历史结果 · 待模型分析',
    summary: `${result.profile?.champion ? `本次英雄：${result.profile.champion}。` : ''}${reliable ? result.summary : result.source === 'recognition' ? '已识别候选与效果；默认手动分析，开启自动推荐后按设置触发。' : result.source === 'model' ? `${result.summary} 模型依据或置信度不足，暂不排名或给分。` : '历史结果来源未明确，不沿用本地规则分数；等待模型分析。'}`,
    candidates: ordered.map(candidate => ({
      ...candidate,
      displayScore: reliable ? candidate.displayScore! : null,
      rank: reliable ? 1 + ordered.filter(other => other.displayScore! > candidate.displayScore!).length : null,
      tied: reliable && ordered.filter(other => other.displayScore === candidate.displayScore).length > 1,
    })),
  };
}

export type LocalRecommendation = {
  sessionId: string;
  band: number;
  key: string;
  at: string;
  result: ScoreResult;
};

export function localRecommendationKey(session: Session): string {
  const own = session.players.find(player => player.id === session.ownPlayerId);
  return JSON.stringify([
    session.ownPlayerId,
    own?.id,
    own?.champion,
    own?.augments,
    own?.items,
    session.candidates.map(candidate => [candidate.id, candidate.name, candidate.description]),
    session.candidateBand,
  ]);
}

/** Both OCR and restored candidates must score the same observed build. */
export function localScoringArgs(session: Session) {
  const own = session.players.find(player => player.id === session.ownPlayerId);
  return {
    ids: session.candidates.map(candidate => candidate.id),
    champion: own?.champion || null,
    level: session.candidateBand,
    owned: own?.augments || [],
    items: own?.items || [],
  };
}

/** Cache the actual candidate state after OCR and manual corrections have been merged. */
export function createLocalRecommendation(
  session: Session,
  result: ScoreResult,
  at = new Date().toISOString(),
): LocalRecommendation {
  return {
    sessionId: session.id,
    band: augmentBand(ownLevel(session.liveData) ?? 1),
    key: result.source === 'model' ? modelContextKey(session) : localRecommendationKey(session),
    at,
    result,
  };
}

/** API refreshes and capture skips preserve a result; a different choice context does not. */
export function selectLocalRecommendation(
  session: Session,
  local: LocalRecommendation | null,
): LocalRecommendation | null {
  if (
    !local ||
    session.id !== local.sessionId ||
    session.phase !== 'InProgress' ||
    augmentBand(ownLevel(session.liveData) ?? 1) !== local.band ||
    session.candidateBand !== local.band ||
    (local.result.source !== 'model' && session.candidates.some(candidate => candidate.source !== 'ocr')) ||
    (local.result.source === 'model' ? modelContextKey(session) : localRecommendationKey(session)) !== local.key
  ) return null;
  return local;
}
