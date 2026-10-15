import {endPhases, type CollectorSnapshot} from './domain';

const ACTIVE_PHASES = new Set(['ReadyCheck','ChampSelect','GameStart','Reconnect','InProgress']);
const IDLE_PHASES = new Set(['Lobby','None','Matchmaking']);

/** The game/API state sets cadence, never whether the assistant window is visible. */
export function collectorPollDelay(snapshot: CollectorSnapshot, idleFailures: number): number {
  const connected = !!snapshot.connection.trim() && snapshot.connection !== 'disconnected';
  if (connected) {
    if (ACTIVE_PHASES.has(snapshot.phase)) return 1000;
    if (IDLE_PHASES.has(snapshot.phase) || endPhases.has(snapshot.phase)) return 3000;
    const live = snapshot.liveData;
    const hasLiveData = live !== null && typeof live === 'object' && !Array.isArray(live) && Object.keys(live).length > 0;
    const hasGameId = typeof snapshot.gameId === 'string' && !!snapshot.gameId.trim();
    if (hasLiveData || hasGameId) return 3000;
  }
  return idleFailures > 5 ? 15000 : 8000;
}
