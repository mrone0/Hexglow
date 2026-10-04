import type {Recommendation, RankingItem} from './domain';

const num = (value: number | null | undefined, digits = 1) =>
  typeof value === 'number' ? value.toFixed(digits) : '—';

export function RankingItemView({
  item,
  index,
  candidates,
}: {
  item: RankingItem;
  index: number;
  candidates: {id: string; name: string}[];
}) {
  const name = candidates.find((c) => c.id === item.candidateId)?.name || item.candidateId;
  const scored = typeof item.modelScore === 'number' || typeof item.localScore === 'number';
  return (
    <div className="ranking">
      <span className="rank">{String(index + 1).padStart(2, '0')}</span>
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
        {scored && (
          <small className="score-line">
            模型 {num(item.modelScore)} · 本地规则 {num(item.localScore, 0)}
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
      <b>{item.score}</b>
    </div>
  );
}

export function EngineBadge({engine}: {engine?: Recommendation['engine']}) {
  if (!engine) return null;
  return (
    <span className="pill engine" title={`延迟 ${engine.latencyMs} ms`}>
      {engine.provider} · {engine.model}
    </span>
  );
}
