/**
 * 表情包库
 *
 * 为什么不用 QQ「收藏表情」：
 *   NapCat 只有 fetch_custom_face（读），没有写入收藏的接口（set_custom_face 返回 1404）。
 *   所以这里维护一个本地库：从她自己的收藏表情同步种子，再加上群里收来的图，
 *   用视觉模型判断"是不是二次元表情包 + 表达什么情绪"，发送时按情绪挑一张。
 *
 * 数据：
 *   stickers.json  { items: [{ url, emotion, anime, tagged, source, seenAt }] }
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function freshStore() {
  return { items: [], tried: [], updatedAt: Date.now() };
}

export function loadStore(file) {
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(raw?.items)) {
        return {
          items: raw.items.filter((x) => x && typeof x.url === "string").slice(-400),
          // 试过但没要的（避免反复下载同一张）
          tried: Array.isArray(raw.tried) ? raw.tried.filter((x) => typeof x === "string").slice(-600) : [],
          updatedAt: Number(raw.updatedAt) || Date.now(),
        };
      }
    }
  } catch {
    /* 坏了就重建 */
  }
  return freshStore();
}

export function saveStore(file, store) {
  try {
    writeFileSync(file, JSON.stringify(store));
  } catch {
    /* 写不进去不影响使用 */
  }
}

/** 加一张图（同一个 url 不重复加） */
export function addItem(store, { url, source = "unknown", emotion = "", anime = null, tagged = false, desc = "" }) {
  if (!url || typeof url !== "string") return false;
  if (store.items.some((x) => x.url === url)) return false;
  store.items.push({
    url,
    source,
    emotion: String(emotion || ""),
    anime: anime === null ? null : !!anime,
    tagged: !!tagged,
    desc: String(desc || "").slice(0, 40),
    seenAt: Date.now(),
  });
  while (store.items.length > 400) store.items.shift();
  return true;
}

/** 二次元但还没写画面描述的（老数据要补，不然挑选时"看不见"图） */
export function needsDesc(store, limit = 4) {
  return store.items.filter((x) => x.tagged && x.anime && !x.desc).slice(0, limit);
}

/** 这张图上有字吗？带字的梗图更容易对应具体对话 */
export function hasText(item) {
  const d = String(item?.desc || "");
  if (/无文字|没有文字|不含文字/.test(d)) return false; // "无文字"里也含"文字"，要先排除
  return /文字|写着|字[:：]|字幕/.test(d);
}

/**
 * 给"看图挑表情"用的候选列表：
 * 情绪对上的优先，再补几张别的，最多 limit 张。
 * 带字的梗图排在前面——纯人物立绘很难对应具体场景。
 */
export function pickCandidates(store, emotion = "", limit = 10) {
  const pool = store.items.filter((x) => x.tagged && x.anime);
  if (!pool.length) return [];
  const keys = EMOTION_ALIAS[emotion] || (emotion ? [emotion] : []);
  const matched = keys.length ? pool.filter((x) => keys.some((k) => x.emotion.includes(k))) : [];
  const rest = pool.filter((x) => !matched.includes(x));

  const byStale = (a, b) => (a.seenAt || 0) - (b.seenAt || 0);
  // 先按"有没有字"分层，再按最久没用排序
  const rank = (arr) =>
    arr.slice().sort((a, b) => {
      const ta = hasText(a) ? 0 : 1;
      const tb = hasText(b) ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return byStale(a, b);
    });

  const out = [...rank(matched).slice(0, 6), ...rank(rest).slice(0, limit)];
  const uniq = [...new Set(out)].slice(0, limit);
  return uniq.sort(() => Math.random() - 0.5);
}

/** 还没打过标签的 */
export function untagged(store, limit = 5) {
  return store.items.filter((x) => !x.tagged).slice(0, limit);
}

/** 统计 */
export function stats(store) {
  const total = store.items.length;
  const tagged = store.items.filter((x) => x.tagged).length;
  const anime = store.items.filter((x) => x.tagged && x.anime).length;
  return { total, tagged, anime };
}

/**
 * 缩容：库超过上限时挑最不重要的删掉。
 * 淘汰顺序（先删前面的）：
 *   1. 确认不是二次元的（anime=false）
 *   2. 最久没被发过的
 *   3. 最老的
 * 真正好用的（二次元 + 最近常用）尽量不动。
 * @returns {{removed:number, kept:number}}
 */
export function prune(store, max = 150) {
  const limit = Math.max(10, Number(max) || 150);
  if (store.items.length <= limit) return { removed: 0, kept: store.items.length };

  const score = (x) => {
    let s = 0;
    if (x.tagged && x.anime) s += 1000; // 二次元的优先保留
    if (!x.tagged) s += 300; // 还没分类的先留着，别刚收来就删
    // 最近用过的加分（用 seenAt 当"上次使用时间"）
    const ageDays = (Date.now() - (Number(x.seenAt) || 0)) / 86400000;
    s += Math.max(0, 60 - ageDays * 2);
    return s;
  };

  const sorted = [...store.items].sort((a, b) => score(a) - score(b)); // 分数低的在前
  const dropCount = store.items.length - limit;
  const drop = new Set(sorted.slice(0, dropCount));
  store.items = store.items.filter((x) => !drop.has(x));
  return { removed: dropCount, kept: store.items.length };
}

// 情绪 → 可在表情包里找的近义标签
const EMOTION_ALIAS = {
  开心: ["开心", "笑", "高兴", "得意"],
  难过: ["难过", "哭", "委屈"],
  生气: ["生气", "怒", "气"],
  害羞: ["害羞", "脸红", "羞"],
  无语: ["无语", "无奈", "扶额"],
  惊讶: ["惊讶", "震惊", "瞪"],
  困: ["困", "睡", "累"],
  撒娇: ["撒娇", "可爱", "贴贴"],
};

/**
 * 按情绪挑一张二次元表情包。
 * 返回 { item, matched }：matched 表示"这张是真的对上了当时情绪"，
 * 上层可以据此决定给不给更高概率（对上了就多发，对不上就少发）。
 */
export function pickFor(store, emotion = "") {
  const animePool = store.items.filter((x) => x.tagged && x.anime);
  if (!animePool.length) return { item: null, matched: false };

  const keys = EMOTION_ALIAS[emotion] || (emotion ? [emotion] : []);
  if (keys.length) {
    const matched = animePool.filter((x) => keys.some((k) => x.emotion.includes(k)));
    if (matched.length) {
      // 最近没发过的优先，避免老用同一张
      matched.sort((a, b) => (a.seenAt || 0) - (b.seenAt || 0));
      const pick = matched[Math.floor(Math.random() * Math.min(3, matched.length))];
      pick.seenAt = Date.now();
      return { item: pick, matched: true };
    }
  }
  // 兜底：随便挑一张，但有两个讲究——
  // ① 先避开最近用过的；② 优先挑"库里数量少"的情绪，
  //    否则「无语」这种收了十几张的会永远霸占随机结果。
  const countByEmo = {};
  for (const x of animePool) {
    const k = x.emotion || "其他";
    countByEmo[k] = (countByEmo[k] || 0) + 1;
  }
  const pool = animePool
    .slice()
    .sort((a, b) => {
      const ca = countByEmo[a.emotion || "其他"] || 1;
      const cb = countByEmo[b.emotion || "其他"] || 1;
      if (ca !== cb) return ca - cb; // 数量少的优先
      return (a.seenAt || 0) - (b.seenAt || 0); // 再按最久没用
    })
    .slice(0, 10);
  if (!pool.length) return { item: null, matched: false };
  const pick = pool[Math.floor(Math.random() * pool.length)];
  pick.seenAt = Date.now();
  return { item: pick, matched: false };
}

/** 统计每种情绪各有几张二次元表情 */
export function emotionCounts(store) {
  const m = {};
  for (const x of store.items) {
    if (!(x.tagged && x.anime)) continue;
    const k = x.emotion || "其他";
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

/**
 * 缺口优先：找出"还差得最多"的那种情绪。
 * 每种情绪都有配额，谁最少就先补谁，避免库里全是「无语」。
 */
export function pickDeficientEmotion(store, quota = 10) {
  const counts = emotionCounts(store);
  let best = null;
  for (const emo of Object.keys(EMOTION_ALIAS)) {
    const n = counts[emo] || 0;
    if (n >= quota) continue;
    if (!best || n < best.n) best = { emotion: emo, n };
  }
  return best;
}

/** 判断这张图是不是"二次元风格的表情包"，并给出情绪 + 画面描述 */
const CLASSIFY_PROMPT =
  "判断这张图是不是二次元/动漫风格的表情包（贴纸、表情、反应图那种）。" +
  "只输出 JSON：{\"anime\":true或false,\"emotion\":\"情绪词\",\"desc\":\"画面描述\",\"note\":\"\"}。" +
  "emotion 从这些里选一个：开心、难过、生气、害羞、无语、惊讶、困、撒娇、其他。" +
  "desc 要写清楚**画面上有什么 + 图上写的字**，20 字以内，例如：" +
  "\"女孩闭眼坏笑，文字：上钩\"、\"黑发猫耳少女举手，文字：出来挨打\"、\"角色低头流泪，无文字\"。" +
  "desc 是给另一个模型判断“这张图配不配这句话”用的，所以要具体，不要只写情绪。" +
  "如果它只是一张普通照片、截图、表情文字图、或者不符合二次元风格，anime 填 false。" +
  "如果画面涉及色情、暴露、血腥、真人照片，一律 anime 填 false。";

// ===== 上网找：百度图片搜索 =====
// 为什么用百度：其它站点的图片 CDN 走 Cloudflare，这台机器连不上；
// 百度的图存在 img0/1/2.baidu.com（国内 CDN），实测能下。
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 标题里带这些词的一律不要
const TITLE_BAD = /色情|裸|露点|福利|诱惑|擦边|成人|黄|胸|腿|丝袜|本子|里番|女优/;

/**
 * 用百度图片搜一批候选。
 * @returns {Promise<{url:string, title:string}[]>}
 */
export async function searchBaidu(keyword, pn = 0) {
  const url =
    "https://image.baidu.com/search/acjson?tn=resultjson_com&logid=1&ipn=rj&ct=201326592&is=&fp=result" +
    "&fr=&word=" + encodeURIComponent(keyword) +
    "&queryWord=" + encodeURIComponent(keyword) +
    "&cl=2&lm=-1&ie=utf-8&oe=utf-8&st=-1&z=&ic=&hd=&latest=&copyright=&s=&se=&tab=&width=&height=" +
    "&face=&istype=2&qc=&nc=1&expermode=&nojc=&isAsync=&pn=" + pn + "&rn=30&gsm=1e&" + Date.now() + "=";
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, referer: "https://image.baidu.com/", accept: "*/*" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return [];
    const data = await r.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    return list
      .map((x) => ({
        url: String(x?.middleURL || x?.thumbURL || "").trim(),
        title: String(x?.fromPageTitleEnc || x?.fromPageTitle || ""),
      }))
      .filter((x) => /^https?:\/\//.test(x.url) && !TITLE_BAD.test(x.title));
  } catch {
    return [];
  }
}

/**
 * 调视觉模型给一张图打标签。
 * @returns {Promise<{anime:boolean, emotion:string, note:string}|null>}
 */
export async function classify(url, opts = {}) {
  const apiKey = opts.apiKey || "";
  if (!apiKey) return null;
  const base = String(opts.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const model = opts.model || "deepseek-chat";

  // 先把图取回来转成 data URL（模型接口要 base64）
  let dataUrl = "";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 4 * 1024 * 1024) return null;
    const ct = r.headers.get("content-type") || "image/png";
    if (!/^image\//i.test(ct)) return null;
    dataUrl = `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        thinking: { type: "disabled" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: CLASSIFY_PROMPT },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 80,
        stream: false,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    return {
      anime: !!obj.anime,
      emotion: String(obj.emotion || "其他").slice(0, 8),
      desc: String(obj.desc || "").slice(0, 40),
      note: String(obj.note || "").slice(0, 20),
    };
  } catch {
    return null;
  }
}

export { clamp };
