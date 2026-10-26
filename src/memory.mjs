/**
 * 长期记忆（Markdown 笔记）
 *
 * 和原来 memory.json 的区别：
 *   - 原来是一堆自动抽出来的短事实（最多 80 条、每条 40 字），冷冰冰
 *   - 现在是一本她自己维护的笔记：分章节、能改写、能写"我自己想记住的"
 *
 * 两件事：
 *   1. updateFromExchange —— 聊一阵就根据对话改写一遍笔记（合并、修正、删次要的）
 *   2. archiveMonth       —— 每月初把上个月的日记压成一段，写进"时间线"
 *
 * 总长有硬上限（默认 2000 字），超了让她自己压缩，保证注入上下文时不会爆。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const DEFAULT_TEMPLATE = `# 小鲸的记忆

## 关于他
（名字、称呼、外貌、性格、工作、作息）

## 他的喜好
（喜欢什么、讨厌什么、爱吃什么、爱玩什么）

## 他的习惯
（什么时候在线、说话方式、在意的事）

## 我们在做的事
（约定、正在一起等的事、最近在聊的话题）

## 我自己想记住的
（我觉得重要、但可能没人特意告诉我的事）

## 时间线
（按月份压缩的回顾）
`;

export function load(file) {
  try {
    if (existsSync(file)) {
      const t = readFileSync(file, "utf8");
      if (t.trim()) return t;
    }
  } catch {
    /* 坏了就重建 */
  }
  return DEFAULT_TEMPLATE;
}

export function save(file, content) {
  try {
    writeFileSync(file, content, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 把旧 memory.json 里的事实迁移进来（只做一次） */
export function seedFromFacts(file, facts = []) {
  if (!Array.isArray(facts) || !facts.length) return load(file);
  const cur = load(file);
  if (!cur.includes("## 关于他")) return cur;
  const already = facts.every((f) => cur.includes(String(f.text || "").slice(0, 8)));
  if (already) return cur;
  const lines = facts
    .map((f) => String(f.text || "").trim())
    .filter(Boolean)
    .map((t) => `- ${t}`)
    .join("\n");
  if (!lines) return cur;
  return cur.replace("## 关于他\n", `## 关于他\n${lines}\n`);
}

/** 注入上下文时用的内容（超长就截断，保证不爆 token） */
export function forPrompt(content, maxChars = 1800) {
  const t = String(content || "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n（后面还有，先记这些）";
}

const UPDATE_SYS = (maxChars) =>
  "你在维护一本属于你自己的记忆笔记（markdown 格式）。\n" +
  "根据这次对话，更新它。规则：\n" +
  "① 只记**值得长期记住**的东西：他的喜好、习惯、在意的人/事、他自己说过的重要信息，以及你觉得需要记住的观察；\n" +
  "② 已有条目如果被细化或推翻，直接改掉，**不要重复堆叠**（比如已经写了“爱喝冰美式”就别再加一条一样的）；\n" +
  "③ 一次性的琐事（今天吃了什么、现在几点）不记；\n" +
  "④ 保持原有的 markdown 章节结构，没有内容的章节可以留空；\n" +
  `⑤ 总长度必须控制在 ${maxChars} 字以内，超了就把次要的条目合并或删掉；\n` +
  "⑥ 用短句、条目式，不要写成段落散文。\n" +
  "只输出更新后的完整 markdown，不要解释。";

/**
 * 根据一次对话更新记忆笔记
 * @returns {Promise<string>} 新的笔记内容（失败返回空字符串）
 */
export async function updateFromExchange({ content, exchange, maxChars = 2000, opts = {} }) {
  const apiKey = opts.apiKey || "";
  if (!apiKey) return "";
  const base = String(opts.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: opts.model || "deepseek-chat",
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: UPDATE_SYS(maxChars) },
          {
            role: "user",
            content: `现在的记忆笔记：\n\n${content}\n\n---\n\n这次聊的内容：\n${exchange}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 1600,
        stream: false,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    let out = (data?.choices?.[0]?.message?.content || "").trim();
    // 去掉可能被包上的 ```markdown 代码块
    out = out.replace(/^```(?:markdown)?\s*/i, "").replace(/```\s*$/, "").trim();
    if (!out.includes("## ")) return ""; // 结构丢了就丢弃，别把笔记搞坏
    if (out.length > maxChars * 1.6) out = out.slice(0, Math.round(maxChars * 1.6));
    return out;
  } catch {
    return "";
  }
}

const ARCHIVE_SYS =
  "把下面这些日记压缩成一段回忆，写成记忆笔记里「时间线」的一节。\n" +
  "要求：\n" +
  "① 只保留有长期价值的东西（关系的变化、重要的约定、反复出现的情绪或话题）；\n" +
  "② 200 字以内，条目式或短段落，不要抒情；\n" +
  "③ 开头写月份标题，格式：`### YYYY-MM`；\n" +
  "④ 只输出这一节的内容，不要输出整份笔记。";

/**
 * 月度归档：把上个月日记压成一段，接到「时间线」里
 * @returns {Promise<string>} 更新后的整份笔记（失败返回空字符串）
 */
export async function archiveMonth({ content, monthLabel, diaryText, opts = {} }) {
  const apiKey = opts.apiKey || "";
  if (!apiKey) return "";
  const base = String(opts.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: opts.model || "deepseek-chat",
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: ARCHIVE_SYS },
          { role: "user", content: `月份：${monthLabel}\n\n日记：\n${diaryText.slice(0, 8000)}` },
        ],
        temperature: 0.4,
        max_tokens: 600,
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    let section = (data?.choices?.[0]?.message?.content || "").trim();
    section = section.replace(/^```(?:markdown)?\s*/i, "").replace(/```\s*$/, "").trim();
    if (!section) return "";

    // 已经有这个月的小节就替换，没有就追加
    const head = `### ${monthLabel}`;
    if (content.includes(head)) {
      const re = new RegExp(`### ${monthLabel}\\n[\\s\\S]*?(?=\\n### |\\s*$)`);
      return content.replace(re, section);
    }
    return content.replace(/\s*$/, "\n\n") + section + "\n";
  } catch {
    return "";
  }
}
