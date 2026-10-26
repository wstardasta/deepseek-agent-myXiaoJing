/**
 * 情绪识别：把对方这句话读成 { emotion, intensity, needComfort }
 *
 * 两层设计：
 *   1. 规则层（快、免费、离线可用）—— 关键词 + 标点 + 语气特征
 *   2. 模型层（可选，更准）—— 用小模型做分类，失败自动退回规则层
 *
 * 规则层必须自己扛得住：就算不调模型，也要比原来那 3 条正则强得多。
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 支持的情绪标签 */
export const EMOTIONS = [
  "开心", "夸奖", "撒娇", "关心", "道歉", "难过", "焦虑",
  "累了", "生气", "敷衍", "冷淡", "凶", "恶心", "玩笑", "中性",
];

/**
 * 关键词表。故意写得很宽：宁可多认，不要漏掉真的情绪。
 * weight 表示这个词有多"实"——"哈哈哈哈"比"还行"更能说明开心。
 */
const LEXICON = {
  开心: {
    re: /(哈哈哈哈|哈哈哈|嘿嘿|嘻嘻|太棒|好耶|太好了|爽|开心|高兴|美滋滋|舒服|牛啊|厉害|爱了|好家伙|nice|yes|成了|赢了|笑死|绷不住|乐死)/i,
    weight: 0.8,
  },
  夸奖: {
    re: /(你真好|你真棒|你好棒|可爱|厉害的|好聪明|喜欢你|真乖|漂亮|牛|666|绝了|强啊|佩服|学到了|专业)/,
    weight: 0.75,
  },
  撒娇: {
    re: /(嘛|啦|呀[~～]|好不好|行不行|求求|想要你|陪我|抱抱|亲亲|想你|等我|不要走|呜+|呜呜)/,
    weight: 0.7,
  },
  关心: {
    re: /(你还好吗|没事吧|怎么了|注意身体|早点睡|别熬夜|吃饭了吗|累不累|多穿|冷不冷|照顾好|要休息|别太拼)/,
    weight: 0.8,
  },
  道歉: {
    re: /(对不起|抱歉|我错了|不该|别生气了|原谅我|是我不对|我检讨|不好意思|sorry)/i,
    weight: 0.85,
  },
  难过: {
    re: /(难过|伤心|想哭|哭死|崩了|委屈|失落|难受|心里堵|郁闷|丧|不想活|没意思|孤独|一个人|没人懂|失败|搞砸)/,
    weight: 0.85,
  },
  焦虑: {
    re: /(焦虑|紧张|慌|怕|担心|睡不着|怎么办|完蛋|来不及|压力大|烦死|急死|来不及了|来不及啦)/,
    weight: 0.8,
  },
  累了: {
    re: /(累|困|疲惫|熬不住|没力气|想睡|加班|干不动|顶不住|虚了|摊了)/,
    weight: 0.75,
  },
  生气: {
    re: /(气死|生气|火大|烦人|讨厌|受不了|凭什么|过分|无语|离谱|离谱啊|搞什么|什么玩意)/,
    weight: 0.8,
  },
  敷衍: {
    re: /^(嗯+|哦+|噢+|啊+|行|好|好嘞|知道了|收到|随便|都行|可以|哦哦|嗯嗯)[。.!！?？~～]*$/,
    weight: 0.7,
  },
  冷淡: {
    re: /(随便你|无所谓|别管我|懒得理|不想说|就这样吧|没空|忙|再说吧|不重要)/,
    weight: 0.8,
  },
  凶: {
    re: /(滚|闭嘴|烦死|别烦|讨厌你|不想理你|凶|骂|凶你|去死|废物|蠢|恶心|垃圾)/,
    weight: 0.95,
  },
  恶心: {
    re: /(恶心|猥琐|下流|变态|性骚扰|开黄腔|发我这种|别发这种)/,
    weight: 0.95,
  },
  玩笑: {
    re: /(哈哈|开玩笑|逗你|骗你的|乐|调侃|xsl|笑死|绷|草|hhh|233)/i,
    weight: 0.6,
  },
};

/**
 * 规则层识别。返回 { emotion, intensity, needComfort, scores }
 */
export function classifyByRules(text) {
  const s = String(text ?? "").trim();
  if (!s) return { emotion: "中性", intensity: 0.3, needComfort: false, scores: {} };

  const scores = {};
  for (const [emo, { re, weight }] of Object.entries(LEXICON)) {
    if (re.test(s)) scores[emo] = (scores[emo] || 0) + weight;
  }

  // ===== 标点与语气特征：这些比关键词更能说明强度 =====
  const exclaim = (s.match(/[!！]/g) || []).length;
  const question = (s.match(/[?？]/g) || []).length;
  const ellipsis = (s.match(/[…]{1,}|\.{3,}|。{3,}/g) || []).length;
  const upper = (s.match(/[A-Z]{3,}/g) || []).length;
  const repeat = /(.)\1{3,}/.test(s); // 啊啊啊啊 / 好好好好

  // 很短又没情绪词 → 大概率是敷衍
  if (s.length <= 3 && !Object.keys(scores).length) {
    scores.敷衍 = (scores.敷衍 || 0) + 0.5;
  }

  // 选最高分的；同分时按"情绪强度优先级"排（凶 > 恶心 > 道歉 > 难过 ...）
  const PRIORITY = ["凶", "恶心", "道歉", "难过", "焦虑", "生气", "关心", "撒娇", "夸奖", "开心", "累了", "冷淡", "敷衍", "玩笑"];
  let best = "中性";
  let bestScore = 0;
  for (const emo of PRIORITY) {
    const v = scores[emo] || 0;
    if (v > bestScore) {
      bestScore = v;
      best = emo;
    }
  }

  // 只有"判定成负面情绪、但其实在打哈哈"才降级成玩笑。
  // 原来这里不分正负，导致"你真棒哈哈哈哈哈"被误判成玩笑。
  const NEGATIVE = ["难过", "焦虑", "生气", "累了", "冷淡"];
  if (
    (scores.玩笑 || 0) > 0 &&
    NEGATIVE.includes(best) &&
    bestScore <= 0.85 &&
    exclaim < 2
  ) {
    best = "玩笑";
    bestScore = Math.max(scores.玩笑, 0.5);
  }

  // ===== 强度：由"命中词的实感"打底，再叠加语气特征 =====
  // 关键：不能所有句子都是同一个数，否则"滚"和"嗯"在数值上没区别。
  let intensity;
  if (best === "中性") {
    intensity = 0.3;
  } else {
    // bestScore 0.5~1.0 映射到 0.45~0.85 打底
    intensity = 0.35 + clamp(bestScore, 0.4, 1) * 0.5;
    intensity += Math.min(0.25, exclaim * 0.1);
    intensity += Math.min(0.12, question * 0.05);
    intensity += Math.min(0.1, ellipsis * 0.05);
    intensity += Math.min(0.12, upper * 0.07);
    if (repeat) intensity += 0.1; // 啊啊啊啊 / 好好好好 是在加重语气
    // 长句里堆了好几个情绪词，说明情绪更浓
    const hits = Object.keys(scores).length;
    if (hits >= 3) intensity += 0.08;
    // 全程没有标点的短促命令式（"滚 别烦我"）本身就冲
    if (s.length <= 12 && exclaim === 0 && ["凶", "恶心", "生气"].includes(best)) {
      intensity += 0.08;
    }
    // 敷衍/中性本来就该轻
    if (["敷衍", "冷淡"].includes(best)) intensity = Math.min(intensity, 0.5);
  }
  intensity = clamp(intensity, 0.1, 1);

  const needComfort = ["难过", "焦虑", "累了", "生气"].includes(best) && intensity >= 0.55;

  return { emotion: best, intensity, needComfort, scores };
}

/**
 * 模型层识别：一次很便宜的调用。
 * 失败 / 没 key → 返回 null，调用方退回规则层。
 */
export async function classifyByModel(text, opts = {}) {
  const apiKey = opts.apiKey || "";
  if (!apiKey) return null;
  const base = String(opts.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const model = opts.model || "deepseek-chat";

  const sys =
    "你是一个情绪识别器。判断下面这句话的说话人此刻的情绪。" +
    "只输出 JSON，不要任何解释，格式：" +
    '{"emotion":"标签","intensity":0.0,"target":"对谁"}\n' +
    "emotion 只能从这些里选一个：" + EMOTIONS.join("、") + "。\n" +
    "intensity 是 0 到 1 的强度，0.3=随口说说，0.7=明显，1.0=非常强烈。\n" +
    "target 只说“对对方”或“自己”或“第三者”，不要写名字。\n" +
    "注意：如果对方在开玩笑、玩梗、互损，选「玩笑」；如果只是简短回应，选「敷衍」或「中性」。";

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: String(text).slice(0, 300) },
        ],
        temperature: 0.1,
        max_tokens: 80,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    const emotion = EMOTIONS.includes(obj?.emotion) ? obj.emotion : null;
    if (!emotion) return null;
    return {
      emotion,
      intensity: clamp(Number(obj?.intensity) || 0.5, 0.1, 1),
      needComfort: ["难过", "焦虑", "累了", "生气"].includes(emotion),
      source: "model",
    };
  } catch {
    return null; // 超时 / 网络问题都静默退回规则层
  }
}

/**
 * 对外主函数：先用规则判断，规则不确定（贴边、或没有明显情绪词）时才问模型。
 * 这样 90% 的消息不花额外的钱和延迟。
 */
export async function detect(text, opts = {}) {
  const ruled = classifyByRules(text);
  const s = String(text ?? "");

  // 规则很确定的场景，直接用结果
  const verySure =
    ["凶", "恶心", "道歉", "难过", "焦虑", "关心", "撒娇"].includes(ruled.emotion) &&
    ruled.intensity >= 0.5;

  if (verySure || !opts.apiKey) return ruled;

  // 没有明显情绪词、又比较长 → 值得问一下模型（可能是反讽、压抑的表达）
  if (ruled.emotion === "中性" && s.length >= 10) {
    const m = await classifyByModel(text, opts);
    if (m) return m;
  }

  // 有情绪词但强度低、或规则只擦到边 → 也问一下，模型更懂语气
  if (ruled.intensity < 0.5 && s.length >= 6) {
    const m = await classifyByModel(text, opts);
    if (m) return m;
  }

  return ruled;
}

/**
 * 群聊气氛：把最近几条消息的情绪汇总成一个整体倾向。
 * 群里不该逐条读情绪，而该看"现在气氛是热还是冷、是在嗨还是在丧"。
 */
export function groupMood(recent = [], windowMs = 10 * 60000) {
  const now = Date.now();
  const rows = recent.filter((x) => x && now - (x.ts || 0) < windowMs);
  if (!rows.length) return { mood: "平静", intensity: 0.3, sample: 0 };

  const POS = new Set(["开心", "夸奖", "撒娇", "玩笑", "关心"]);
  const NEG = new Set(["难过", "焦虑", "生气", "凶", "恶心", "累了"]);
  const COLD = new Set(["敷衍", "冷淡"]);

  let pos = 0, neg = 0, cold = 0, hot = 0, n = 0;
  for (const r of rows) {
    const emo = r.emotion || "中性";
    const w = Number(r.intensity) || 0.4;
    n++;
    if (POS.has(emo)) pos += w;
    else if (NEG.has(emo)) neg += w;
    else if (COLD.has(emo)) cold += w;
    if (/[!！]{2,}|哈哈哈哈|笑死/.test(String(r.text || ""))) hot += w;
  }

  const norm = (v) => v / Math.max(1, n);
  let mood = "平静";
  // 用比例而不是绝对条数判断"热闹"：群里十条里有一条哈哈，不该算热闹
  if (norm(hot) >= 0.5 && hot >= neg) mood = "热闹";
  else if (norm(pos) > norm(neg) * 1.5 && norm(pos) > 0.3) mood = "轻松";
  else if (norm(neg) > norm(pos) * 1.5 && norm(neg) > 0.3) mood = "低沉";
  else if (norm(cold) >= 0.6) mood = "冷场";

  return {
    mood,
    intensity: clamp(Math.max(norm(pos), norm(neg)), 0.2, 1),
    sample: n,
  };
}

/** 气氛 → 一句 prompt 提示 */
export function groupMoodPrompt(gm) {
  if (!gm || !gm.mood || gm.mood === "平静") return "";
  const map = {
    热闹: "群里现在很热闹，大家在起哄说笑，你可以更放开、更跳一点。",
    轻松: "群里气氛轻松，随便聊，不用太正经。",
    低沉: "群里气氛有点低，可能有人心情不好。先别开玩笑、别损人，说话温和些。",
    冷场: "群里有点冷场，没人接话。你可以不用急着救场，想说话就轻轻挑个头。",
  };
  return map[gm.mood] ? `【群聊气氛：${gm.mood}】${map[gm.mood]}` : "";
}
