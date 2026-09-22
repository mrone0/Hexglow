import {it,expect} from 'vitest';
import {previewSession} from './preview';
it('isolates static UI preview from real game identity',()=>{const s=previewSession();expect(s.id).toBe('preview-only');expect(s.matchId).toBe('UI-DEMO');expect(s.players).toHaveLength(10);expect(s.decisions[0].result.summary).toContain('静态演示');expect(s.liveData).toBeNull();expect(s.candidates.every(c=>c.description.includes('不代表游戏内真实'))).toBe(true);});
