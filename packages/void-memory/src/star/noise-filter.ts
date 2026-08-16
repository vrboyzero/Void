/**
 * P0-3: 噪声过滤 (Noise Filter)
 *
 * 过滤低质量记忆内容：Agent 否认回复、元问题、会话样板文等。
 * 主要用于会话历史（.jsonl）索引时，避免无意义内容入库。
 */

// Agent 否认/无结果回复
const DENIAL_PATTERNS = [
  /i don'?t have (any )?(information|data|memory|record)/i,
  /i'?m not sure about/i,
  /i don'?t recall/i,
  /i don'?t remember/i,
  /it looks like i don'?t/i,
  /i wasn'?t able to find/i,
  /no (relevant )?memories found/i,
  /i don'?t have access to/i,
  // 中文否认
  /我(没有|不记得|不清楚|不确定|找不到)(相关)?(信息|记忆|记录|数据)/,
  /没有找到(相关)?(信息|记忆|记录|内容)/,
];

// 用户关于记忆本身的元问题（不是有价值的内容）
const META_QUESTION_PATTERNS = [
  /\bdo you (remember|recall|know about)\b/i,
  /\bcan you (remember|recall)\b/i,
  /\bhave i (told|mentioned|said)\b/i,
  /\bwhat did i (tell|say|mention)\b/i,
  // 中文元问题
  /^你(还)?记得吗[？?]?$/,
  /^你(知道|记得)我(说过|提过)什么吗[？?]?$/,
];

// 会话样板文（问候、新会话标记等）
const BOILERPLATE_PATTERNS = [
  /^(hi|hello|hey|good morning|good evening|greetings)\s*[.!]?$/i,
  /^(你好|嗨|哈喽|在吗)\s*[。！!]*$/,
  /^fresh session/i,
  /^new session/i,
  /^HEARTBEAT/i,
  /^\[System/i,
];

export interface NoiseFilterOptions {
  /** 过滤 Agent 否认回复（默认 true） */
  filterDenials?: boolean;
  /** 过滤关于记忆的元问题（默认 true） */
  filterMetaQuestions?: boolean;
  /** 过滤会话样板文（默认 true） */
  filterBoilerplate?: boolean;
}

const DEFAULT_OPTIONS: Required<NoiseFilterOptions> = {
  filterDenials: true,
  filterMetaQuestions: true,
  filterBoilerplate: true,
};

/**
 * 判断文本是否为噪声。
 * @returns true = 噪声，应过滤掉
 */
export function isNoise(text: string, options: NoiseFilterOptions = {}): boolean {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const trimmed = text.trim();

  // 过短无意义
  if (trimmed.length < 5) return true;

  if (opts.filterDenials && DENIAL_PATTERNS.some(p => p.test(trimmed))) return true;
  if (opts.filterMetaQuestions && META_QUESTION_PATTERNS.some(p => p.test(trimmed))) return true;
  if (opts.filterBoilerplate && BOILERPLATE_PATTERNS.some(p => p.test(trimmed))) return true;

  return false;
}

/**
 * 从数组中过滤掉噪声条目。
 */
export function filterNoise<T>(
  items: T[],
  getText: (item: T) => string,
  options?: NoiseFilterOptions,
): T[] {
  return items.filter(item => !isNoise(getText(item), options));
}
