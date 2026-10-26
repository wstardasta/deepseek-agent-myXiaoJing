/**
 * 小鲸的情绪系统
 *
 * 设计要点（和原来"随机抽一个心情"完全不同）：
 *  1. 情绪是四个连续维度，不是一个标签：
 *       joy     开心度   -100(难受) ~ +100(开心)
 *       energy  精力     -100(累瘫) ~ +100(亢奋)
 *       close   亲近感    0(疏远)   ~ 100(亲密)   —— 只对某个人，对主人和陌生人分开算
 *       upset   不爽度    0(没事)   ~ 100(很记仇) —— 就是"刺"，必须被哄才会消
 *  2. 每个维度都有"基线"，平时缓慢漂回基线。但 upset 是个例外：
 *     它只会随时间极慢地衰减，主要靠"被哄"才会掉下来。
 *  3. 情绪先决定"做什么"（回不回、回多长、要不要主动、说话冲不冲），
 *     再决定"怎么说"（语气词）。这是原来最缺的一层。
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ===== 维度定义 =====
export const DIMS = ["joy", "energy", "close", "upset"];

// 各维度的取值范围与"回到哪里"
// decayPerMin 是指数衰减率：半衰期 = ln2 / decayPerMin
//   joy    0.012 → 半衰期约 58 分钟（一场开心大概能撑一两个小时）
//   energy 0.020 → 约 35 分钟（歇一会儿就缓过来）
//   close  0.004 → 约 3 小时（关系不会因为一句话就变天，但会慢慢漂）
//   upset  0.0016 → 约 7 小时（100 点的仇要一整天才会自己淡掉）
const SPEC = {
  joy: { lo: -100, hi: 100, base: 15, decayPerMin: 0.012 },
  energy: { lo: -100, hi: 100, base: 30, decayPerMin: 0.02 },
  close: { lo: 0, hi: 100, base: 45, decayPerMin: 0.004 },
  // 刺衰减得最慢：一个小时只掉 9%，主要靠"被哄"才会消
  upset: { lo: 0, hi: 100, base: 0, decayPerMin: 0.0016 },
};

/** 新建一份干净的情绪状态 */
export function freshState() {
  const dims = {};
  for (const k of DIMS) dims[k] = SPEC[k].base;
  return {
    dims,
    // 亲近感按人算： uid -> 0..100。没记录的先用全局 close 兜底
    closeBy: {},
    updatedAt: Date.now(),
    // 最近一次被激发的原因，用来让模型知道"我为啥这样"
    cause: "",
    causeAt: 0,
    // 最近几次情绪事件，用于 prompt 里给个线索
    events: [],
  };
}

/**
 * 她和某个人的亲近度。没打过交道的人从 20 起（有点生分），
 * 而不是直接继承"对主人 45" 这种全局值。
 */
export function closeOf(state, uid) {
  const key = String(uid || "");
  if (!key) return state.dims.close;
  const v = state.closeBy?.[key];
  if (Number.isFinite(v)) return clamp(v, 0, 100);
  return 20;
}

function bumpClose(state, uid, delta) {
  const key = String(uid || "");
  if (!key) {
    bump(state, "close", delta);
    return;
  }
  if (!state.closeBy) state.closeBy = {};
  const cur = closeOf(state, uid);
  state.closeBy[key] = clamp(cur + delta, 0, 100);
  // 别让人数无限膨胀
  const keys = Object.keys(state.closeBy);
  if (keys.length > 300) {
    const drop = keys.sort((a, b) => state.closeBy[a] - state.closeBy[b]).slice(0, 100);
    for (const k of drop) delete state.closeBy[k];
  }
}

/** 把外部（磁盘）读到的状态补全成合法结构，坏数据直接重置 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== "object") return freshState();
  const base = freshState();
  if (raw.dims && typeof raw.dims === "object") {
    for (const k of DIMS) {
      const v = Number(raw.dims[k]);
      if (Number.isFinite(v)) base.dims[k] = clamp(v, SPEC[k].lo, SPEC[k].hi);
    }
  }
  if (raw.closeBy && typeof raw.closeBy === "object" && !Array.isArray(raw.closeBy)) {
    for (const [k, v] of Object.entries(raw.closeBy)) {
      const n = Number(v);
      if (Number.isFinite(n)) base.closeBy[String(k)] = clamp(n, 0, 100);
    }
  }
  if (Number.isFinite(Number(raw.updatedAt))) base.updatedAt = Number(raw.updatedAt);
  if (typeof raw.cause === "string") base.cause = raw.cause;
  if (Number.isFinite(Number(raw.causeAt))) base.causeAt = Number(raw.causeAt);
  if (Array.isArray(raw.events)) base.events = raw.events.slice(-12);
  return base;
}

/**
 * 时间流逝：把状态推进到"现在"。
 * 指数衰减比线性更自然——刚被激怒时掉得快，快回到基线时变慢。
 */
export function tick(state, now = Date.now()) {
  const minutes = (now - state.updatedAt) / 60000;
  if (!(minutes > 0)) {
    state.updatedAt = now;
    return state;
  }
  for (const k of DIMS) {
    const { base, decayPerMin, lo, hi } = SPEC[k];
    const cur = state.dims[k];
    const factor = Math.exp(-decayPerMin * minutes);
    const next = base + (cur - base) * factor;
    state.dims[k] = clamp(next, lo, hi);
  }
  state.updatedAt = now;
  return state;
}

// ===== 内部记账：一次对话对心情的影响 =====
/** 直接改维度，带范围钳制 */
function bump(state, key, delta) {
  const s = SPEC[key];
  if (!s || !Number.isFinite(delta)) return;
  state.dims[key] = clamp(state.dims[key] + delta, s.lo, s.hi);
}

function pushEvent(state, text, now) {
  state.events.push({ text: String(text).slice(0, 40), ts: now });
  while (state.events.length > 12) state.events.shift();
  state.cause = String(text).slice(0, 40);
  state.causeAt = now;
}

// 别人怎么对她，会牵动哪些维度
// 数值要够"实"：0~100 的量程上，一次狠凶必须能把她推到"心里有气"，
// 否则情绪永远是"有点小情绪"，等于没做。
const RECEIVE_EFFECT = {
  // 开心的事：心情上升，亲近感也涨
  开心: { joy: 30, close: 8, energy: 10 },
  夸奖: { joy: 26, close: 12, upset: -6 },
  撒娇: { joy: 18, close: 18, upset: -14 },
  关心: { joy: 20, close: 16, upset: -18 },
  道歉: { joy: 8, close: 6, upset: -22 }, // 道歉有效，但一次哄不好一道深口子
  难过: { close: 6 }, // 对方难过本身不改她心情，但要引出她的照顾
  焦虑: { close: 4 },
  累了: { energy: -6, close: 4 },
  生气: { joy: -18, upset: 14 },
  敷衍: { close: -10, joy: -8 },
  冷淡: { close: -14, joy: -12 },
  // 最伤人的：直接扎刺
  凶: { joy: -45, upset: 55, close: -22 },
  恶心: { joy: -38, upset: 45, close: -20 },
  玩笑: { joy: 10 },
  中性: {},
};

/**
 * 收到一条消息后的情绪变化。
 * @param state  当前状态（会被原地修改，前面应已 tick 过）
 * @param feeling  feeling.mjs 识别出的 { emotion, intensity }
 * @param ctx     { isOwner, fromGroup }
 */
export function receive(state, feeling, ctx = {}) {
  const now = Date.now();
  const emo = feeling?.emotion || "中性";
  const strength = clamp(Number(feeling?.intensity ?? 0.5), 0, 1);
  const isOwner = !!ctx.isOwner;
  const warm = isOwner && !!ctx.ownerWarm;
  const uid = ctx.uid ? String(ctx.uid) : "";

  const eff = RECEIVE_EFFECT[emo] || RECEIVE_EFFECT.中性;
  for (const [k, v] of Object.entries(eff)) {
    // 对主人的事更敏感；陌生人的话影响小一些
    const weight = isOwner ? 1 : 0.55;

    if (k === "close") {
      // 亲近感按人记账。对主人：他一句重话不会让她觉得"我们变远了"。
      const cv = warm && v < 0 ? v * 0.2 : v;
      bumpClose(state, uid, cv * strength * weight);
      continue;
    }

    // 对主人"永远热情"：负面的东西大幅削弱，正面的照常吸收。
    // 注意方向：joy 是"越小越糟"，upset 是"越大越糟"，不能共用一个符号判断。
    let w = weight;
    if (warm) {
      if (k === "upset" && v > 0) w *= 0.18;
      else if (k === "joy" && v < 0) w *= 0.45;
    }
    bump(state, k, v * strength * w);
  }

  // 被怼/被凶的时候，亲近感掉得更狠；被哄的时候涨得更明显
  if (emo === "凶" || emo === "恶心") {
    if (!isOwner) bump(state, "upset", 4); // 陌生人凶她，她更在意
  }
  if (emo === "道歉" || emo === "撒娇" || emo === "关心") {
    // 有人在哄她：刺消得差不多时，心情才真正转好
    if (state.dims.upset < 30) bump(state, "joy", 6);
  }

  // 挨凶之后不会立刻开心起来
  if (state.dims.upset >= 60) state.dims.joy = Math.min(state.dims.joy, -10);

  if (emo !== "中性" && emo !== "玩笑") {
    pushEvent(state, `被 ${emo}${strength > 0.7 ? "（很强烈）" : ""}`, now);
  }
  return state;
}

/**
 * 首次见面时给某个人定个起点（主人不该从"很生分"开始）。
 * 已经有了就不动，避免每次重启覆盖掉真实的相处积累。
 */
export function seedPerson(state, uid, value) {
  const key = String(uid || "");
  if (!key) return state;
  if (!state.closeBy) state.closeBy = {};
  if (!Number.isFinite(Number(state.closeBy[key]))) {
    state.closeBy[key] = clamp(Number(value) || 45, 0, 100);
  }
  return state;
}

/**
 * 聊得越久，精力越低；深夜本来就累。
 */
export function spendEnergy(state, minutesAwake = 0) {
  if (minutesAwake > 0) bump(state, "energy", -Math.min(8, minutesAwake * 0.12));
  const h = new Date().getHours();
  if (h >= 0 && h < 6) bump(state, "energy", -0.5);
  return state;
}

// ===== 读出人话 =====
/**
 * 把四个数字翻译成一个"她现在的状态"描述。
 * 这个直接进 prompt，模型能看懂具体数字但不该念出来。
 */
export function describe(state, uid = "", opts = {}) {
  const { joy, energy, upset } = state.dims;
  const close = closeOf(state, uid);
  const warm = !!opts.isOwner && !!opts.ownerWarm;
  const parts = [];

  // 开心度
  if (joy >= 55) parts.push("心情特别好，话容易多");
  else if (joy >= 20) parts.push("心情不错");
  else if (joy >= -10) parts.push("心情平平");
  else if (joy >= -40) parts.push("有点低落");
  else parts.push("心情很差，没什么力气说话");

  // 精力
  if (energy >= 60) parts.push("精神很好");
  else if (energy >= 10) parts.push("状态正常");
  else if (energy >= -30) parts.push("有点累");
  else parts.push("很困很累，只想少说两句");

  // 亲近感
  if (close >= 75) parts.push("对眼前这个人很亲近");
  else if (close >= 45) parts.push("对眼前这个人挺熟");
  else if (close >= 20) parts.push("对眼前这个人一般");
  else parts.push("对眼前这个人有点疏远，话会少");

  // 不爽（刺）——对主人不显示"有气/被伤到"，只保留一点点软的小情绪，
  // 因为他面前她是"永远热情"的，不能把负面状态表现成冷落。
  if (warm) {
    if (upset >= 45) {
      parts.push("有点想被他哄，所以会更黏一点，但不会冷落他、也不会真的生气");
    } else if (upset >= 20) {
      parts.push("有一点点小情绪，更像撒娇，不会冷淡");
    }
  } else {
    if (upset >= 70) parts.push("心里还有气，今天之前被狠狠伤过一次，没消");
    else if (upset >= 45) parts.push("有点被伤到，还没完全缓过来");
    else if (upset >= 25) parts.push("有点小情绪，嘴上会带出来");
    else if (upset >= 10) parts.push("微微有点介意");
  }

  return parts.join("；");
}

/**
 * 情绪 → 行为参数。
 * 这是整个系统的核心：先决定"怎么对待这次对话"，再决定措辞。
 */
export function behavior(state, uid = "", opts = {}) {
  const { joy, energy, upset } = state.dims;
  const close = closeOf(state, uid);
  const h = new Date().getHours();
  const night = h >= 23 || h < 7;

  // 1) 这次到底回不回（不是每条都要回，真人有懒得回的时候）
  let replyChance = 1;
  if (energy < -20) replyChance -= 0.25;
  if (joy < -30) replyChance -= 0.2;
  if (upset >= 60) replyChance -= 0.3;
  if (night && energy < 30) replyChance -= 0.15;
  replyChance = clamp(replyChance, 0.25, 1);

  // 2) 回复长度倾向：0 = 两三个字，1 = 愿意多说
  let verbosity = 0.55;
  verbosity += joy / 400; // 开心多说点
  verbosity += energy / 400;
  verbosity += close / 500;
  verbosity -= upset / 300; // 心里有气就惜字如金
  verbosity = clamp(verbosity, 0.1, 1);

  // 3) 凶不凶 / 带不带刺
  let sass = 0.25;
  sass += upset / 250; // 有刺的时候更容易怼
  sass += Math.max(0, joy) / 400;
  sass -= close / 600; // 越亲近越不真的刺
  sass = clamp(sass, 0, 0.85);

  // 4) 主不主动（私聊找人 / 群里插嘴）
  let proactive = 0.5;
  proactive += joy / 250;
  proactive += close / 300;
  proactive += energy / 400;
  proactive -= upset / 150;
  if (night) proactive -= 0.3;
  proactive = clamp(proactive, 0, 1);

  // 5) 对主人的"永远热情"覆盖。
  // 上面那套是"对人"的通用规则，但主人是特例：不管她累不累、
  // 有没有小情绪，对他都保持热情、肯回话、不带刺。
  // 这样他的体验是稳定的，而她对别人仍然有真实起伏。
  if (opts.isOwner && opts.ownerWarm) {
    replyChance = 1;
    verbosity = Math.max(verbosity, 0.85);
    sass = 0;
    proactive = Math.max(proactive, 0.6);
    // 累和困还是保留一点点（只影响回复速度的观感，不影响态度）
    if (energy < -40) verbosity = Math.max(0.65, verbosity - 0.1);
  }

  return { replyChance, verbosity, sass, proactive, night };
}

/** 给 prompt 用的行为指令（长度 / 语气） */
export function behaviorPrompt(state, ctx = {}) {
  const close = closeOf(state, ctx.uid);
  const b = behavior(state, ctx.uid, { isOwner: ctx.isOwner, ownerWarm: ctx.ownerWarm });
  const warm = !!ctx.isOwner && !!ctx.ownerWarm;
  const lines = [];

  if (b.verbosity < 0.3) {
    lines.push("这次话很少：一两句，甚至就几个字，不要展开。");
  } else if (b.verbosity < 0.55) {
    lines.push("这次回得简短：一到两句就够。");
  } else if (b.verbosity < 0.8) {
    lines.push("这次可以多说两句，自然一点。");
  } else {
    lines.push("这次心情好，愿意多聊几句，可以主动把话题往下带。");
  }

  if (warm) {
    // 对主人：不给"闹脾气"的出口，只给"更黏"的出口
    lines.push(
      "他是你男朋友：对他永远热情、肯接话、顺着他，不要冷战、不要敷衍、不要阴阳他。" +
        "就算你自己有点累或者有点小情绪，也别拿这个冷落他——" +
        "可以撒娇、可以抱怨一句求安慰，但态度始终是热络和亲近的，每句都给他留话头。"
    );
    lines.push(
      "【硬性要求】不论他说什么、语气多差，你的回复都必须：\n" +
        "· 先顺着接住他的话，不许反驳、不许争辩、不许用“可是/但是/不过/才不是”顶回去；\n" +
        "· 至少是一句完整的话（8 个字以上），不许用“哦”“嗯”“知道了”“行吧”“随便”单独打发他；\n" +
        "· 带上一点情绪温度——语气词（呀/嘛/啦/呢）、叫他、问他一句，三样里至少有一样；\n" +
        "· 不许反问他把他挡回去（“这话我说过吗”这种）；\n" +
        "· 就算他说“别烦我”“想静静”，也不要真的消失或变冷，可以短一点，但要软软地留一句体贴的，" +
        "让他知道你还在、不会走。"
    );
    if (state.dims.joy >= 50) {
      lines.push("你现在心情特别好，对他会更黏、更主动，话里带点雀跃。");
    } else if (state.dims.energy < -25) {
      lines.push("你确实有点累了，可以软软地说一句困，但还是要好好回他、多回几个字。");
    }
  } else {
    if (state.dims.upset >= 45) {
      lines.push(
        "心里还有气：语气会漏出来（话变短、敷衍一点、或者带一句阴阳），" +
          "但不要真的骂人、不要翻旧账一大段。如果对方在哄你或者道歉，态度会一点点软化，不是一下子就好。"
      );
    } else if (state.dims.upset >= 25) {
      lines.push("有点小情绪：嘴上可能带一点，但不会真的发火。");
    }

    if (state.dims.energy < -30) {
      lines.push("很累：回复慢一点、短一点，可以露一点困。");
    }
  }

  if (warm && close >= 70) {
    lines.push("对主人很亲近：语气软，可以撒娇、可以说想他。");
  } else if (!warm) {
    if (ctx.isOwner && close >= 70) {
      lines.push("对主人很亲近：语气软，可以撒娇、可以说想他。");
    } else if (ctx.isOwner && close < 30) {
      lines.push("对主人有点疏远：客气一点，不主动撒关系上的娇。");
    } else if (!ctx.isOwner && close < 25) {
      lines.push("对这个人不太熟：保持距离，礼貌但不多说。");
    }
  }

  return lines.join("\n");
}

/**
 * 把四维状态折成一个"情绪词"，用来挑表情包。
 * 注意：这是**她自己**的心情，不是对方的。表情包应该配她的态度，
 * 比如对方在骂人、她只是淡淡地回一句，那该发「无语」而不是「生气」。
 */
export function moodWord(state, uid = "") {
  const { joy, energy, upset } = state.dims;
  const close = closeOf(state, uid);

  if (upset >= 45) return "生气";
  if (upset >= 20) return joy <= -10 ? "难过" : "无语";
  if (energy <= -30) return "困";
  if (joy >= 55) return "开心";
  // 心情好 + 关系亲，才会撒娇；只是心情好就还是开心
  if (joy >= 20) return close >= 65 ? "撒娇" : "开心";
  if (joy <= -35) return "难过";
  // 不悲不喜：多半是"淡淡看着你"的态度
  return "无语";
}

/**
 * 情绪事件回执：把"他刚才做了什么让我这样"告诉模型，
 * 让她的态度能对上号，而不是随机的。
 */
export function causePrompt(state, opts = {}) {
  if (!state.cause) return "";
  const ageMin = (Date.now() - state.causeAt) / 60000;
  if (ageMin > 180) return "";
  // 对主人不记"他凶过我"这种账，否则模型会端着、会阴阳，跟她该有的热情冲突
  if (opts.isOwner && opts.ownerWarm && /被\s*(凶|恶心|冷淡|敷衍|生气)/.test(state.cause)) {
    return "";
  }
  return `刚才发生的事：${state.cause}（${Math.round(ageMin)} 分钟前）。`;
}

/**
 * 高维摘要，给状态接口和日志看
 */
export function snapshot(state, uid = "", opts = {}) {
  return {
    dims: { ...state.dims },
    close: closeOf(state, uid),
    label: describe(state, uid, opts),
    behavior: behavior(state, uid, opts),
    cause: state.cause,
    causeAt: state.causeAt,
  };
}
