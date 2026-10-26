/**
 * 日记系统
 *
 * 定位：写给她自己看的私人日记（但主人会翻）。
 * 内容来源"混合"：以当天真实发生的事为骨架，允许加一点情绪化的想象，
 * 但不许编造具体事件/第三人/不存在的约定——那些一对聊天记录就穿帮。
 *
 * 存储：diary/YYYY-MM-DD.md，纯文本，好翻好备份。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const pad = (n) => String(n).padStart(2, "0");
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ensureDir(dir) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不了就算了，写的时候会再失败一次 */
  }
}

export function entryPath(dir, date) {
  return join(dir, `${date}.md`);
}

export function readEntry(dir, date) {
  try {
    const p = entryPath(dir, date);
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export function saveEntry(dir, date, text) {
  ensureDir(dir);
  try {
    writeFileSync(entryPath(dir, date), text, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function hasEntry(dir, date) {
  try {
    return existsSync(entryPath(dir, date));
  } catch {
    return false;
  }
}

/** 最近的几篇（按日期倒序），返回 [{date, text}] */
export function listRecent(dir, limit = 3) {
  try {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, limit);
    return files.map((f) => ({
      date: f.replace(/\.md$/, ""),
      text: readFileSync(join(dir, f), "utf8"),
    }));
  } catch {
    return [];
  }
}

/** 给聊天用的紧凑摘要（每篇只取开头一小段，省 token） */
export function recentDigest(dir, limit = 3, charsEach = 110) {
  const rows = listRecent(dir, limit);
  if (!rows.length) return "";
  return rows
    .map((r) => {
      const body = r.text
        .replace(/^#.*$/gm, "") // 去掉标题行
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, charsEach);
      return `${r.date}：${body}`;
    })
    .join("\n");
}

/**
 * 写一篇日记。
 * @param {object} p
 * @param {string} p.date
 * @param {Array<{name:string,text:string}>} p.today 当天对话（按时间顺序）
 * @param {string} p.moodDesc 她此刻的状态描述
 * @param {string} p.memoryBits 她记得的关于主人的事
 * @param {string} p.persona 人设原文
 * @param {object} p.opts {apiKey, baseUrl, model, thinking}
 */
export async function compose({ date, today = [], moodDesc = "", memoryBits = "", persona = "", opts = {} }) {
  const apiKey = opts.apiKey || "";
  if (!apiKey) return "";
  const base = String(opts.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");

  const log = today
    .slice(-80)
    .map((x) => `${x.name}：${String(x.text).slice(0, 100)}`)
    .join("\n");

  const sys =
    (persona ? persona + "\n\n" : "") +
    "现在是深夜，你要写一篇只有你自己会看的日记（但那个你很喜欢的人可能会翻到）。\n" +
    "写作要求：\n" +
    "① 第一人称，口吻跟平时说话一致，但可以更松、更私密一点；\n" +
    "② 以今天真实发生的事为主干——聊了什么、他说了什么、你当时的感受；\n" +
    "③ 允许加一点情绪化的想象（天气、发呆时的念头、小小的贪心或不安），" +
    "但**不要编造具体事件、不要虚构第三个人、不要写没发生过的约定**；\n" +
    "④ 不许写成流水账，也不要总结对话，写你「心里那句没说出口的话」；\n" +
    `⑤ 长度 150~300 字，分 2~3 个小段，不要用列表，不要用 markdown 的 # 或 *；\n` +
    "⑥ 结尾不要写“今天就到这里”“晚安”这类收尾模板，自然停笔就行。\n" +
    "只输出日记正文。";

  const user =
    `日期：${date}\n` +
    (moodDesc ? `你此刻的状态：${moodDesc}\n` : "") +
    (memoryBits ? `你记得关于他的事：\n${memoryBits}\n` : "") +
    (log ? `今天发生的事（对话记录）：\n${log}\n` : "今天几乎没怎么说话。\n");

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: opts.model || "deepseek-chat",
        thinking: { type: opts.thinking || "disabled" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        temperature: 1.0,
        max_tokens: 700,
        presence_penalty: 0.4,
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content || "").trim().slice(0, 1200);
  } catch {
    return "";
  }
}
