export type KnowledgeWarmupResult = {status: 'ready' | 'busy' | 'failed'};

const LOADING_PHASES = new Set(['ChampSelect', 'GameStart', 'Reconnect', 'InProgress']);
const FINISHED_PHASES = new Set(['None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'PreEndOfGame', 'EndOfGame', 'WaitingForStats', 'TerminatedInError']);
type LoadingCycle = {matchId: string | null; attempts: number; ready: boolean};

/** Local preparation only: no candidates, player data, model request or usage charge. */
export class KnowledgeWarmup {
  private cycle: LoadingCycle | null = null;
  private inFlight = false;

  constructor(private readonly prepare: () => Promise<KnowledgeWarmupResult>) {}

  /** Never awaited by collection/OCR. Busy does not spend the two-failure budget. */
  observe(phase: string, gameId?: string | number | null): void {
    if (!LOADING_PHASES.has(phase)) {
      // A temporary unknown/disconnected snapshot is not a new loading cycle.
      if (FINISHED_PHASES.has(phase)) this.cycle = null;
      return;
    }
    const matchId = gameId !== null && gameId !== undefined && /^\d{1,24}$/.test(String(gameId)) && String(gameId) !== '0' ? String(gameId) : null;
    if (!this.cycle || (matchId && this.cycle.matchId && matchId !== this.cycle.matchId)) {
      this.cycle = {matchId, attempts: 0, ready: false};
    } else if (matchId) {
      // ChampSelect often has no game ID; bind it later without warming twice.
      this.cycle.matchId = matchId;
    }
    const cycle = this.cycle;
    if (this.inFlight || cycle.ready || cycle.attempts >= 2) return;
    cycle.attempts++;
    this.inFlight = true;
    // Capture both synchronous IPC errors and asynchronous rejections. A failed
    // preheat must never affect live collection or block fresh retrieval later.
    void Promise.resolve().then(() => this.prepare()).then(result => {
      cycle.ready = result.status === 'ready';
      if(result.status==='busy')cycle.attempts--;
    }).catch(() => {}).finally(() => {this.inFlight = false;});
  }
}
