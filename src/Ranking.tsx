import type {Recommendation, RankingItem} from './domain';

const num = (value: number | null | undefined, digits = 1) =>
  typeof value === 'number' ? value.toFixed(digits) : '—';

export function RankingItemView({
  item,
  index,
  candidates,
  scoringMode,
}: {
  item: RankingItem;
  index: number;
  candidates: {id: string; name: string}[];
  scoringMode?: string;
}) {
  const name = candidates.find((c) => c.id === item.candidateId)?.name || item.candidateId;
  const local = scoringMode !== 'dynamic-model-v1' && typeof item.localScore === 'number' && Number.isFinite(item.localScore);
  const model = typeof item.modelScore === 'number' && Number.isFinite(item.modelScore);
  return (
    <div className="ranking">
      <span className="rank">{item.alreadyOwned?'已拥有':String(index + 1).padStart(2, '0')}</span>
      <div>
        <strong>{name}</strong>
        {item.factors?.length ? (
          <div className="factor-row">
            {item.factors.map((f) => (
              <span className="factor" key={f.key}>
                {f.label} {num(f.score)}
                {typeof f.confidence === 'number' ? ` · 置信 ${f.confidence.toFixed(2)}` : ''}
              </span>
            ))}
          </div>
        ) : null}
        <p>{item.reason}</p>
        {(model || local) && (
          <small className="score-line">
            {model ? `模型 ${num(item.modelScore)}` : ''}{local ? `${model?' · ':''}历史本地规则 ${num(item.localScore, 0)}` : ''}
            {local && typeof item.modelWeight === 'number' ? ` · 历史模型占比 ${Math.round(item.modelWeight * 100)}%` : ''}
            {typeof item.confidence === 'number' ? ` · 综合置信 ${item.confidence.toFixed(2)}` : ''}
          </small>
        )}
        {item.evidence?.length ? (
          <ul className="evidence">
            {item.evidence.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : null}
        {item.risks.length > 0 && <small>{item.risks.join('；')}</small>}
      </div>
      <b>{item.alreadyOwned?'不作为新选择':item.score}</b>
    </div>
  );
}

export function EngineBadge({engine}: {engine?: Recommendation['engine']}) {
  if (!engine) return null;
  return (
    <span className="pill engine" title={`延迟 ${engine.latencyMs} ms${engine.inputBytes ? ` · 上下文 ${Math.round(engine.inputBytes / 1024)} KiB` : ''} · ${engine.confidenceKind==='self_reported'?'模型自报置信度，未校准':engine.confidenceKind==='provider'?'服务返回置信度，未按真实对局校准':'未提供置信度'}`}>
      {engine.provider} · {engine.model}{engine.scoringMode==='dynamic-model-v1'?' · 动态模型比较':''}
    </span>
  );
}
