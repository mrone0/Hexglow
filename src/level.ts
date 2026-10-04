export const AUGMENT_LEVELS = [1, 7, 11, 15] as const;

/** 海克斯选择出现的等级（官方确认：开局、7、11、15）。 */
export function augmentBand(level: number): number {
  return level >= 15 ? 15 : level >= 11 ? 11 : level >= 7 ? 7 : 1;
}

export function ownLevel(liveData: unknown): number | null {
  const level = (liveData as {activePlayer?: {level?: unknown}} | null)?.activePlayer?.level;
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? Math.floor(level) : null;
}

export type TriggerState = {matchId: string; fired: number[]};

/**
 * 同一局内每个等级段只记录一次；换局自动复位。
 * `fired` 不再驱动识别（识别每轮 InProgress 都跑），只用于保持档位状态。
 * 首帧直接跳到高等级（重连）时只记录当前所处的等级段。
 */
export function nextTriggers(
  state: TriggerState,
  matchId: string,
  level: number | null,
): {state: TriggerState; fired: number[]} {
  if (!matchId || level === null) return {state, fired: []};
  const base = state.matchId === matchId ? state : {matchId, fired: []};
  const band = augmentBand(level);
  const reached = base.fired.reduce((max, value) => Math.max(max, value), 0);
  if (band <= reached) return {state: base, fired: []};
  return {state: {matchId, fired: [...base.fired, band]}, fired: [band]};
}
