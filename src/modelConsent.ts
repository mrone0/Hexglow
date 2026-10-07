/** Approval is bound to the exact provider and service path, never a different destination. */
export function modelDestination(model: {provider?: string; baseUrl: string}): string {
  try {
    const url = new URL(model.baseUrl.trim());
    if (url.username || url.password || url.search || url.hash) return '';
    return `${model.provider || 'openai'}:${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

export function modelServiceLabel(model: {provider?: string; baseUrl: string}): string {
  try { return `${model.provider === 'jev' ? 'Jev' : '模型服务'}（${new URL(model.baseUrl.trim()).host}）`; }
  catch { return model.provider === 'jev' ? 'Jev' : '当前模型服务'; }
}
