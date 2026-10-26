/**
 * 回复质检（纯本地，不花 token、不增加延迟）
 *
 * 模型偶尔会漏出一些"一看就是机器"的东西：
 *   - [表情] [图片] 这种占位符（会原样发到 QQ）
 *   - markdown 标记（**加粗**、# 标题、- 列表）
 *   - 括号里写动作（（笑）（小声））
 *   - 连续两句一模一样
 *   - 破功句（"作为一个AI""我需要说明")
 *
 * 这些都在发送前清掉。成本为零，效果立竿见影。
 */

// 模型会照着输入格式学的占位符
const PLACEHOLDER_RE =
  /\[(表情包?|图片|语音|视频|文件|卡片|合并转发|骰子|猜拳|动画表情)\]/g;

// 括号里的动作描写，只删"纯动作词"，颜文字和正常括号保留
const ACTION_WORDS =
  /^(笑|笑笑|笑死|认真|认真脸|小声|小声嘀咕|嘀咕|叹气|无奈|捂脸|歪头|点头|摇头|眨眼|挑眉|脸红|害羞|生气|撇嘴|摊手|思考|沉默|停顿|顿了顿|想了想|伸懒腰|打了个哈欠|挠头|抱抱|拍了拍|亲亲|比心)$/;

// 一眼是机器的句子片段
const BREAK_PATTERNS = [
  /作为(一个|一名)?\s*(AI|人工智能|语言模型|助手)[，,。.!！]?/gi,
  /我是(一个|一名)?\s*(AI|人工智能|语言模型)[，,。.!！]?/gi,
  /(我)?(无法|不能)提供(任何)?(医疗|法律|投资|专业)(建议|意见)[，,。.!！]?/g,
  /希望(以上)?(回答|内容)(对你)?(有)?(所)?帮助[，,。.!！]?/g,
  /如果你(还)?有(其他|任何)(问题|疑问)[，,]?(请)?(随时|尽管)(问我|提出)[。.!！]?/g,
];

function stripMarkdown(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.、)]\s+/gm, "");
}

function stripActionParens(s) {
  return s.replace(/[（(]\s*([^（()）\n]{0,10}?)\s*[）)]/g, (m, inner) =>
    ACTION_WORDS.test(String(inner).trim()) ? "" : m
  );
}

/** 把相邻重复的句子去掉（"好呀好呀。" 这类不算，只处理整句重复） */
function dedupeSentences(s) {
  const parts = s.split(/(?<=[。！？!?…~])/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return s;
  const out = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev && prev.replace(/[。！？!?…~，,]/g, "") === p.replace(/[。！？!?…~，,]/g, "")) {
      continue; // 整句重复，丢掉
    }
    out.push(p);
  }
  return out.join("");
}

/** 太长就按句子边界截断，别中途断字 */
function clampLength(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastStop = Math.max(
    cut.lastIndexOf("。"),
    cut.lastIndexOf("！"),
    cut.lastIndexOf("？"),
    cut.lastIndexOf("…")
  );
  return lastPunctuated(cut, lastStop, max);
}

function lastPunctuated(cut, lastStop, max) {
  if (lastStop > max * 0.5) return cut.slice(0, lastStop + 1);
  return cut;
}

/**
 * 主函数：清洗一条要发出去的话
 * @param {string} text
 * @param {{maxLen?:number}} opts
 */
export function polish(text, opts = {}) {
  let s = String(text ?? "");
  if (!s.trim()) return "";

  s = s.replace(PLACEHOLDER_RE, "");
  s = stripMarkdown(s);
  s = stripActionParens(s);
  for (const re of BREAK_PATTERNS) s = s.replace(re, "");
  s = dedupeSentences(s);

  s = s
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\s，,。.、]+/, "")
    .trim();

  s = clampLength(s, Number(opts.maxLen) || 400);
  return s.trim();
}

/**
 * 判断这条回复是不是"废了"（空、或者只剩标点）。
 * 上层可以用它来决定要不要重试。
 */
export function isBlank(text) {
  const s = String(text ?? "").replace(/[\s\p{P}\p{S}]/gu, "");
  return s.length === 0;
}

/**
 * 和她最近说过的话太像了？
 * 用字符二元组重合度，和 index.mjs 里自发的去重是同一套思路。
 */
export function tooSimilar(a, b, threshold = 0.75) {
  const norm = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const grams = (s) => {
    const m = new Set();
    for (let i = 0; i < s.length - 1; i++) m.add(s.slice(i, i + 2));
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  return inter / Math.min(gx.size || 1, gy.size || 1) >= threshold;
}
