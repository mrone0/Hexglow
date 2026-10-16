import type {Session} from './domain';

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Match recommendation context requirements before a request consumes its attempt. */
export function analysisDataIssue(session: Session): string {
  if (!record(session) || typeof session.ownPlayerId !== 'string') return '当前玩家数据结构无效';
  if (!Array.isArray(session.players)) return '玩家列表数据结构无效';
  const ids = new Set<string>();
  for (const player of session.players) {
    // Nonempty player IDs and array-shaped items additionally guard the frontend boundary.
    if (!record(player) || !nonempty(player.id) || ids.has(player.id)) return '玩家标识缺失或重复';
    ids.add(player.id);
    if (typeof player.team !== 'string' || !['ORDER','CHAOS','UNKNOWN'].includes(player.team)) return '玩家队伍数据结构无效';
    if (typeof player.champion !== 'string') return '玩家英雄数据结构无效';
    if (!Array.isArray(player.items)) return '玩家装备数据结构无效';
    if (!Array.isArray(player.augments) || !Array.from(player.augments).every(augment => typeof augment === 'string')) return '玩家海克斯数据结构无效';
  }
  if (!Array.isArray(session.candidates) || session.candidates.length < 2) return '至少需要两个完整候选';
  const candidateIds = new Set<string>();
  for (const candidate of session.candidates) {
    if (!record(candidate) || !nonempty(candidate.id) || candidateIds.has(candidate.id)) return '候选标识缺失或重复';
    candidateIds.add(candidate.id);
    if (!nonempty(candidate.name) || !nonempty(candidate.description)) return '候选名称或效果尚未完整';
  }
  return '';
}

/** Only fixed, non-sensitive messages may leave the failure classification boundary. */
export function analysisFailure(error: unknown): {code: string; message: string; httpStatus?: number} {
  let text = '';
  try {
    if (typeof error === 'string') text = error;
    else if (record(error) && typeof error.message === 'string') text = error.message;
  } catch { /* A malformed error object is still an unknown failure. */ }
  // A status-like string inside a URL is not an HTTP status, and URLs are never output.
  text = text.slice(0, 16000).replace(/https?:\/\/[^\s"'<>]+/gi, ' ');
  const statusMatch = text.match(/\bhttp-status-([45]\d{2})(?!\d)|\bstatus\s+code\s*[:=]?\s*\(?\s*([45]\d{2})(?!\d)|\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:(?:status\s+)?(?:client|server)\s+error\s*\(\s*|status\s*[:=]?\s*)?([45]\d{2})(?!\d)/i);
  const httpStatus = statusMatch ? Number(statusMatch.slice(1).find(Boolean)) : undefined;
  if (httpStatus !== undefined) {
    if (httpStatus === 401) return {code: 'http-401', message: '模型服务认证失败，请检查密钥', httpStatus};
    if (httpStatus === 403) return {code: 'http-403', message: '模型服务拒绝访问，请检查权限', httpStatus};
    if (httpStatus === 429) return {code: 'http-429', message: '模型服务限流，请稍后手动重试', httpStatus};
    if (httpStatus >= 500) return {code: 'http-5xx', message: '模型服务暂时异常，请稍后手动重试', httpStatus};
    return {code: 'http-4xx', message: '模型服务未接受请求，请检查配置', httpStatus};
  }
  if (/\btimeout\b|\btimed\s*out\b|\bETIMEDOUT\b|超时/i.test(text)) return {code: 'timeout', message: '模型请求超时，可在主窗口手动重试'};
  if (/\bnetwork\b|\bECONN(?:RESET|REFUSED|ABORTED)\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bDNS\b|\bTLS\b|\bSSL\b|error sending request|failed to fetch|connection (?:refused|reset|closed)|无法连接模型服务|响应读取失败|网络错误/i.test(text)) {
    return {code: 'network', message: '无法连接模型服务，请检查网络或服务地址'};
  }
  if (/invalid[ -](?:response|json)|模型(?:服务返回无效 JSON| JSON 无效|未返回文本|结果|因素解释|引用|响应超过)|(?:Jev (?:score|noul answer)|score|confidence).*(?:缺失|无效|必须)|返回的是 OpenAI 聊天格式/i.test(text)) {
    return {code: 'invalid-response', message: '模型返回格式不符合要求，未生成评分'};
  }
  return {code: 'unknown', message: '模型分析未完成，未生成评分'};
}
