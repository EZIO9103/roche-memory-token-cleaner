;(() => {
  "use strict";

  const PLUGIN_ID = "memory-token-cleaner";
  const APP_ID = "memory-token-cleaner-home";
  const VERSION = "2.7.0";

  const DEFAULT_SETTINGS = {
    maxChars: 180,
    preferredMin: 80,
    preferredMax: 140,
    majorMax: 220,
    keywordLimit: 4,
    batchSize: 1,
    longTermLimit: 300,
    archiveCount: 10,
    writeKeywords: true,
    executeAllAiSuggestions: false,
    showCore: false
  };

  const IMPORTANT_HINTS = [
    "承诺","答应","拒绝","边界","和解","争吵","冲突","分手","复合","告白","认错",
    "亲密","关系","信任","远距离","离开","重逢","搬家","地点","见面","以后","未来",
    "配偶","婚姻","称呼","面具","钥匙","家","公寓","主动","不再","默认","拉黑",
    "道歉","love","照片","自拍","石头","物件","贴身","香港","英国","伦敦",
    "天津","奶奶","亲属卡","家庭","归档","离港","离别"
  ];

  const LOW_VALUE_HINTS = [
    "表情","贴纸","sticker","emoji","哈哈","笑死","调侃","玩笑","破防","普通自拍",
    "吃饭","早餐","午餐","晚餐","睡觉","洗澡","刷牙","喝水","普通道歉","尴尬",
    "脸红","害羞","已读","黄段子","露骨"
  ];

  function escapeHtml(text) {
    return String(text ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function unique(arr) {
    return Array.from(new Set((arr || []).map(x => String(x || "").trim()).filter(Boolean)));
  }

  function charLen(text) {
    return [...String(text || "")].length;
  }

  function getMemoryId(item) {
    return item?.id || item?.memoryId || item?.factId || item?.sourceFactId || item?._id || "";
  }

  function getFactText(item) {
    return String(item?.summaryText || item?.action || item?.text || item?.content || "").trim();
  }

  function estimateTokens(text) {
    const s = String(text || "");
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const words = (s.replace(/[\u4e00-\u9fff]/g, " ").match(/[A-Za-z0-9_#-]+/g) || []).length;
    return Math.max(1, cjk + words + Math.ceil(Math.max(0, s.length - cjk) / 8));
  }

  function hashText(text) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    let h1 = 0xdeadbeef ^ s.length;
    let h2 = 0x41c6ce57 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return ((h2 >>> 0).toString(36) + (h1 >>> 0).toString(36));
  }

  function cleanCustomInstruction(text) {
    return String(text || "").replace(/\r/g, "").trim().slice(0, 1200);
  }

  function keywordTags(keywords, limit) {
    return unique(keywords)
      .slice(0, limit)
      .map(k => String(k).replace(/^#/, "").replace(/\s+/g, ""))
      .filter(Boolean)
      .map(k => `#${k}`)
      .join(" ");
  }

  function extractKeywordsFromText(text, limit = 4) {
    const t = String(text || "");
    const hits = [];
    const hashTags = (t.match(/#[\u4e00-\u9fffA-Za-z0-9_-]+/g) || []).map(x => x.slice(1));
    for (const k of IMPORTANT_HINTS) {
      if (t.includes(k)) hits.push(k);
    }
    return unique([...hashTags, ...hits]).slice(0, Math.max(0, limit));
  }

  function finalMemoryText(text, keywords, settings) {
    const body = String(text || "").trim();
    if (!body) return "";
    if (!settings.writeKeywords) return body;
    if (/#\S+/.test(body)) return body;
    const tags = keywordTags(keywords, settings.keywordLimit);
    return tags ? `${body} ${tags}` : body;
  }

  function stripCodeFence(text) {
    return String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }

  function repairJsonText(text) {
    return String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .trim();
  }

  function safeJsonParse(text) {
    const raw = repairJsonText(stripCodeFence(text));

    const normalize = obj => {
      if (Array.isArray(obj)) return obj;
      if (Array.isArray(obj?.items)) return obj.items;
      if (Array.isArray(obj?.results)) return obj.results;
      if (Array.isArray(obj?.proposals)) return obj.proposals;
      if (obj && typeof obj === "object") return [obj];
      return [];
    };

    try { return normalize(JSON.parse(raw)); } catch (_) {}

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { return normalize(JSON.parse(repairJsonText(fenced[1]))); } catch (_) {}
    }

    const objectStart = raw.indexOf("{");
    const objectEnd = raw.lastIndexOf("}");
    if (objectStart !== -1 && objectEnd > objectStart) {
      try { return normalize(JSON.parse(raw.slice(objectStart, objectEnd + 1))); } catch (_) {}
    }

    const arrayStart = raw.indexOf("[");
    const arrayEnd = raw.lastIndexOf("]");
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      try { return normalize(JSON.parse(raw.slice(arrayStart, arrayEnd + 1))); } catch (_) {}
    }

    return [];
  }

  function extractAiText(result) {
    if (typeof result === "string") return result;
    if (!result) return "";

    const direct = [
      result.text,
      result.content,
      result.output_text,
      result.outputText,
      result.message?.content,
      result.data?.text,
      result.data?.content,
      result.choices?.[0]?.message?.content,
      result.choices?.[0]?.text,
      result.response?.text,
      result.response?.content
    ];

    for (const c of direct) {
      if (typeof c === "string" && c.trim()) return c;
      if (Array.isArray(c)) {
        const joined = c.map(part => {
          if (typeof part === "string") return part;
          if (typeof part?.text === "string") return part.text;
          if (typeof part?.content === "string") return part.content;
          return "";
        }).filter(Boolean).join("\n");
        if (joined.trim()) return joined;
      }
    }

    const seen = new Set();
    const hits = [];
    const walk = (value, depth = 0, key = "") => {
      if (depth > 7 || value == null) return;
      if (typeof value === "string") {
        const t = value.trim();
        if (!t) return;
        const score =
          (/^\s*[\[{]/.test(t) ? 5 : 0) +
          (/"action"|"items"|KEEP|COMPRESS|SPLIT|DELETE|ARCHIVE/.test(t) ? 5 : 0) +
          (key === "text" || key === "content" || key === "message" ? 2 : 0);
        hits.push({ text: t, score });
        return;
      }
      if (typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) value.forEach(x => walk(x, depth + 1, key));
      else Object.keys(value).forEach(k => walk(value[k], depth + 1, k));
    };
    walk(result);
    hits.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
    if (hits.length) return hits[0].text;

    try { return JSON.stringify(result); } catch (_) { return ""; }
  }

  function localAnalyzeFact(text, settings) {
    const t = String(text || "");
    const len = charLen(t);
    const timeHits = (t.match(/\d{1,2}[:：]\d{2}|20\d{2}[-/年.]\d{1,2}[-/月.]\d{1,2}日?|约\s*\d{1,2}\s*时/g) || []).length;
    const timelineWords = (t.match(/随后|期间|之后|接着|同时|最终|然后|再|又|起|直到|前后/g) || []).length;
    const sentenceCount = (t.match(/[。！？.!?\n]/g) || []).length;
    const lowHits = LOW_VALUE_HINTS.filter(k => t.includes(k)).length;
    const importantHits = IMPORTANT_HINTS.filter(k => t.includes(k)).length;

    const flags = [];
    if (len > settings.maxChars) flags.push("过长");
    if (timeHits >= 2 || timelineWords >= 3) flags.push("像流水账");
    if (sentenceCount >= 3) flags.push("多事件");
    if (lowHits >= 2 && importantHits === 0) flags.push("低价值倾向");

    const priority =
      len > settings.maxChars ||
      flags.includes("像流水账") ||
      flags.includes("多事件") ||
      flags.includes("低价值倾向");

    let recommendation = "KEEP";
    if (flags.includes("低价值倾向") && importantHits === 0) recommendation = "DELETE";
    else if (priority) recommendation = "COMPRESS";

    return { len, flags, recommendation, priority, tokenEstimate: estimateTokens(t), lowHits, importantHits };
  }

  function isImportantText(text) {
    const t = String(text || "");
    return IMPORTANT_HINTS.some(k => t.includes(k));
  }

  function simpleCompressText(text, settings) {
    let t = String(text || "")
      .replace(/线上摘要\s*/g, "")
      .replace(/20\d{2}[-/年.]\d{1,2}[-/月.]\d{1,2}日?/g, "")
      .replace(/\d{1,2}[:：]\d{2}/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const parts = t.split(/[。！？.!?\n]/).map(x => x.trim()).filter(Boolean);
    const important = parts.filter(p => IMPORTANT_HINTS.some(k => p.includes(k))).slice(0, 2);
    let out = important.length ? important.join("；") : (parts[0] || t);
    if (charLen(out) > settings.majorMax) out = [...out].slice(0, settings.majorMax).join("");
    return out;
  }

  function extractEventTime(text) {
    const t = String(text || "");
    const iso = t.match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
    if (iso) {
      const y = Number(iso[1]), m = Number(iso[2]), d = Number(iso[3]);
      const time = new Date(y, m - 1, d).getTime();
      if (Number.isFinite(time)) return time;
    }
    const md = t.match(/(\d{1,2})月(\d{1,2})日/);
    if (md) {
      const now = new Date();
      const y = now.getFullYear();
      const time = new Date(y, Number(md[1]) - 1, Number(md[2])).getTime();
      if (Number.isFinite(time)) return time;
    }
    return Infinity;
  }

  function makeProposalId(prefix) {
    return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  }

  function clonePlain(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (_) { return obj; }
  }

  function normalizeSplitItems(newItems, fallbackKeywords = []) {
    if (!Array.isArray(newItems)) return [];
    return newItems.map(item => {
      if (typeof item === "string") {
        return { text: item.trim(), keywords: extractKeywordsFromText(item).slice(0, 4) };
      }
      return {
        text: String(item?.text || item?.content || item?.newText || "").trim(),
        keywords: unique(item?.keywords || fallbackKeywords).slice(0, 4)
      };
    }).filter(item => item.text);
  }

  function fallbackReviewRecords(records, settings, mode = "review") {
    return (records || []).map(record => {
      const text = String(record?.text || "");
      const analysis = localAnalyzeFact(text, settings);
      const shouldCompress =
        analysis.flags.includes("过长") ||
        analysis.flags.includes("像流水账") ||
        analysis.flags.includes("多事件") ||
        record?.localRecommendation === "COMPRESS";

      if (shouldCompress) {
        const newText = simpleCompressText(text, settings);
        return {
          id: record.id,
          action: newText ? "COMPRESS" : "KEEP",
          newText,
          newItems: [],
          keywords: extractKeywordsFromText(text + " " + newText, settings.keywordLimit),
          risk: "safe",
          reason: "本地保底压缩"
        };
      }

      return {
        id: record.id,
        action: "KEEP",
        newText: "",
        newItems: [],
        keywords: extractKeywordsFromText(text, settings.keywordLimit),
        risk: "safe",
        reason: "解析失败保留"
      };
    });
  }

  function buildReviewerPrompt(records, settings, customInstruction = "", mode = "review") {
    const compressOnly = mode === "compressOnly";
    const extra = cleanCustomInstruction(customInstruction);
    return `你是 Roche 事实记忆清理器。你不是在写剧情总结，也不是在重写人设。你的任务是把长流水账整理成少量可召回的事件记忆。

本次模式：
${compressOnly ? "仅压缩过长/流水账。只能返回 KEEP 或 COMPRESS，不能返回 DELETE 或 SPLIT。" : "完整审查。可以返回 KEEP、COMPRESS、SPLIT、DELETE。"}

最高原则：
把长流水账整理成少量可召回的事件记忆；优先保留关系后果、边界、承诺、地点、关键物品与关键称呼；删除重复噪音；不要把记忆写成人设归纳或小说摘要。

Fact Memory 规则：
1. Fact 必须像事件：谁因为什么，在什么情况下做了什么，造成什么关系后果。
2. 禁止写成二次人设或行为归纳。不要写“逐渐习惯”“形成模式”“通常会”“倾向于”“已经开始用……维持……”。
3. 不要把事件压成抽象标签。必须保留事件骨架。
4. 不要添加原文没有的信息。禁止补天气、氛围、心理动机、小说化收束句。
5. 不要为了好看而润色。只保留事件、动作、关系后果。

压缩规则：
1. 优先删除分钟级流水账，只保留日期锚、阶段锚、行程锚。
2. 保留“6月12日下午”“2026-06-23至24日”“香港最后一天”“离港前”“第一次”等有召回意义的时间。
3. 删除或弱化“04:24、05:06、05:59”这类分钟时间，除非它本身是承诺、行程或离开节点。
4. 压缩时不要强行短到一句。重大关系节点允许 140-220 中文字。
5. 如果原文只是多个小互动堆在一起，但属于同一个主题，不要拆得太碎。

SPLIT 拆分规则：
1. 不要按时间点拆分。不要因为原文有多个时间戳就拆成多条。
2. 只有当一条记忆里存在 2-3 个彼此独立、未来可单独召回、各自有长期后果的事件时，才 SPLIT。
3. 拆分依据是主题和长期后果，不是时间顺序。
4. 每条拆分结果必须能单独回答：发生了什么、为什么重要、以后为什么会被召回。
5. 如果信息只是同一事件的连续细节，应该 COMPRESS 成一条，不要 SPLIT。

关键词规则：
1. 每条新记忆的关键词只允许来自该条内容。
2. 禁止把同一组关键词复制给所有拆分条目。
3. 禁止使用与本条无关的关键词。
4. 关键词必须是具体搜索钩子，例如 #拉黑 #认错 #love #石头 #面具 #香港 #波本 #dirtytalk。
5. 避免抽象概念标签，例如 #关系 #未来 #情绪 #亲密，除非该词就是原事件核心词。
6. 关键词数量 2-4 个即可，宁少勿乱。

删除规则：
1. 普通重复调情、表情包、无新后果的照片、临时害羞、普通玩笑、重复解释，可以 DELETE。
2. 如果某个信息只是重复已知关系，不形成新事件，不要单独成条。
3. 如果普通元素承载了关系后果，例如道歉后的自拍、第一次边界让步、第一次明确拒绝降级，就不能当作噪音。
4. 不确定是否删除时，优先 COMPRESS，不要瞎删。

动作定义：
KEEP：保留，不改。
COMPRESS：单条事件仍有价值，但太长或流水账，压成一条事件记忆。
SPLIT：一条旧记忆包含 2-3 个独立重要事件，拆成 2-3 条事件记忆。
DELETE：无长期后果、重复、过时、低价值，应遗忘。

${extra ? `本次用户新增提示词：\n${extra}\n` : ""}

只返回严格 JSON 对象，不要解释，不要 Markdown。格式：
{
  "items": [
    {
      "id": "原id",
      "action": "KEEP|COMPRESS${compressOnly ? "" : "|SPLIT|DELETE"}",
      "newText": "COMPRESS时填写；其他动作可空",
      "newItems": [{"text":"SPLIT时的新记忆1","keywords":["本条关键词1"]}],
      "keywords": ["COMPRESS或DELETE时的具体关键词"],
      "risk": "safe|confirm",
      "reason": "不超过18字"
    }
  ]
}

待审查记忆：
${JSON.stringify(records, null, 2)}`;
  }

  function buildSingleCompressPrompt(record, customInstruction = "") {
    const extra = cleanCustomInstruction(customInstruction);
    return `用户不想拆分或删除这条事实记忆。请把它改为单条压缩记忆，抹去次要细节，只保留最重要的长期事件轮廓。不要 SPLIT，不要 DELETE。不要添加原文没有的信息。

${extra ? `本次用户新增提示词：\n${extra}\n` : ""}

只返回严格 JSON 对象：
{
  "items": [
    {
      "id": "${record.id}",
      "action": "COMPRESS",
      "newText": "单条压缩后的事实记忆",
      "keywords": ["具体关键词1","具体关键词2"],
      "reason": "不超过18字"
    }
  ]
}

原记忆：
${JSON.stringify(record, null, 2)}`;
  }

  function buildArchivePrompt(records, settings, customInstruction = "") {
    const extra = cleanCustomInstruction(customInstruction);
    return `你是 Roche 旧记忆归档器。你的任务不是清洗近期事实，而是模拟人脑记忆减退：把更早的事实记忆整理成模糊的阶段叙事，或删除无长期意义的旧细节。

归档目标：
1. 把旧事实从“高清流水账”变成“朴素阶段记忆”。
2. 可以按同一段时间合并多条不同事件线，例如家庭线、金钱线、冲突线、离别线，只要它们确实属于同一阶段。
3. 合并后的记忆要像一段朴素叙事：地点、人物、主要事件、关系后果。
4. 不要写成文艺描写，不要写天气、气氛、心理渲染。
5. 模糊具体日期时间，不要写几月几日、几点、早晨、中午、晚上。可以写“那段时间”“后来”“同一阶段”“六月里”“离开前后”“早期相处里”等。
6. 不要补原文没有的信息。
7. 如果旧事实只是重复小互动、普通调情、表情包、无后果照片，可以 DELETE。
8. 如果内容仍然太重要、不能减退，返回 KEEP。
9. 默认优先使用 ARCHIVE_REPLACE：生成归档记忆，并删除被归档的旧事实。

归档粒度：
- 阶段归档：允许把同一段时间的多条线合成 1-3 条阶段叙事。
- 输出每条归档记忆 120-260 中文字。
- 关键词要少而具体，2-5 个。

${extra ? `本次用户新增提示词：\n${extra}\n` : ""}

只返回严格 JSON 对象，不要解释，不要 Markdown。格式：
{
  "items": [
    {
      "sourceIds": ["被归档或删除的原id"],
      "action": "ARCHIVE_REPLACE|ARCHIVE_KEEP|DELETE|KEEP",
      "archiveText": "ARCHIVE时填写阶段叙事",
      "keywords": ["具体关键词1","具体关键词2"],
      "reason": "不超过18字"
    }
  ]
}

待归档旧记忆：
${JSON.stringify(records, null, 2)}`;
  }

  async function askAi(roche, prompt) {
    const result = await roche.ai.chat({
      messages: [
        { role: "system", content: "你是 JSON API。只输出有效 JSON 对象，格式为 {\"items\":[...]}。不要解释，不要 Markdown。" },
        { role: "user", content: prompt }
      ],
      temperature: 0
    });
    return safeJsonParse(extractAiText(result));
  }

  async function askAiForReview(roche, records, settings, customInstruction = "", mode = "review") {
    const prompt = buildReviewerPrompt(records, settings, customInstruction, mode);
    let parsed = await askAi(roche, prompt);
    if (parsed.length) return parsed;

    if (records.length > 1) {
      const recovered = [];
      for (const record of records) {
        try {
          recovered.push(...await askAiForReview(roche, [record], settings, customInstruction, mode));
        } catch (_) {
          recovered.push(...fallbackReviewRecords([record], settings, mode));
        }
      }
      return recovered;
    }

    return fallbackReviewRecords(records, settings, mode);
  }

  async function askAiForSingleCompress(roche, row, customInstruction = "") {
    const parsed = await askAi(roche, buildSingleCompressPrompt({ id: row.id, text: row.text }, customInstruction));
    return parsed?.[0] || null;
  }

  function normalizeProposal(p, factMap, settings, mode = "review") {
    const id = String(p?.id || "").trim();
    let action = String(p?.action || "KEEP").trim().toUpperCase();
    if (mode === "compressOnly" && !["KEEP","COMPRESS"].includes(action)) action = "COMPRESS";
    if (!["KEEP","COMPRESS","SPLIT","DELETE"].includes(action)) action = "KEEP";
    if (!factMap.has(id)) action = "KEEP";

    const original = factMap.get(id)?.text || "";
    const keywords = unique(p?.keywords || []).slice(0, settings.keywordLimit);
    let newText = String(p?.newText || "").trim();
    let newItems = normalizeSplitItems(p?.newItems, keywords);
    let reason = String(p?.reason || "").trim().slice(0, 40);

    let needsManual = false;
    const manualReasons = [];

    if (action === "COMPRESS") {
      if (!newText) {
        newText = simpleCompressText(original, settings);
        needsManual = true;
        manualReasons.push("AI未给压缩文本");
      }
      if (charLen(newText) > settings.majorMax) newText = [...newText].slice(0, settings.majorMax).join("");
      if (charLen(newText) < 20 && charLen(original) > 80) {
        needsManual = true;
        manualReasons.push("压缩过短");
      }
      if (charLen(newText) >= charLen(original)) {
        needsManual = true;
        manualReasons.push("未有效压缩");
      }
    }

    if (action === "SPLIT") {
      newItems = newItems.slice(0, 3).map(item => {
        const text = charLen(item.text) > settings.majorMax ? [...item.text].slice(0, settings.majorMax).join("") : item.text;
        return { text, keywords: unique(item.keywords).slice(0, settings.keywordLimit) };
      });
      if (newItems.length < 2) {
        action = "COMPRESS";
        newText = newText || simpleCompressText(original, settings);
        needsManual = true;
        manualReasons.push("拆分失败");
      }
    }

    if (action === "DELETE" && isImportantText(original)) {
      needsManual = true;
      manualReasons.push("重要内容删除");
    }

    let risk = String(p?.risk || "").toLowerCase();
    if (!["safe","confirm"].includes(risk)) risk = needsManual ? "confirm" : "safe";
    if (needsManual) risk = "confirm";

    return {
      id, sourceIds: [id], action, newText, newItems, keywords,
      reason: manualReasons[0] || reason,
      risk, needsManual,
      type: "fact"
    };
  }

  function normalizeArchiveProposal(p, rows, settings) {
    const rowIds = new Set(rows.map(r => r.id));
    const sourceIds = unique(p?.sourceIds || p?.ids || []).filter(id => rowIds.has(id));
    let action = String(p?.action || "KEEP").trim().toUpperCase();
    if (!["ARCHIVE_REPLACE","ARCHIVE_KEEP","DELETE","KEEP"].includes(action)) action = "KEEP";
    if (!sourceIds.length) action = "KEEP";

    let archiveText = String(p?.archiveText || p?.newText || p?.text || "").trim();
    const keywords = unique(p?.keywords || extractKeywordsFromText(archiveText, settings.keywordLimit)).slice(0, settings.keywordLimit);
    let needsManual = false;
    let reason = String(p?.reason || "").trim().slice(0, 40);

    if ((action === "ARCHIVE_REPLACE" || action === "ARCHIVE_KEEP") && !archiveText) {
      action = "KEEP";
      needsManual = true;
      reason = "归档为空";
    }

    return {
      id: makeProposalId("archive"),
      sourceIds,
      action,
      archiveText,
      keywords,
      reason,
      risk: needsManual ? "confirm" : "safe",
      needsManual,
      type: "archive"
    };
  }

  async function loadSettings(roche) {
    const saved = await roche.storage.get("settings");
    return { ...DEFAULT_SETTINGS, ...(saved || {}) };
  }

  async function saveSettings(roche, settings) {
    await roche.storage.set("settings", settings);
  }

  function createStyle() {
    const style = document.createElement("style");
    style.dataset.rochePlugin = PLUGIN_ID;
    style.textContent = `
      .roche-plugin-memory-token-cleaner {
        --mtc-bg:#fff; --mtc-text:#1f2328; --mtc-muted-color:rgba(31,35,40,.62);
        --mtc-card-bg:#fff; --mtc-soft-bg:#f1f3f5; --mtc-border-color:rgba(31,35,40,.13);
        --mtc-top-bg:rgba(255,255,255,.96);
        --mtc-green:#dff7e8; --mtc-green-border:#9fddb8;
        --mtc-orange:#ffe6d8; --mtc-orange-border:#ffb589;
        --mtc-blue:#dff0ff; --mtc-blue-border:#9fcaf0;
        --mtc-purple:#efe3ff; --mtc-purple-border:#c9a9f0;
        --mtc-yellow:#fff2c8; --mtc-yellow-border:#e8c75d;
        --mtc-slate:#e7edf5; --mtc-slate-border:#b9c6d8;
        --mtc-deep:#cfeedd; --mtc-deep-border:#73b98d;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--mtc-text); background: var(--mtc-bg);
        position:absolute; inset:0; display:block;
        padding:14px; padding-bottom:calc(40px + env(safe-area-inset-bottom,0px));
        overflow-y:auto !important; overflow-x:hidden !important;
        -webkit-overflow-scrolling:touch; overscroll-behavior-y:contain;
        box-sizing:border-box;
      }
      @media (prefers-color-scheme: dark) {
        .roche-plugin-memory-token-cleaner {
          --mtc-bg:#111216; --mtc-text:#f4f6f8; --mtc-muted-color:rgba(244,246,248,.68);
          --mtc-card-bg:rgba(255,255,255,.07); --mtc-soft-bg:rgba(255,255,255,.10); --mtc-border-color:rgba(255,255,255,.14);
          --mtc-top-bg:rgba(17,18,22,.96);
          --mtc-green:rgba(70,190,120,.22); --mtc-green-border:rgba(110,220,150,.45);
          --mtc-orange:rgba(255,120,70,.22); --mtc-orange-border:rgba(255,170,120,.45);
          --mtc-blue:rgba(80,155,220,.22); --mtc-blue-border:rgba(120,190,255,.45);
          --mtc-purple:rgba(160,100,230,.25); --mtc-purple-border:rgba(200,160,255,.45);
          --mtc-yellow:rgba(230,180,60,.24); --mtc-yellow-border:rgba(245,210,110,.50);
          --mtc-slate:rgba(120,145,170,.25); --mtc-slate-border:rgba(160,180,210,.45);
          --mtc-deep:rgba(40,150,90,.35); --mtc-deep-border:rgba(90,220,140,.55);
        }
      }
      .roche-plugin-memory-token-cleaner * { box-sizing:border-box; }
      .roche-plugin-memory-token-cleaner .mtc-top {
        display:flex; gap:8px; align-items:center; margin-bottom:12px;
        position:sticky; top:0; z-index:10; padding:4px 0 8px;
        background:var(--mtc-top-bg); backdrop-filter:blur(10px); border-bottom:1px solid var(--mtc-border-color);
      }
      .roche-plugin-memory-token-cleaner .mtc-title { font-size:19px; font-weight:700; flex:1; }
      .roche-plugin-memory-token-cleaner button,
      .roche-plugin-memory-token-cleaner select,
      .roche-plugin-memory-token-cleaner input,
      .roche-plugin-memory-token-cleaner textarea {
        border-radius:12px; border:1px solid var(--mtc-border-color); background:var(--mtc-card-bg); color:var(--mtc-text);
        padding:9px 10px; font-size:14px; font-family:inherit;
      }
      .roche-plugin-memory-token-cleaner textarea { width:100%; min-height:96px; resize:vertical; line-height:1.5; }
      .roche-plugin-memory-token-cleaner button { cursor:pointer; -webkit-tap-highlight-color:transparent; touch-action:manipulation; }
      .roche-plugin-memory-token-cleaner button:disabled { opacity:.45; cursor:not-allowed; }
      .roche-plugin-memory-token-cleaner .mtc-card,
      .roche-plugin-memory-token-cleaner .mtc-fact {
        border:1px solid var(--mtc-border-color); background:var(--mtc-card-bg); border-radius:16px; padding:12px; margin:10px 0;
      }
      .roche-plugin-memory-token-cleaner .mtc-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .roche-plugin-memory-token-cleaner .mtc-row select { flex:1; min-width:180px; }
      .roche-plugin-memory-token-cleaner .mtc-muted, .roche-plugin-memory-token-cleaner .mtc-field-note { color:var(--mtc-muted-color); font-size:12px; line-height:1.45; }
      .roche-plugin-memory-token-cleaner .mtc-stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .roche-plugin-memory-token-cleaner .mtc-stat { background:var(--mtc-soft-bg); border-radius:12px; padding:9px; }
      .roche-plugin-memory-token-cleaner .mtc-stat b { display:block; font-size:18px; }
      .roche-plugin-memory-token-cleaner .mtc-action-grid { display:grid; grid-template-columns:1fr; gap:8px; }
      .roche-plugin-memory-token-cleaner .mtc-action {
        text-align:left; padding:11px 12px; display:block; border-width:1px; width:100%;
      }
      .roche-plugin-memory-token-cleaner .mtc-action b { display:block; font-size:15px; margin-bottom:2px; }
      .roche-plugin-memory-token-cleaner .mtc-action span { display:block; font-size:12px; line-height:1.35; color:var(--mtc-muted-color); }
      .roche-plugin-memory-token-cleaner .act-new { background:var(--mtc-green); border-color:var(--mtc-green-border); }
      .roche-plugin-memory-token-cleaner .act-wash { background:var(--mtc-orange); border-color:var(--mtc-orange-border); }
      .roche-plugin-memory-token-cleaner .act-compress { background:var(--mtc-blue); border-color:var(--mtc-blue-border); }
      .roche-plugin-memory-token-cleaner .act-archive { background:var(--mtc-purple); border-color:var(--mtc-purple-border); }
      .roche-plugin-memory-token-cleaner .act-prompt { background:var(--mtc-yellow); border-color:var(--mtc-yellow-border); }
      .roche-plugin-memory-token-cleaner .act-review { background:var(--mtc-slate); border-color:var(--mtc-slate-border); }
      .roche-plugin-memory-token-cleaner .act-apply { background:var(--mtc-deep); border-color:var(--mtc-deep-border); }
      .roche-plugin-memory-token-cleaner .mtc-badges { display:flex; gap:5px; flex-wrap:wrap; }
      .roche-plugin-memory-token-cleaner .mtc-badge {
        display:inline-flex; align-items:center; border-radius:999px; padding:2px 7px; font-size:11px;
        background:var(--mtc-card-bg); border:1px solid var(--mtc-border-color);
      }
      .roche-plugin-memory-token-cleaner .mtc-badge.warn { background:rgba(255,180,60,.14); border-color:rgba(255,180,60,.3); }
      .roche-plugin-memory-token-cleaner .mtc-badge.danger { background:rgba(255,80,80,.14); border-color:rgba(255,80,80,.3); }
      .roche-plugin-memory-token-cleaner .mtc-badge.confirm { background:rgba(180,120,255,.14); border-color:rgba(180,120,255,.35); }
      .roche-plugin-memory-token-cleaner .mtc-text { white-space:pre-wrap; line-height:1.5; font-size:13px; word-break:break-word; }
      .roche-plugin-memory-token-cleaner .mtc-proposal { margin-top:8px; padding:8px; border-radius:10px; background:rgba(90,140,255,.10); border:1px solid var(--mtc-slate-border); }
      .roche-plugin-memory-token-cleaner .mtc-edit-text { width:100%; min-height:86px; margin-top:6px; font-size:13px; line-height:1.5; }
      .roche-plugin-memory-token-cleaner .mtc-split-box { padding:8px; border-radius:12px; border:1px solid var(--mtc-border-color); background:var(--mtc-card-bg); margin-top:8px; }
      .roche-plugin-memory-token-cleaner .mtc-mini-title { font-weight:700; margin:10px 0 6px; }
      .roche-plugin-memory-token-cleaner .mtc-settings-grid { display:grid; grid-template-columns:1fr 90px; gap:8px; align-items:center; }
      .roche-plugin-memory-token-cleaner .mtc-switch-button {
        width:100%; display:grid; grid-template-columns:1fr auto; gap:12px; align-items:center; text-align:left;
        padding:12px 10px; border-radius:0; border-width:0 0 1px 0; background:transparent;
      }
      .roche-plugin-memory-token-cleaner .mtc-switch-pill { min-width:44px; text-align:center; border-radius:999px; padding:4px 10px; font-size:12px; background:var(--mtc-soft-bg); border:1px solid var(--mtc-border-color); }
      .roche-plugin-memory-token-cleaner .mtc-switch-button.on .mtc-switch-pill { background:var(--mtc-deep); border-color:var(--mtc-deep-border); }
      .roche-plugin-memory-token-cleaner .hidden { display:none !important; }
      .roche-plugin-memory-token-cleaner .mtc-log { max-height:120px; overflow:auto; font-size:12px; line-height:1.4; background:var(--mtc-soft-bg); border-radius:12px; padding:8px; }
      .roche-plugin-memory-token-cleaner .mtc-bottom-spacer { height:calc(80px + env(safe-area-inset-bottom,0px)); }
    `;
    return style;
  }

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: "记忆低Token清理器",
    version: VERSION,
    apps: [{
      id: APP_ID,
      name: "记忆低Token清理器",
      icon: "settings",
      async mount(container, roche) {
        const style = createStyle();
        document.head.appendChild(style);

        const previous = {
          overflow: container.style.overflow,
          height: container.style.height,
          minHeight: container.style.minHeight,
          position: container.style.position
        };
        container.style.position = "relative";
        container.style.overflow = "hidden";
        container.style.height = "100dvh";
        container.style.minHeight = "0";

        const root = document.createElement("div");
        root.className = "roche-plugin-memory-token-cleaner";
        container.replaceChildren(root);

        let state = {
          settings: await loadSettings(roche),
          conversations: [],
          conversationId: "",
          facts: [],
          core: null,
          proposals: new Map(),
          tracker: { known: {}, cleanedAt: null },
          customInstruction: "",
          reviewMode: "review",
          showPrompt: false,
          showResults: false,
          busy: false
        };

        const trackerKey = () => `memory-token-cleaner-tracker:${state.conversationId || "none"}`;

        function log(msg) {
          const el = root.querySelector("#mtc-log");
          if (!el) return;
          const time = new Date().toLocaleTimeString();
          el.insertAdjacentHTML("afterbegin", `<div>[${escapeHtml(time)}] ${escapeHtml(msg)}</div>`);
        }

        function setBusy(busy) {
          state.busy = busy;
          render();
        }

        async function loadTracker() {
          if (!state.conversationId) {
            state.tracker = { known: {}, cleanedAt: null };
            return;
          }
          const saved = await roche.storage.get(trackerKey());
          state.tracker = saved && typeof saved === "object" ? { known: saved.known || {}, cleanedAt: saved.cleanedAt || null } : { known: {}, cleanedAt: null };
        }

        async function saveTracker() {
          if (!state.conversationId) return;
          await roche.storage.set(trackerKey(), state.tracker);
        }

        async function markAllKnown() {
          const known = {};
          for (const r of currentRows()) {
            if (r.id) known[r.id] = r.hash;
          }
          state.tracker = { known, cleanedAt: new Date().toISOString() };
          await saveTracker();
        }

        function currentRows() {
          const known = state.tracker?.known || {};
          return state.facts.map((item, index) => {
            const id = getMemoryId(item) || `idx_${index}`;
            const text = getFactText(item);
            const hash = hashText(text);
            const oldHash = known[id];
            const isKnown = oldHash === hash;
            const isChanged = !!oldHash && oldHash !== hash;
            const isNew = !oldHash;
            return { id, item, text, hash, oldHash, isKnown, isChanged, isNew, index, analysis: localAnalyzeFact(text, state.settings), eventTime: extractEventTime(text) };
          });
        }

        function stats() {
          const rows = currentRows();
          const proposals = Array.from(state.proposals.values());
          return {
            rows,
            totalTokens: rows.reduce((sum, r) => sum + r.analysis.tokenEstimate, 0),
            newCount: rows.filter(r => r.isNew || r.isChanged).length,
            priority: rows.filter(r => r.analysis.priority).length,
            aiResults: proposals.length,
            needsManual: proposals.filter(p => p.needsManual).length,
            actionable: proposals.filter(p => p.action !== "KEEP").length
          };
        }

        async function loadConversations() {
          setBusy(true);
          try {
            let list = [];
            if (roche.conversation?.list) {
              const convs = await roche.conversation.list();
              list = (Array.isArray(convs) ? convs : []).map(c => ({
                ...c,
                id: c.id || c.conversationId || "",
                name: c.name || c.title || c.handle || c.displayName || c.id || c.conversationId || "未命名会话",
                source: "conversation"
              }));
              log(`通过 conversation.list 读取 ${list.length} 个会话。`);
            }

            if ((!list || !list.length) && roche.character?.list) {
              const chars = await roche.character.list();
              list = (Array.isArray(chars) ? chars : [])
                .map(ch => ({
                  id: ch.conversationId || "",
                  characterId: ch.id || "",
                  name: ch.handle || ch.name || ch.displayName || ch.id || "未命名角色",
                  type: "character",
                  source: "character"
                }))
                .filter(c => c.id);
              log(`改用 character.list 读取 ${list.length} 个角色会话。`);
            }

            state.conversations = Array.isArray(list) ? list : [];
            if (!state.conversationId && state.conversations.length) state.conversationId = state.conversations[0].id;
          } catch (err) {
            roche.ui.toast("读取会话失败：" + (err?.message || err));
            log("读取会话失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        async function loadMemory({ silent = false } = {}) {
          if (!state.conversationId) {
            roche.ui.toast("请先选择会话。");
            return;
          }
          if (!silent) setBusy(true);
          try {
            await loadTracker();
            const memory = await roche.memory.getLongTerm({
              conversationId: state.conversationId,
              limit: state.settings.longTermLimit
            });
            state.core = memory?.core || null;
            state.facts = Array.isArray(memory?.facts) ? memory.facts : [];
            state.proposals.clear();
            state.showResults = false;
            log(`已读取事实记忆 ${state.facts.length} 条。`);
          } catch (err) {
            roche.ui.toast("读取记忆失败：" + (err?.message || err));
            log("读取记忆失败：" + (err?.message || err));
          } finally {
            if (!silent) setBusy(false);
          }
        }

        async function reviewRows(rows, mode = "review") {
          if (!rows.length) {
            roche.ui.toast("没有需要处理的记忆。");
            return;
          }
          state.customInstruction = cleanCustomInstruction(root.querySelector("#mtc-custom-instruction")?.value || state.customInstruction || "");
          state.reviewMode = mode;
          state.proposals.clear();
          setBusy(true);
          try {
            let count = 0;
            for (let i = 0; i < rows.length; i += state.settings.batchSize) {
              const batch = rows.slice(i, i + state.settings.batchSize);
              const records = batch.map(r => ({
                id: r.id,
                text: r.text,
                localFlags: r.analysis.flags,
                localRecommendation: r.analysis.recommendation
              }));
              log(`AI处理第 ${Math.floor(i / state.settings.batchSize) + 1} 批，共 ${records.length} 条。`);
              const raw = await askAiForReview(roche, records, state.settings, state.customInstruction, mode);
              const factMap = new Map(currentRows().map(r => [r.id, r]));
              raw.map(p => normalizeProposal(p, factMap, state.settings, mode)).forEach(p => {
                state.proposals.set(p.id, p);
                count++;
              });
            }
            state.showResults = true;
            const st = stats();
            roche.ui.toast(`已生成 ${st.aiResults} 条结果，可查看编辑或直接应用。`);
            log(`AI处理完成：${count} 条结果。`);
          } catch (err) {
            roche.ui.toast("AI处理失败：" + (err?.message || err));
            log("AI处理失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        async function washAll() {
          await reviewRows(currentRows(), "review");
        }

        async function cleanNew() {
          const rows = currentRows().filter(r => r.isNew || r.isChanged);
          if (!state.tracker?.cleanedAt) {
            const ok = await roche.ui.confirm({
              title: "首次清理提示",
              message: "此角色还没有清理记录，所有事实都会视为新增。确定继续清理新增吗？"
            });
            if (!ok) return;
          }
          await reviewRows(rows, "review");
        }

        async function quickCompressFlagged() {
          const rows = currentRows().filter(r =>
            r.analysis.flags.includes("过长") ||
            r.analysis.flags.includes("像流水账") ||
            r.analysis.flags.includes("多事件")
          );
          await reviewRows(rows, "compressOnly");
        }

        async function archiveOldMemories() {
          const rows = currentRows()
            .slice()
            .sort((a, b) => (a.eventTime - b.eventTime) || (a.index - b.index))
            .slice(0, Math.max(3, state.settings.archiveCount));
          if (!rows.length) {
            roche.ui.toast("没有可归档的事实记忆。");
            return;
          }

          const ok = await roche.ui.confirm({
            title: "旧记忆归档",
            message: `将读取最旧的 ${rows.length} 条事实记忆，生成阶段叙事归档。原记忆不会立刻改变，需点“应用全部结果”后才写回。继续吗？`
          });
          if (!ok) return;

          state.customInstruction = cleanCustomInstruction(root.querySelector("#mtc-custom-instruction")?.value || state.customInstruction || "");
          state.proposals.clear();
          setBusy(true);
          try {
            const records = rows.map(r => ({ id: r.id, text: r.text }));
            const raw = await askAi(roche, buildArchivePrompt(records, state.settings, state.customInstruction));
            const normalized = raw.map(p => normalizeArchiveProposal(p, rows, state.settings)).filter(p => p.sourceIds.length);
            for (const p of normalized) state.proposals.set(p.id, p);
            state.showResults = true;
            roche.ui.toast(`已生成 ${normalized.length} 条归档结果。`);
            log(`旧记忆归档完成：${normalized.length} 条结果。`);
          } catch (err) {
            roche.ui.toast("旧记忆归档失败：" + (err?.message || err));
            log("旧记忆归档失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        async function updateMemory(id, text) {
          await roche.memory.update(id, {
            summaryText: text,
            action: text,
            text,
            content: text,
            source: "plugin_memory_token_cleaner_v27"
          });
        }

        async function writeMemory(text) {
          if (!roche.memory.write) throw new Error("当前 Roche API 未提供 memory.write。");
          return await roche.memory.write({
            conversationId: state.conversationId,
            type: "fact",
            summaryText: text,
            action: text,
            text,
            content: text,
            source: "plugin_memory_token_cleaner_v27"
          });
        }

        function syncEditedProposal(id) {
          const p = state.proposals.get(id);
          if (!p) return p;

          if (p.type === "archive") {
            const el = root.querySelector(`textarea[data-role="archive"][data-id="${CSS.escape(id)}"]`);
            if (el) {
              p.archiveText = el.value.trim();
              p.keywords = [];
            }
            return p;
          }

          if (p.action === "COMPRESS") {
            const el = root.querySelector(`textarea[data-role="compress"][data-id="${CSS.escape(id)}"]`);
            if (el) {
              p.newText = el.value.trim();
              p.keywords = [];
            }
          }

          if (p.action === "SPLIT") {
            const boxes = Array.from(root.querySelectorAll(`textarea[data-role="split"][data-id="${CSS.escape(id)}"]`));
            if (boxes.length) {
              p.newItems = boxes.map(el => ({ text: el.value.trim(), keywords: [] })).filter(item => item.text);
            }
          }

          state.proposals.set(id, p);
          return p;
        }

        function syncAllEdited() {
          Array.from(state.proposals.keys()).forEach(id => syncEditedProposal(id));
        }

        async function applyOneProposal(p) {
          if (!p || p.action === "KEEP") return "skip";

          if (p.type === "archive") {
            const text = finalMemoryText(p.archiveText, p.keywords, state.settings);
            if (p.action === "DELETE") {
              for (const id of p.sourceIds) await roche.memory.delete(id);
              return "delete";
            }
            if (p.action === "ARCHIVE_REPLACE" || p.action === "ARCHIVE_KEEP") {
              if (!text) return "skip";
              try {
                await writeMemory(text);
                if (p.action === "ARCHIVE_REPLACE") {
                  for (const id of p.sourceIds) await roche.memory.delete(id);
                }
                return "archive";
              } catch (err) {
                const [first, ...rest] = p.sourceIds;
                await updateMemory(first, text);
                if (p.action === "ARCHIVE_REPLACE") {
                  for (const id of rest) await roche.memory.delete(id);
                }
                return "archive-fallback";
              }
            }
            return "skip";
          }

          const original = currentRows().find(r => r.id === p.id);
          if (!original) return "skip";

          if (p.action === "DELETE") {
            await roche.memory.delete(p.id);
            return "delete";
          }

          if (p.action === "COMPRESS") {
            const text = finalMemoryText(p.newText, p.keywords, state.settings);
            if (!text) return "skip";
            await updateMemory(p.id, text);
            return "compress";
          }

          if (p.action === "SPLIT") {
            const items = (p.newItems || []).map(x => finalMemoryText(x.text || x, x.keywords || [], state.settings)).filter(Boolean);
            if (items.length < 2) return "skip";
            try {
              for (const item of items) await writeMemory(item);
              await roche.memory.delete(p.id);
              return "split";
            } catch (err) {
              await updateMemory(p.id, items.join("\n"));
              return "split-fallback";
            }
          }
          return "skip";
        }

        async function applyAllResults() {
          syncAllEdited();
          const proposals = Array.from(state.proposals.values()).filter(p => p.action !== "KEEP");
          if (!proposals.length) {
            roche.ui.toast("没有可应用的 AI 结果。");
            return;
          }

          const ok = await roche.ui.confirm({
            title: "应用全部结果",
            message: `将应用 ${proposals.length} 条结果，包括压缩、拆分、删除或归档。确定继续吗？`
          });
          if (!ok) return;

          setBusy(true);
          try {
            const done = { compress:0, delete:0, split:0, archive:0, skip:0 };
            for (const p of proposals) {
              const r = await applyOneProposal(p);
              if (r === "compress") done.compress++;
              else if (r === "delete") done.delete++;
              else if (r.startsWith("split")) done.split++;
              else if (r.startsWith("archive")) done.archive++;
              else done.skip++;
            }
            await loadMemory({ silent: true });
            await markAllKnown();
            state.proposals.clear();
            state.showResults = false;
            roche.ui.toast(`完成：压缩 ${done.compress}，拆分 ${done.split}，删除 ${done.delete}，归档 ${done.archive}。`);
            log(`已应用全部结果：压缩 ${done.compress}，拆分 ${done.split}，删除 ${done.delete}，归档 ${done.archive}，跳过 ${done.skip}。`);
            render();
          } catch (err) {
            roche.ui.toast("应用失败：" + (err?.message || err));
            log("应用失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        function markKeep(id) {
          const p = state.proposals.get(id);
          if (!p) return;
          if (!p._savedOriginal) p._savedOriginal = clonePlain(p);
          p.action = "KEEP";
          p._marked = "keep";
          p.needsManual = false;
          state.proposals.set(id, p);
          render();
        }

        function markDelete(id) {
          const p = state.proposals.get(id);
          if (!p) return;
          if (!p._savedOriginal) p._savedOriginal = clonePlain(p);
          p.action = "DELETE";
          p._marked = "delete";
          p.needsManual = false;
          state.proposals.set(id, p);
          render();
        }

        function undoMark(id) {
          const p = state.proposals.get(id);
          if (!p) return;
          if (p._savedOriginal) state.proposals.set(id, p._savedOriginal);
          else state.proposals.delete(id);
          render();
        }

        async function rerunOneAi(id) {
          const p = state.proposals.get(id);
          const row = currentRows().find(r => r.id === id);
          if (!row) return;
          state.customInstruction = cleanCustomInstruction(root.querySelector("#mtc-custom-instruction")?.value || state.customInstruction || "");
          setBusy(true);
          try {
            const raw = await askAiForReview(roche, [{
              id: row.id,
              text: row.text,
              localFlags: row.analysis.flags,
              localRecommendation: row.analysis.recommendation
            }], state.settings, state.customInstruction, state.reviewMode);
            const factMap = new Map(currentRows().map(r => [r.id, r]));
            const next = normalizeProposal(raw[0] || { id, action:"KEEP" }, factMap, state.settings, state.reviewMode);
            state.proposals.set(id, next);
            state.showResults = true;
            roche.ui.toast("已重新生成。");
          } catch (err) {
            roche.ui.toast("重改失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        async function convertToSingleCompress(id) {
          const row = currentRows().find(r => r.id === id);
          if (!row) return;
          state.customInstruction = cleanCustomInstruction(root.querySelector("#mtc-custom-instruction")?.value || state.customInstruction || "");
          setBusy(true);
          try {
            const raw = await askAiForSingleCompress(roche, row, state.customInstruction);
            const factMap = new Map(currentRows().map(r => [r.id, r]));
            const p = normalizeProposal(raw || { id, action:"COMPRESS", newText: simpleCompressText(row.text, state.settings) }, factMap, state.settings, "compressOnly");
            state.proposals.set(id, p);
            state.showResults = true;
            roche.ui.toast("已改为单条压缩。");
          } catch (err) {
            const factMap = new Map(currentRows().map(r => [r.id, r]));
            state.proposals.set(id, normalizeProposal({ id, action:"COMPRESS", newText: simpleCompressText(row.text, state.settings) }, factMap, state.settings, "compressOnly"));
            roche.ui.toast("AI重写失败，已用本地压缩。");
          } finally {
            setBusy(false);
          }
        }

        async function saveSettingsFromUi() {
          const next = { ...state.settings };
          const num = (id, fallback) => {
            const v = Number(root.querySelector(id)?.value);
            return Number.isFinite(v) ? v : fallback;
          };
          next.maxChars = Math.max(80, Math.min(400, num("#mtc-max-chars", next.maxChars)));
          next.preferredMin = Math.max(30, Math.min(200, num("#mtc-pref-min", next.preferredMin)));
          next.preferredMax = Math.max(next.preferredMin, Math.min(260, num("#mtc-pref-max", next.preferredMax)));
          next.majorMax = Math.max(next.preferredMax, Math.min(360, num("#mtc-major-max", next.majorMax)));
          next.keywordLimit = Math.max(0, Math.min(8, num("#mtc-keyword-limit", next.keywordLimit)));
          next.batchSize = Math.max(1, Math.min(10, num("#mtc-batch-size", next.batchSize)));
          next.longTermLimit = Math.max(50, Math.min(1000, num("#mtc-long-limit", next.longTermLimit)));
          next.archiveCount = Math.max(3, Math.min(30, num("#mtc-archive-count", next.archiveCount)));
          state.settings = next;
          await saveSettings(roche, next);
          roche.ui.toast("设置已保存。");
          render();
        }

        async function restoreDefaultSettings() {
          const first = await roche.ui.confirm({
            title: "恢复默认设置",
            message: "将恢复插件初始参数与高级开关。当前会话记忆不会被修改。"
          });
          if (!first) return;
          const second = await roche.ui.confirm({
            title: "再次确认",
            message: "确定恢复默认设置吗？此操作只影响插件设置。"
          });
          if (!second) return;
          state.settings = { ...DEFAULT_SETTINGS };
          state.customInstruction = "";
          await saveSettings(roche, state.settings);
          roche.ui.toast("已恢复默认设置。");
          render();
        }

        function renderSwitchRow(key, label, value) {
          return `
            <button type="button" class="mtc-switch-button ${value ? "on" : ""}" data-setting-key="${escapeHtml(key)}" aria-pressed="${value ? "true" : "false"}">
              <span>${escapeHtml(label)}</span>
              <span class="mtc-switch-pill">${value ? "开" : "关"}</span>
            </button>
          `;
        }

        function actionBadge(p) {
          if (!p) return "";
          const act = p._marked === "keep" ? "标记保留" : (p._marked === "delete" ? "标记删除" : p.action);
          const cls = p.action === "DELETE" || p._marked === "delete" ? "danger" : (p.needsManual ? "confirm" : "warn");
          return `<span class="mtc-badge ${cls}">${escapeHtml(act)}</span>`;
        }

        function renderArchiveProposal(p, factMap) {
          const sourceText = (p.sourceIds || []).map(id => factMap.get(id)?.text).filter(Boolean);
          return `
            <div class="mtc-fact" data-id="${escapeHtml(p.id)}">
              <div class="mtc-badges">
                ${actionBadge(p)}
                <span class="mtc-badge">来源 ${p.sourceIds.length} 条</span>
                ${p.reason ? `<span class="mtc-badge">${escapeHtml(p.reason)}</span>` : ""}
              </div>
              <details style="margin-top:8px">
                <summary class="mtc-muted">原记忆组</summary>
                ${sourceText.map((t, i) => `<div class="mtc-text" style="margin-top:6px">${i + 1}. ${escapeHtml(t)}</div>`).join("")}
              </details>
              ${p.action === "DELETE" ? `<div class="mtc-proposal"><div class="mtc-text">已标记删除这些旧记忆。</div></div>` : `
                <div class="mtc-muted" style="margin-top:8px">归档记忆，可编辑</div>
                <textarea class="mtc-edit-text" data-role="archive" data-id="${escapeHtml(p.id)}">${escapeHtml(finalMemoryText(p.archiveText, p.keywords, state.settings))}</textarea>
              `}
              ${renderCardActions(p)}
            </div>
          `;
        }

        function renderFactProposal(p, factMap) {
          const original = factMap.get(p.id)?.text || "";
          const isKeep = p.action === "KEEP";
          const splitBlocks = p.action === "SPLIT" ? (p.newItems || []).map((item, i) => `
            <div class="mtc-split-box">
              <div class="mtc-muted">新记忆 ${i + 1}</div>
              <textarea class="mtc-edit-text" data-role="split" data-id="${escapeHtml(p.id)}" data-index="${i}">${escapeHtml(finalMemoryText(item.text, item.keywords, state.settings))}</textarea>
            </div>
          `).join("") : "";

          return `
            <div class="mtc-fact" data-id="${escapeHtml(p.id)}">
              <div class="mtc-badges">
                ${actionBadge(p)}
                ${isKeep ? `<span class="mtc-badge">KEEP</span>` : ""}
                ${p.needsManual ? `<span class="mtc-badge confirm">需处理</span>` : ""}
                ${p.reason ? `<span class="mtc-badge">${escapeHtml(p.reason)}</span>` : ""}
              </div>
              <details style="margin-top:8px">
                <summary class="mtc-muted">原记忆</summary>
                <div class="mtc-text">${escapeHtml(original)}</div>
              </details>
              ${p.action === "COMPRESS" ? `
                <div class="mtc-muted" style="margin-top:8px">AI改后，可编辑</div>
                <textarea class="mtc-edit-text" data-role="compress" data-id="${escapeHtml(p.id)}">${escapeHtml(finalMemoryText(p.newText, p.keywords, state.settings))}</textarea>
              ` : ""}
              ${p.action === "SPLIT" ? `
                <div class="mtc-muted" style="margin-top:8px">拆分为 ${p.newItems.length} 条，可分别编辑</div>
                ${splitBlocks}
              ` : ""}
              ${p.action === "DELETE" ? `<div class="mtc-proposal"><div class="mtc-text">已标记删除这条记忆。</div></div>` : ""}
              ${renderCardActions(p)}
            </div>
          `;
        }

        function renderCardActions(p) {
          const id = escapeHtml(p.id);
          const isArchive = p.type === "archive";
          const canCompress = !isArchive && (p.action === "SPLIT" || p.action === "DELETE");
          return `
            <div class="mtc-row" style="margin-top:8px">
              ${!isArchive ? `<button type="button" data-action="rerun" data-id="${id}">让AI重改</button>` : ""}
              ${canCompress ? `<button type="button" data-action="single-compress" data-id="${id}">改为单条压缩</button>` : ""}
              <button type="button" data-action="mark-keep" data-id="${id}">保留原文</button>
              <button type="button" class="danger" data-action="mark-delete" data-id="${id}">删除这条</button>
              ${p._marked ? `<button type="button" data-action="undo" data-id="${id}">撤销</button>` : ""}
            </div>
          `;
        }

        function renderResultsPanel() {
          const all = Array.from(state.proposals.values());
          if (!state.showResults || !all.length) return "";
          const factMap = new Map(currentRows().map(r => [r.id, r]));
          const needs = all.filter(p => p.action !== "KEEP" && p.needsManual);
          const changed = all.filter(p => p.action !== "KEEP" && !p.needsManual);
          const keep = all.filter(p => p.action === "KEEP");

          const group = (title, items) => {
            if (!items.length) return "";
            return `
              <div class="mtc-mini-title">${escapeHtml(title)} ${items.length} 条</div>
              ${items.map(p => p.type === "archive" ? renderArchiveProposal(p, factMap) : renderFactProposal(p, factMap)).join("")}
            `;
          };

          return `
            <div class="mtc-card">
              <div style="font-weight:700;margin-bottom:8px">查看/编辑结果</div>
              <div class="mtc-muted">这里不会立刻写回记忆。你可以编辑、重改、标记保留或删除，最后点底部“应用全部结果”。</div>
              ${group("需处理", needs)}
              ${group("AI已修改", changed)}
              ${group("建议保留", keep)}
              <div class="mtc-row" style="margin-top:12px">
                <button type="button" class="mtc-action act-apply" data-action="apply-all">
                  <b>应用全部结果</b>
                  <span>把当前 AI 结果和你手动编辑过的内容写回事实记忆。</span>
                </button>
              </div>
            </div>
          `;
        }

        function render() {
          const s = stats();
          const disabled = state.busy ? "disabled" : "";
          const convOptions = state.conversations.map(c => {
            const id = c.id || c.conversationId || "";
            const name = c.name || c.title || c.handle || c.displayName || id || "未命名会话";
            const type = c.isGroup || c.type === "group" ? "群聊" : (c.source === "character" ? "角色" : "私聊");
            return `<option value="${escapeHtml(id)}" ${id === state.conversationId ? "selected" : ""}>${escapeHtml(name)}｜${type}</option>`;
          }).join("");

          root.innerHTML = `
            <div class="mtc-top">
              <button type="button" data-action="back">返回</button>
              <div class="mtc-title">记忆低Token清理器 v2.7</div>
            </div>

            <div class="mtc-card">
              <div class="mtc-row">
                <select id="mtc-conversation">${convOptions || `<option value="">未读取会话</option>`}</select>
                <button type="button" data-action="load-conv" ${disabled}>刷新会话</button>
                <button type="button" data-action="load-memory" class="act-apply" ${disabled}>读取记忆</button>
              </div>
              <div class="mtc-row" style="margin-top:8px">
                <input id="mtc-manual-conversation-id" placeholder="兼容模式：手动粘贴 conversationId" value="${escapeHtml(state.conversationId || "")}" style="flex:1;min-width:220px">
                <button type="button" data-action="use-manual-conv" ${disabled}>使用这个ID</button>
              </div>
              <div class="mtc-muted" style="margin-top:8px">此插件仅影响事实记忆。</div>
            </div>

            <div class="mtc-card">
              <div class="mtc-stats">
                <div class="mtc-stat"><b>${state.facts.length}</b><span>事实记忆</span></div>
                <div class="mtc-stat"><b>${s.newCount}</b><span>新增/变动</span></div>
                <div class="mtc-stat"><b>${s.priority}</b><span>优先清理</span></div>
                <div class="mtc-stat"><b>${s.totalTokens}</b><span>估算token</span></div>
                <div class="mtc-stat"><b>${s.aiResults}</b><span>AI结果</span></div>
                <div class="mtc-stat"><b>${s.needsManual}</b><span>需处理</span></div>
              </div>
            </div>

            <div class="mtc-card">
              <div class="mtc-action-grid">
                <button type="button" class="mtc-action act-new" data-action="clean-new" ${disabled}>
                  <b>清理新增</b><span>日常维护，处理上次清理后新增或变动的事实记忆。</span>
                </button>
                <button type="button" class="mtc-action act-compress" data-action="quick-compress" ${disabled}>
                  <b>压缩过长/流水账</b><span>只整理过长或流水账，偏保守，不主动删除。</span>
                </button>
                <button type="button" class="mtc-action act-wash" data-action="wash-all" ${disabled}>
                  <b>大清洗</b><span>全库扫描，动作最重，可能保留、压缩、拆分或删除。</span>
                </button>
                <button type="button" class="mtc-action act-archive" data-action="archive-old" ${disabled}>
                  <b>旧记忆归档</b><span>记忆减退，把旧记忆合并成阶段叙事，属于特殊整理。</span>
                </button>
                <button type="button" class="mtc-action act-prompt" data-action="toggle-prompt" ${disabled}>
                  <b>新增提示词</b><span>给本次 AI 操作加临时要求，不写入记忆。</span>
                </button>
                <button type="button" class="mtc-action act-review" data-action="toggle-results" ${disabled}>
                  <b>查看/编辑结果${s.aiResults ? `（${s.aiResults}）` : ""}</b><span>查看 AI 方案，手动编辑、重改、标记删除或保留。</span>
                </button>
                <button type="button" class="mtc-action act-apply" data-action="apply-all" ${disabled}>
                  <b>应用全部结果${s.actionable ? `（${s.actionable}）` : ""}</b><span>真正写回事实记忆，属于最终提交。</span>
                </button>
              </div>

              <div id="mtc-custom-instruction-panel" class="${state.showPrompt ? "" : "hidden"}" style="margin-top:10px">
                <div style="font-weight:700; margin-bottom:8px">新增提示词</div>
                <textarea id="mtc-custom-instruction" placeholder="例：保留地点；注意时间顺序；只压缩不删除；保留未完成承诺。">${escapeHtml(state.customInstruction || "")}</textarea>
                <div class="mtc-field-note">仅影响本次会调用 AI 的记忆处理。</div>
              </div>

              <div class="mtc-muted" style="margin-top:8px;line-height:1.55">
                建议最新事实注入上限设为 3～5。
              </div>
            </div>

            ${renderResultsPanel()}

            <details class="mtc-card">
              <summary>设置</summary>
              <div class="mtc-settings-grid" style="margin-top:10px">
                <label>单条最大中文字数</label><input id="mtc-max-chars" type="number" value="${state.settings.maxChars}">
                <label>偏好最短字数</label><input id="mtc-pref-min" type="number" value="${state.settings.preferredMin}">
                <label>偏好最长字数</label><input id="mtc-pref-max" type="number" value="${state.settings.preferredMax}">
                <label>重大节点最长字数</label><input id="mtc-major-max" type="number" value="${state.settings.majorMax}">
                <label>关键词数量上限</label><input id="mtc-keyword-limit" type="number" value="${state.settings.keywordLimit}">
                <label>AI批量审查条数</label><input id="mtc-batch-size" type="number" value="${state.settings.batchSize}">
                <label>读取长期记忆上限</label><input id="mtc-long-limit" type="number" value="${state.settings.longTermLimit}">
                <label>旧记忆归档条数</label><input id="mtc-archive-count" type="number" value="${state.settings.archiveCount}">
              </div>

              <details style="margin-top:12px">
                <summary>高级开关</summary>
                <div style="margin-top:8px">
                  ${renderSwitchRow("executeAllAiSuggestions", "全部执行AI建议", state.settings.executeAllAiSuggestions)}
                  ${renderSwitchRow("writeKeywords", "关键词写回主记忆", state.settings.writeKeywords)}
                  ${renderSwitchRow("showCore", "显示Core Memory", state.settings.showCore)}
                </div>
              </details>

              <div class="mtc-row" style="margin-top:10px">
                <button type="button" data-action="save-settings" ${disabled}>保存设置</button>
                <button type="button" data-action="restore-defaults" class="danger" ${disabled}>恢复默认</button>
              </div>
            </details>

            ${state.settings.showCore ? `
              <details class="mtc-card">
                <summary>Core Memory（只读）</summary>
                <div class="mtc-text" style="margin-top:8px">${escapeHtml(state.core?.summary || state.core?.text || JSON.stringify(state.core || {}, null, 2))}</div>
              </details>` : ""}

            <div class="mtc-card">
              <div class="mtc-muted">
                已读取 ${state.facts.length} 条事实记忆。原始记忆不会在主界面展开；需要修改时请先生成 AI 结果，再进入“查看/编辑结果”。
                ${state.tracker?.cleanedAt ? `<br>上次记录：${escapeHtml(new Date(state.tracker.cleanedAt).toLocaleString())}` : "<br>此角色暂无清理记录；首次清理时会把当前事实视作新增。"}
              </div>
            </div>

            <div class="mtc-card"><div class="mtc-log" id="mtc-log"></div></div>
            <div class="mtc-bottom-spacer"></div>
          `;

          bindEvents();
        }

        function bindEvents() {
          if (root.__mtcBound) return;
          root.__mtcBound = true;

          root.addEventListener("input", e => {
            if (e.target?.id === "mtc-custom-instruction") state.customInstruction = e.target.value;
          });

          root.addEventListener("change", e => {
            if (e.target?.id === "mtc-conversation") {
              state.conversationId = e.target.value;
              state.facts = [];
              state.core = null;
              state.proposals.clear();
              state.tracker = { known: {}, cleanedAt: null };
              render();
            }
          });

          root.addEventListener("click", async e => {
            const btn = e.target.closest("button[data-action], .mtc-switch-button");
            if (!btn || !root.contains(btn)) return;
            e.preventDefault();
            e.stopPropagation();

            if (btn.classList.contains("mtc-switch-button")) {
              const key = btn.dataset.settingKey;
              if (!key || !(key in state.settings)) return;
              state.settings[key] = !state.settings[key];
              const value = !!state.settings[key];
              btn.classList.toggle("on", value);
              btn.setAttribute("aria-pressed", value ? "true" : "false");
              const pill = btn.querySelector(".mtc-switch-pill");
              if (pill) pill.textContent = value ? "开" : "关";
              return;
            }

            const action = btn.dataset.action;
            const id = btn.dataset.id;

            if (action === "back") return roche.ui.closeApp();
            if (action === "load-conv") return loadConversations();
            if (action === "load-memory") return loadMemory();
            if (action === "use-manual-conv") {
              const manual = String(root.querySelector("#mtc-manual-conversation-id")?.value || "").trim();
              if (!manual) return roche.ui.toast("请先粘贴 conversationId。");
              state.conversationId = manual;
              state.facts = [];
              state.core = null;
              state.proposals.clear();
              state.tracker = { known: {}, cleanedAt: null };
              return render();
            }
            if (action === "clean-new") return cleanNew();
            if (action === "wash-all") return washAll();
            if (action === "quick-compress") return quickCompressFlagged();
            if (action === "archive-old") return archiveOldMemories();
            if (action === "toggle-prompt") {
              state.showPrompt = !state.showPrompt;
              return render();
            }
            if (action === "toggle-results") {
              state.showResults = !state.showResults;
              return render();
            }
            if (action === "apply-all") return applyAllResults();
            if (action === "save-settings") return saveSettingsFromUi();
            if (action === "restore-defaults") return restoreDefaultSettings();
            if (action === "rerun") return rerunOneAi(id);
            if (action === "single-compress") return convertToSingleCompress(id);
            if (action === "mark-keep") return markKeep(id);
            if (action === "mark-delete") return markDelete(id);
            if (action === "undo") return undoMark(id);
          });
        }

        await loadConversations();
        if (state.conversationId) await loadMemory({ silent: true });
        render();

        container.__memoryTokenCleanerUnmount = () => {
          style.remove();
          container.style.overflow = previous.overflow;
          container.style.height = previous.height;
          container.style.minHeight = previous.minHeight;
          container.style.position = previous.position;
        };
      },
      async unmount(container) {
        try { container.__memoryTokenCleanerUnmount?.(); } catch (_) {}
        container.replaceChildren();
      }
    }]
  });
})();