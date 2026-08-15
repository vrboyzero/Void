/**
 * P0-1: 自适应检索 (Adaptive Retrieval)
 *
 * 在检索前判断用户输入是否需要触发记忆检索。
 * 对问候、命令、简单确认等跳过检索，节省 Embedding API 调用并减少噪声注入。
 * 对包含记忆关键词的输入强制检索。
 */

// 明确不需要检索的模式
const SKIP_PATTERNS = [
  // 问候 & 寒暄
  /^(hi|hello|hey|good\s*(morning|afternoon|evening|night)|greetings|yo|sup|howdy|what'?s up)\b/i,
  // 中文问候
  /^(你好|早上好|下午好|晚上好|嗨|哈喽|在吗|在不在)\s*[。！!？?]*$/,
  // 斜杠命令
  /^\//,
  // 常见 CLI / 开发命令
  /^(run|build|test|ls|cd|git|npm|pnpm|pip|docker|curl|cat|grep|find|make|sudo)\b/i,
  // 简单肯定/否定
  /^(yes|no|yep|nope|ok|okay|sure|fine|thanks|thank you|thx|ty|got it|understood|cool|nice|great|good|perfect|awesome|👍|👎|✅|❌)\s*[.!]?$/i,
  // 中文简单确认
  /^(好的?|可以|行|嗯|对|是的?|没问题|收到|了解|明白|知道了|谢谢|感谢)\s*[。！!]*$/,
  // 继续指令
  /^(go ahead|continue|proceed|do it|start|begin|next|实施|开始|继续)\s*[.!。！]*$/i,
  // 纯 emoji
  /^[\p{Emoji}\s]+$/u,
  // 心跳 / 系统消息
  /^HEARTBEAT/i,
  /^\[System/i,
];

// 强制触发检索的模式（优先级高于 SKIP）
const FORCE_RETRIEVE_PATTERNS = [
  // 英文记忆关键词
  /\b(remember|recall|forgot|memory|memories)\b/i,
  /\b(last time|before|previously|earlier|yesterday|ago)\b/i,
  /\b(my (name|email|phone|address|birthday|preference))\b/i,
  /\b(what did (i|we)|did i (tell|say|mention))\b/i,
  // 中文记忆关键词
  /(你记得|之前|上次|以前|还记得|提到过|说过|聊过|讨论过|我的名字|我叫|我是谁)/,
  /(昨天|前天|上周|上个月|那次|那时候)/,
  // 显式记忆检索意图
  /(记忆|回忆|历史|搜索|查找|查询)/,
];

/**
 * 判断查询是否应跳过记忆检索。
 * @returns true = 跳过检索，false = 需要检索
 */
export function shouldSkipRetrieval(query: string): boolean {
  const trimmed = query.trim();

  // 强制检索模式优先判断（短 CJK 查询如"你记得吗"不会被长度过滤掉）
  if (FORCE_RETRIEVE_PATTERNS.some(p => p.test(trimmed))) return false;

  // 过短无意义
  if (trimmed.length < 4) return true;

  // 命中跳过模式
  if (SKIP_PATTERNS.some(p => p.test(trimmed))) return true;

  // 短消息且非疑问句 → 跳过
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(trimmed);
  const minLength = hasCJK ? 6 : 15;
  if (trimmed.length < minLength && !trimmed.includes("?") && !trimmed.includes("？")) return true;

  // 默认：需要检索
  return false;
}
