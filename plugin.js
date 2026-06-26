;(() => {
  "use strict";

  const PLUGIN_ID = "memory-token-cleaner";
  const APP_ID = "memory-token-cleaner-home";
  const VERSION = "3.5.0";

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
    const pluginish = String(item?.source || "").includes("plugin_memory_token_cleaner");
    const fields = pluginish
      ? [item?.summaryText, item?.action, item?.text, item?.content, item?.what]
      : [item?.what, item?.summaryText, item?.action, item?.text, item?.content];
    for (const value of fields) {
      const s = String(value || "").trim();
      if (s) return s;
    }
    return "";
  }

  function getFactWho(item) {
    return String(item?.who || item?.subject || item?.person || item?.人物 || "").trim();
  }

  function getFactWhen(item) {
    return String(item?.when || item?.time || item?.date || item?.时间 || "").trim();
  }

  function getFactWhere(item) {
    return String(item?.where || item?.location || item?.place || item?.地点 || "").trim();
  }

  function getFactHow(item) {
    return String(item?.how || item?.method || item?.方式 || "").trim();
  }

  function firstNonEmpty(...values) {
    for (const v of values) {
      const s = String(v || "").trim();
      if (s) return s;
    }
    return "";
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function normalizeNumericDatePart(text) {
    const t = String(text || "").trim();
    const full = t.match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})(?:日)?(?:\s*(\d{1,2})[:：](\d{2}))?/);
    if (full) {
      const y = full[1], m = pad2(full[2]), d = pad2(full[3]);
      const time = full[4] ? ` ${pad2(full[4])}:${pad2(full[5] || 0)}` : "";
      return `${y}-${m}-${d}${time}`;
    }
    const month = t.match(/(20\d{2})[-/年.](\d{1,2})(?:月)?/);
    if (month) return `${month[1]}-${pad2(month[2])}`;
    const year = t.match(/\b(20\d{2})\b/);
    if (year) return year[1];
    return "";
  }

  function endOfMonth(year, monthIndex0) {
    return new Date(year, monthIndex0 + 1, 0, 23, 59, 59).getTime();
  }

  function parseSingleDateTimeValue(text, preferEnd = false) {
    const t = String(text || "");
    const full = t.match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})(?:日)?(?:\s*(\d{1,2})[:：](\d{2}))?/);
    if (full) {
      const y = Number(full[1]), m = Number(full[2]), d = Number(full[3]);
      const hh = full[4] ? Number(full[4]) : (preferEnd ? 23 : 0);
      const mm = full[5] ? Number(full[5]) : (preferEnd ? 59 : 0);
      const time = new Date(y, m - 1, d, hh, mm).getTime();
      if (Number.isFinite(time)) return time;
    }
    const month = t.match(/(20\d{2})[-/年.](\d{1,2})(?:月)?/);
    if (month) {
      const y = Number(month[1]), m = Number(month[2]);
      const time = preferEnd ? endOfMonth(y, m - 1) : new Date(y, m - 1, 1).getTime();
      if (Number.isFinite(time)) return time;
    }
    const year = t.match(/\b(20\d{2})\b/);
    if (year) {
      const y = Number(year[1]);
      const time = preferEnd ? new Date(y, 11, 31, 23, 59, 59).getTime() : new Date(y, 0, 1).getTime();
      if (Number.isFinite(time)) return time;
    }
    return Infinity;
  }

  function parseDateTimeValue(text) {
    const t = sanitizeWhen(text);
    if (!t) return Infinity;
    const parts = t.split(/\s*->\s*/).map(x => x.trim()).filter(Boolean);
    const target = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    return parseSingleDateTimeValue(target, true);
  }

  function sanitizeWhen(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    const fuzzy = /(上午|下午|早晨|清晨|中午|晚上|夜里|凌晨|傍晚|上旬|中旬|下旬|月初|月中|月末|那天|那段时间|后来|同一阶段|离港前后|早期相处|香港最后一天|离开前后|早期|最初|近期|最近|之后|以前|以前后|前后|期间)/;
    const range = raw.match(/(20\d{2}[-/年.]\d{1,2}(?:[-/月.]\d{1,2}(?:日)?(?:\s*\d{1,2}[:：]\d{2})?)?)\s*(?:->|至|到|—|–|~|～)\s*(20\d{2}[-/年.]\d{1,2}(?:[-/月.]\d{1,2}(?:日)?(?:\s*\d{1,2}[:：]\d{2})?)?)/);
    if (range) {
      const a = normalizeNumericDatePart(range[1]);
      const b = normalizeNumericDatePart(range[2]);
      return a && b ? `${a} -> ${b}` : "";
    }
    const allFull = raw.match(/20\d{2}[-/年.]\d{1,2}[-/月.]\d{1,2}(?:日)?(?:\s*\d{1,2}[:：]\d{2})?/g);
    if (allFull && allFull.length >= 2) {
      const a = normalizeNumericDatePart(allFull[0]);
      const b = normalizeNumericDatePart(allFull[allFull.length - 1]);
      return a && b && a !== b ? `${a} -> ${b}` : (a || "");
    }
    if (allFull && allFull.length === 1) return normalizeNumericDatePart(allFull[0]);
    const month = raw.match(/20\d{2}[-/年.]\d{1,2}(?:月)?/);
    if (month && !fuzzy.test(raw)) return normalizeNumericDatePart(month[0]);
    const year = raw.match(/\b20\d{2}\b/);
    if (year && !fuzzy.test(raw)) return year[0];
    return "";
  }

  function inferWhenFromText(text) {
    const t = String(text || "");
    const range = t.match(/(20\d{2}[-/年.]\d{1,2}[-/月.]\d{1,2}(?:日)?(?:\s*\d{1,2}[:：]\d{2})?)\s*(?:->|至|到|—|–|~|～)\s*(20\d{2}[-/年.]\d{1,2}[-/月.]\d{1,2}(?:日)?(?:\s*\d{1,2}[:：]\d{2})?)/);
    if (range) return sanitizeWhen(`${range[1]} -> ${range[2]}`);
    const allFull = t.match(/20\d{2}[-/年.]\d{1,2}[-/月.]\d{1,2}(?:日)?(?:\s*\d{1,2}[:：]\d{2})?/g);
    if (allFull && allFull.length >= 2) return sanitizeWhen(`${allFull[0]} -> ${allFull[allFull.length - 1]}`);
    if (allFull && allFull.length === 1) return sanitizeWhen(allFull[0]);
    const month = t.match(/20\d{2}[-/年.]\d{1,2}(?:月)?/);
    if (month) return sanitizeWhen(month[0]);
    const year = t.match(/\b20\d{2}\b/);
    return year ? year[0] : "";
  }

  function extractEventTime(text, item = null) {
    const when = item ? getFactWhen(item) : "";
    const fromWhen = parseDateTimeValue(when);
    if (Number.isFinite(fromWhen)) return fromWhen;
    return parseDateTimeValue(inferWhenFromText(text));
  }

  function buildMemoryPayload(text, sourceItem = null, overrides = {}) {
    const body = String(text || "").trim();
    const sourceText = sourceItem ? getFactText(sourceItem) : "";
    const who = firstNonEmpty(overrides.who, sourceItem && getFactWho(sourceItem), "线上摘要");
    const when = sanitizeWhen(firstNonEmpty(overrides.when, sourceItem && getFactWhen(sourceItem), inferWhenFromText(body), inferWhenFromText(sourceText)));
    const where = firstNonEmpty(overrides.where, sourceItem && getFactWhere(sourceItem));
    const how = firstNonEmpty(overrides.how, sourceItem && getFactHow(sourceItem));
    return {
      who,
      when,
      where,
      how,
      what: body,
      summaryText: body,
      action: body,
      text: body,
      content: body,
      source: "plugin_memory_token_cleaner_v3"
    };
  }

  function cloneFactForBackup(row) {
    const item = row?.item || {};
    return {
      id: row?.id || getMemoryId(item),
      hash: row?.hash || hashText(getFactText(item)),
      who: getFactWho(item),
      when: getFactWhen(item),
      where: getFactWhere(item),
      how: getFactHow(item),
      what: getFactText(item),
      raw: item
    };
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
${compressOnly ? "仅压缩过长/流水账。只能返回 KEEP 或 COMPRESS，不能返回 DELETE、SPLIT 或 MERGE_REPLACE。" : "完整审查。可以返回 KEEP、COMPRESS、SPLIT、MERGE_REPLACE、DELETE。"}

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

MERGE 合并规则：
1. MERGE_REPLACE 用于把多条事实记忆合并成一条完整事实，并删除碎片记忆。
2. MERGE_REPLACE 优先级高于 SPLIT。如果几条事实属于同一事件线的开始、发展、结果，不要拆分成更多事实，应合并成一条闭环事实。
3. 允许跨天合并，但只允许合并同一条已经闭环的事件线，例如同一冲突、同一承诺、同一行程、同一关系节点或同一未完成问题的连续推进。
4. 不要按日期合并。不要因为同一天或时间接近就合并主题不同的记忆。
5. 合并后不能丢失关键边界、承诺、关系后果、地点、关键物品或关键称呼。
6. 如果其中任何一条未来可能需要单独召回，优先分别 COMPRESS，不要 MERGE_REPLACE。
7. MERGE_REPLACE 的 when 写事件线起点到闭环点，例如 2026-06-20 -> 2026-06-23；排序会按结束时间处理。

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
MERGE_REPLACE：多条事实属于同一条已经闭环的事件线，合并为一条完整事实。
DELETE：无长期后果、重复、过时、低价值，应遗忘。


结构字段规则：
1. who/where/how 可以是自然语言短语。
2. when 是机器排序字段，只能输出数字日期或数字日期范围。
3. when 允许格式：2026-06-20、2026-06-20 22:14、2026-06-20 -> 2026-06-23、2026-06、2026。
4. when 绝对不能出现：上午、下午、早晨、中午、晚上、上旬、中旬、下旬、月初、月中、月末、那段时间、后来、离港前后、早期相处、香港最后一天。
5. 模糊阶段词只能写进 what/newText 正文，不能写进 when。
6. 如果无法确定数字日期，when 留空。

${extra ? `本次用户新增提示词：\n${extra}\n` : ""}

只返回严格 JSON 对象，不要解释，不要 Markdown。格式：
{
  "items": [
    {
      "id": "原id",
      "action": "KEEP|COMPRESS${compressOnly ? "" : "|SPLIT|MERGE_REPLACE|DELETE"}",
      "sourceIds": ["MERGE_REPLACE时填写，被合并的原id列表"],
      "newText": "COMPRESS或MERGE_REPLACE时填写；其他动作可空",
      "newItems": [{"text":"SPLIT时的新记忆1","keywords":["本条关键词1"]}],
      "keywords": ["COMPRESS或DELETE时的具体关键词"],
      "risk": "safe|confirm",
      "reason": "不超过18字",
      "who": "可选，人物",
      "when": "可选，时间段",
      "where": "可选，地点",
      "how": "可选，方式/状态"
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

结构字段规则：
when 是机器排序字段，只能输出数字日期或数字日期范围，如 2026-06-20、2026-06-20 -> 2026-06-23、2026-06。
when 绝对不能出现上午、下午、上旬、中旬、下旬、那段时间、离港前后等模糊词。模糊词只能写进正文。
无法确定数字日期时，when 留空。

只返回严格 JSON 对象：
{
  "items": [
    {
      "id": "${record.id}",
      "action": "COMPRESS",
      "newText": "单条压缩后的事实记忆",
      "keywords": ["具体关键词1","具体关键词2"],
      "reason": "不超过18字",
      "who": "可选，人物",
      "when": "可选，时间段",
      "where": "可选，地点",
      "how": "可选，方式/状态"
    }
  ]
}

原记忆：
${JSON.stringify(record, null, 2)}`;
  }

  function buildTightenPrompt(record, settings, customInstruction = "") {
    const extra = cleanCustomInstruction(customInstruction);
    return `请只把当前结果进一步压短，不要重新判断动作，不要拆分，不要删除，不要改成归档。

压缩目标：
1. 保留事件线、关系后果、边界、承诺、地点、关键物品和关键称呼。
2. 删除重复铺垫、解释性语句、情绪修饰、分钟级时间、弱细节。
3. 普通事实目标 70-120 中文字；重大关系节点最多 160 中文字。
4. 不要添加原文没有的信息。
5. 输出仍然是一条事实记忆，不要写成总结标题或人设归纳。

when 规则：
1. when 是机器排序字段，只能输出数字日期或数字日期范围。
2. when 允许格式：2026-06-20、2026-06-20 22:14、2026-06-20 -> 2026-06-23、2026-06。
3. when 绝对不能出现上午、下午、上旬、中旬、下旬、那段时间、离港前后等模糊词。模糊词只能写进正文。
4. 无法确定数字日期时，when 留空。

${extra ? `本次用户新增提示词：\n${extra}\n` : ""}

只返回严格 JSON 对象：
{
  "items": [
    {
      "text": "压短后的事实记忆",
      "keywords": ["具体关键词1","具体关键词2"],
      "who": "可选，人物",
      "when": "可选，只能数字日期或数字日期范围",
      "where": "可选，地点",
      "how": "可选，方式/状态"
    }
  ]
}

当前结果：
${JSON.stringify(record, null, 2)}`;
  }

  async function askAiToTighten(roche, record, settings, customInstruction = "") {
    const parsed = await askAi(roche, buildTightenPrompt(record, settings, customInstruction));
    const item = parsed?.[0] || {};
    const text = String(item?.text || item?.newText || item?.content || "").trim();
    if (!text) return null;
    return {
      text,
      keywords: unique(item?.keywords || extractKeywordsFromText(text, settings.keywordLimit)).slice(0, settings.keywordLimit),
      who: String(item?.who || "").trim(),
      when: sanitizeWhen(item?.when || ""),
      where: String(item?.where || "").trim(),
      how: String(item?.how || "").trim()
    };
  }

  function buildArchivePrompt(records, settings, customInstruction = "") {
    const extra = cleanCustomInstruction(customInstruction);
    return `你是 Roche 旧记忆归档器。你的任务不是清洗近期事实，而是模拟人脑记忆减退：把更早的事实记忆整理成模糊的阶段叙事，或删除无长期意义的旧细节。

归档目标：
1. 把旧事实从“高清流水账”变成“朴素阶段记忆”。
2. 可以按同一段时间合并多条不同事件线，例如家庭线、金钱线、冲突线、离别线，只要它们确实属于同一阶段。
3. 合并后的记忆要像一段朴素叙事：地点、人物、主要事件、关系后果。
4. 不要写成文艺描写，不要写天气、气氛、心理渲染。
5. 归档正文可以模糊具体日期时间，可以写“那段时间”“后来”“同一阶段”“六月里”“离开前后”“早期相处里”等；但 when 字段不能写这些词。
6. 不要补原文没有的信息。
7. 如果旧事实只是重复小互动、普通调情、表情包、无后果照片，可以 DELETE。
8. 如果内容仍然太重要、不能减退，返回 KEEP。
9. 默认优先使用 ARCHIVE_REPLACE：生成归档记忆，并删除被归档的旧事实。

归档粒度：
- 阶段归档：允许把同一段时间的多条线合成 1-3 条阶段叙事。
- 输出每条归档记忆 120-260 中文字。
- 关键词要少而具体，2-5 个。

结构字段规则：
1. when 是机器排序字段，只能输出数字日期或数字日期范围。
2. when 允许格式：2026-06、2026-06-01 -> 2026-06-30、2026。
3. when 绝对不能出现：上午、下午、早晨、中午、晚上、上旬、中旬、下旬、月初、月中、月末、那段时间、后来、离港前后、早期相处、香港最后一天。
4. 模糊阶段词只能写进 archiveText 正文，不能写进 when。
5. 如果无法确定数字日期，when 留空。

${extra ? `本次用户新增提示词：\n${extra}\n` : ""}

只返回严格 JSON 对象，不要解释，不要 Markdown。格式：
{
  "items": [
    {
      "sourceIds": ["被归档或删除的原id"],
      "action": "ARCHIVE_REPLACE|ARCHIVE_KEEP|DELETE|KEEP",
      "archiveText": "ARCHIVE时填写阶段叙事",
      "keywords": ["具体关键词1","具体关键词2"],
      "reason": "不超过18字",
      "who": "可选，人物",
      "when": "可选，只能是数字日期或数字日期范围，例如 2026-06 或 2026-06-01 -> 2026-06-30；不能写六月里/离港前后/上中下旬",
      "where": "可选，地点",
      "how": "可选，方式/状态"
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
    let action = String(p?.action || "KEEP").trim().toUpperCase();
    if (mode === "compressOnly" && !["KEEP","COMPRESS"].includes(action)) action = "COMPRESS";
    if (!["KEEP","COMPRESS","SPLIT","MERGE_REPLACE","DELETE"].includes(action)) action = "KEEP";

    let sourceIds = unique(p?.sourceIds || p?.ids || []);
    let id = String(p?.id || "").trim();
    if (!sourceIds.length && id) sourceIds = [id];
    sourceIds = sourceIds.filter(x => factMap.has(x));

    if (action !== "MERGE_REPLACE") {
      id = sourceIds[0] || id;
      if (!factMap.has(id)) action = "KEEP";
      sourceIds = [id].filter(Boolean);
    }

    if (action === "MERGE_REPLACE") {
      if (sourceIds.length < 2) {
        action = "COMPRESS";
        id = sourceIds[0] || id;
        sourceIds = [id].filter(Boolean);
      } else {
        id = makeProposalId("merge");
      }
    }

    const original = factMap.get(id)?.text || (sourceIds.map(sid => factMap.get(sid)?.text).filter(Boolean).join("\n"));
    const keywords = unique(p?.keywords || []).slice(0, settings.keywordLimit);
    let newText = String(
      p?.newText ||
      p?.mergeText ||
      p?.mergedText ||
      p?.what ||
      p?.summaryText ||
      p?.content ||
      p?.archiveText ||
      p?.text ||
      ""
    ).trim();
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

    if (action === "MERGE_REPLACE") {
      if (!newText) {
        needsManual = true;
        manualReasons.push("合并为空");
      }
      if (sourceIds.length < 2) {
        needsManual = true;
        manualReasons.push("合并来源不足");
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
      id, sourceIds, action, newText, newItems, keywords,
      reason: manualReasons[0] || reason,
      risk, needsManual,
      who: String(p?.who || "").trim(),
      when: sanitizeWhen(p?.when || ""),
      where: String(p?.where || "").trim(),
      how: String(p?.how || "").trim(),
      type: action === "MERGE_REPLACE" ? "merge" : "fact"
    };
  }

  function normalizeArchiveProposal(p, rows, settings) {
    const rowIds = new Set(rows.map(r => r.id));
    const sourceIds = unique(p?.sourceIds || p?.ids || []).filter(id => rowIds.has(id));
    let action = String(p?.action || "KEEP").trim().toUpperCase();
    if (!["ARCHIVE_REPLACE","ARCHIVE_KEEP","DELETE","KEEP"].includes(action)) action = "KEEP";
    if (!sourceIds.length) action = "KEEP";

    let archiveText = String(p?.archiveText || p?.newText || p?.what || p?.summaryText || p?.content || p?.text || "").trim();
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
      who: String(p?.who || "").trim(),
      when: sanitizeWhen(p?.when || ""),
      where: String(p?.where || "").trim(),
      how: String(p?.how || "").trim(),
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
        --mtc-order:#ffe1e1; --mtc-order-border:#d98f8f;
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
          --mtc-order:rgba(210,80,80,.24); --mtc-order-border:rgba(240,130,130,.50);
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
      .roche-plugin-memory-token-cleaner .act-order { background:var(--mtc-order); border-color:var(--mtc-order-border); }
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
          tracker: { known: {}, hashes: {}, cleanedAt: null },
          customInstruction: "",
          reviewMode: "review",
          workflow: "",
          showPrompt: false,
          showResults: false,
          manualIds: [],
          busy: false
        };

        const trackerKey = () => `memory-token-cleaner-tracker:${state.conversationId || "none"}`;
        const manualIdsKey = () => "memory-token-cleaner-manual-conversation-ids";

        function normalizeManualId(value) {
          return String(value || "").trim();
        }

        async function loadManualIds() {
          try {
            const saved = await roche.storage.get(manualIdsKey());
            const list = Array.isArray(saved) ? saved : [];
            state.manualIds = Array.from(new Set(list.map(normalizeManualId).filter(Boolean))).slice(0, 3);
          } catch (_) {
            state.manualIds = [];
          }
        }

        async function saveManualId(value) {
          const id = normalizeManualId(value);
          if (!id) return;
          const next = [id, ...(state.manualIds || []).filter(x => x !== id)].slice(0, 3);
          state.manualIds = next;
          try { await roche.storage.set(manualIdsKey(), next); } catch (_) {}
        }

        async function removeManualId(value) {
          const id = normalizeManualId(value);
          state.manualIds = (state.manualIds || []).filter(x => x !== id).slice(0, 3);
          try { await roche.storage.set(manualIdsKey(), state.manualIds); } catch (_) {}
        }

        async function clearManualIds() {
          state.manualIds = [];
          try { await roche.storage.set(manualIdsKey(), []); } catch (_) {}
        }

        function log(msg) {
          const el = root.querySelector("#mtc-log");
          if (!el) return;
          const time = new Date().toLocaleTimeString();
          el.insertAdjacentHTML("afterbegin", `<div>[${escapeHtml(time)}] ${escapeHtml(msg)}</div>`);
        }

        function setBusy(busy) {
          if (state?.proposals?.size) {
            try { syncAllEdited(); } catch (_) {}
          }
          state.busy = busy;
          render();
        }

        async function loadTracker() {
          if (!state.conversationId) {
            state.tracker = { known: {}, hashes: {}, cleanedAt: null };
            return;
          }
          const saved = await roche.storage.get(trackerKey());
          state.tracker = saved && typeof saved === "object" ? { known: saved.known || {}, hashes: saved.hashes || {}, cleanedAt: saved.cleanedAt || null } : { known: {}, hashes: {}, cleanedAt: null };
        }

        async function saveTracker() {
          if (!state.conversationId) return;
          await roche.storage.set(trackerKey(), state.tracker);
        }

        async function markAllKnown() {
          const known = {};
          const hashes = {};
          for (const r of currentRows()) {
            if (r.id) known[r.id] = r.hash;
            if (r.hash) hashes[r.hash] = true;
          }
          state.tracker = { known, hashes, cleanedAt: new Date().toISOString() };
          await saveTracker();
        }

        function currentRows() {
          const known = state.tracker?.known || {};
          const hashes = state.tracker?.hashes || {};
          return state.facts.map((item, index) => {
            const id = getMemoryId(item) || `idx_${index}`;
            const text = getFactText(item);
            const hash = hashText(text);
            const oldHash = known[id];
            const hashKnown = !!hashes[hash];
            const isKnown = oldHash === hash || hashKnown;
            const isChanged = !!oldHash && oldHash !== hash;
            const isNew = !oldHash && !hashKnown;
            const when = sanitizeWhen(getFactWhen(item));
            return {
              id, item, text, hash, oldHash, hashKnown, isKnown, isChanged, isNew, index,
              who: getFactWho(item),
              when,
              where: getFactWhere(item),
              how: getFactHow(item),
              analysis: localAnalyzeFact(text, state.settings),
              eventTime: extractEventTime(text, item)
            };
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

        async function loadMemory({ silent = false, clearProposals = true } = {}) {
          if (!state.conversationId) {
            roche.ui.toast("请先选择会话。");
            return false;
          }
          if (!silent) {
            setBusy(true);
            roche.ui.toast("正在重新读取事实记忆……");
          }
          try {
            await loadTracker();
            const memory = await roche.memory.getLongTerm({
              conversationId: state.conversationId,
              limit: state.settings.longTermLimit
            });
            state.core = memory?.core || null;
            state.facts = Array.isArray(memory?.facts) ? memory.facts : [];
            if (clearProposals) {
              state.proposals.clear();
              state.showResults = false;
            }
            log(`已重新读取事实记忆 ${state.facts.length} 条。`);
            if (!silent) roche.ui.toast(`已重新读取 ${state.facts.length} 条事实记忆。`);
            return true;
          } catch (err) {
            roche.ui.toast("读取记忆失败：" + (err?.message || err));
            log("读取记忆失败：" + (err?.message || err));
            return false;
          } finally {
            if (!silent) setBusy(false);
          }
        }


        async function ensureFreshMemoryForAction(label = "处理") {
          log(`${label}前强制重新读取事实记忆。`);
          const ok = await loadMemory({ silent: true, clearProposals: true });
          if (!ok) throw new Error("重新读取记忆失败");
          return currentRows();
        }

        async function refreshAfterApply() {
          await sleep(800);
          await loadMemory({ silent: true, clearProposals: true });
          await sleep(600);
          await loadMemory({ silent: true, clearProposals: true });
        }

        async function reviewRows(rows, mode = "review", workflow = mode) {
          if (!rows.length) {
            roche.ui.toast("没有需要处理的记忆。");
            return;
          }
          state.customInstruction = cleanCustomInstruction(root.querySelector("#mtc-custom-instruction")?.value || state.customInstruction || "");
          state.reviewMode = mode;
          state.workflow = workflow;
          state.proposals.clear();
          setBusy(true);
          try {
            let count = 0;
            const effectiveBatchSize = (workflow === "washAll" && mode === "review") ? Math.max(state.settings.batchSize, 6) : state.settings.batchSize;
            const orderedRows = (workflow === "washAll" && mode === "review")
              ? rows.slice().sort((a, b) => (a.eventTime - b.eventTime) || (a.index - b.index))
              : rows;
            for (let i = 0; i < orderedRows.length; i += effectiveBatchSize) {
              const batch = orderedRows.slice(i, i + effectiveBatchSize);
              const records = batch.map(r => ({
                id: r.id,
                text: r.text,
                when: r.when,
                where: r.where,
                localFlags: r.analysis.flags,
                localRecommendation: r.analysis.recommendation
              }));
              log(`AI处理第 ${Math.floor(i / effectiveBatchSize) + 1} 批，共 ${records.length} 条。`);
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
          try {
            const rows = await ensureFreshMemoryForAction("大清洗");
            await reviewRows(rows, "review", "washAll");
          } catch (err) {
            roche.ui.toast("大清洗前读取失败：" + (err?.message || err));
          }
        }

        async function cleanNew() {
          let freshRows;
          try {
            freshRows = await ensureFreshMemoryForAction("清理新增");
          } catch (err) {
            roche.ui.toast("清理新增前读取失败：" + (err?.message || err));
            return;
          }
          const rows = freshRows.filter(r => r.isNew || r.isChanged);
          if (!state.tracker?.cleanedAt) {
            const ok = await roche.ui.confirm({
              title: "首次清理提示",
              message: "此角色还没有清理记录，所有事实都会视为新增。确定继续清理新增吗？"
            });
            if (!ok) return;
          }
          await reviewRows(rows, "review", "cleanNew");
        }

        async function quickCompressFlagged() {
          let freshRows;
          try {
            freshRows = await ensureFreshMemoryForAction("压缩流水账");
          } catch (err) {
            roche.ui.toast("压缩前读取失败：" + (err?.message || err));
            return;
          }
          const rows = freshRows.filter(r =>
            r.analysis.flags.includes("过长") ||
            r.analysis.flags.includes("像流水账") ||
            r.analysis.flags.includes("多事件")
          );
          await reviewRows(rows, "compressOnly");
        }

        async function archiveOldMemories() {
          let freshRows;
          try {
            freshRows = await ensureFreshMemoryForAction("旧记忆归档");
          } catch (err) {
            roche.ui.toast("归档前读取失败：" + (err?.message || err));
            return;
          }
          const rows = freshRows
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

        async function updateMemory(id, text, sourceItem = null, overrides = {}) {
          await roche.memory.update(id, buildMemoryPayload(text, sourceItem, overrides));
        }

        async function writeMemory(text, sourceItem = null, overrides = {}) {
          if (!roche.memory.write) throw new Error("当前 Roche API 未提供 memory.write。");
          return await roche.memory.write({
            conversationId: state.conversationId,
            type: "fact",
            ...buildMemoryPayload(text, sourceItem, overrides)
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

          if (p.type === "merge") {
            const el = root.querySelector(`textarea[data-role="merge"][data-id="${CSS.escape(id)}"]`);
            if (el) {
              p.newText = el.value.trim();
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

        function cacheEditedFromInput(target) {
          const role = target?.dataset?.role;
          const id = target?.dataset?.id;
          if (!role || !id) return;
          const p = state.proposals.get(id);
          if (!p) return;

          const value = String(target.value || "").trim();

          if (role === "archive") {
            p.archiveText = value;
            p.keywords = [];
          } else if (role === "merge") {
            p.newText = value;
            p.keywords = [];
          } else if (role === "compress") {
            p.newText = value;
            p.keywords = [];
          } else if (role === "split") {
            const idx = Number(target.dataset.index);
            if (Number.isFinite(idx) && p.newItems?.[idx]) {
              p.newItems[idx] = {
                ...(p.newItems[idx] || {}),
                text: value,
                keywords: []
              };
            }
          }

          state.proposals.set(id, p);
        }

        function proposalEventTime(p) {
          if (!p) return Infinity;
          if (p.type === "archive" || p.type === "merge") {
            const fromWhen = parseDateTimeValue(p.when || p.archiveText || p.newText);
            if (Number.isFinite(fromWhen)) return fromWhen;
            const first = (p.sourceIds || []).map(id => currentRows().find(r => r.id === id)).find(Boolean);
            return first ? first.eventTime : Infinity;
          }
          const row = currentRows().find(r => r.id === p.id);
          const fromProposal = parseDateTimeValue(p.when || p.newText || "");
          if (Number.isFinite(fromProposal)) return fromProposal;
          return row ? row.eventTime : Infinity;
        }

        function sortProposalsForLocalReorder(items) {
          return items.slice().sort((a, b) => {
            const at = Number.isFinite(proposalEventTime(a)) ? proposalEventTime(a) : Infinity;
            const bt = Number.isFinite(proposalEventTime(b)) ? proposalEventTime(b) : Infinity;
            if (at !== bt) return at - bt;
            const ai = currentRows().find(r => r.id === a.id)?.index ?? 0;
            const bi = currentRows().find(r => r.id === b.id)?.index ?? 0;
            return ai - bi;
          });
        }

        function localReorderWarning(proposals) {
          const ids = new Set((proposals || []).flatMap(p => p.sourceIds || [p.id]).filter(Boolean));
          if (!ids.size) return "";
          const rows = currentRows();
          const touched = rows.filter(r => ids.has(r.id));
          const untouched = rows.filter(r => !ids.has(r.id));
          const minTouched = Math.min(...touched.map(r => r.eventTime).filter(Number.isFinite));
          const maxUntouched = Math.max(...untouched.map(r => r.eventTime).filter(Number.isFinite));
          if (Number.isFinite(minTouched) && Number.isFinite(maxUntouched) && minTouched < maxUntouched) {
            return "检测到本次维护里有早于现有最新事实的时间；局部重排只能整理本批顺序，完成后建议再用“修复记忆顺序”。";
          }
          return "";
        }

        function mergeWhenFromRows(rows) {
          const sorted = (rows || []).filter(r => Number.isFinite(r.eventTime)).sort((a, b) => a.eventTime - b.eventTime);
          if (!sorted.length) return "";
          const first = sanitizeWhen(sorted[0].when || inferWhenFromText(sorted[0].text));
          const last = sanitizeWhen(sorted[sorted.length - 1].when || inferWhenFromText(sorted[sorted.length - 1].text));
          if (first && last && first !== last) return `${first} -> ${last}`;
          return first || last || "";
        }

        async function applyOneProposal(p, options = {}) {
          if (!p) return "skip";
          const touchKeep = !!options.touchKeep;
          if (p.action === "KEEP" && !touchKeep) return "skip";

          if (p.type === "archive") {
            const sourceRows = (p.sourceIds || []).map(id => currentRows().find(r => r.id === id)).filter(Boolean);
            const firstRow = sourceRows[0];
            const text = finalMemoryText(p.archiveText, p.keywords, state.settings);

            if (p.action === "DELETE") {
              for (const id of p.sourceIds) await roche.memory.delete(id);
              return "delete";
            }

            if (p.action === "ARCHIVE_REPLACE" || p.action === "ARCHIVE_KEEP") {
              if (!text) return "skip";

              // 顺序保护：归档默认 update 第一条旧记忆，再删除其余来源，避免旧事变成最新事实。
              if (p.action === "ARCHIVE_REPLACE" && firstRow) {
                await updateMemory(firstRow.id, text, firstRow.item, {
                  when: firstNonEmpty(firstRow.when, inferWhenFromText(text)),
                  where: firstRow.where,
                  who: p.who || firstRow.who,
                  how: p.how || firstRow.how
                });
                for (const id of p.sourceIds.slice(1)) await roche.memory.delete(id);
                return "archive";
              }

              if (p.action === "ARCHIVE_KEEP") {
                await writeMemory(text, firstRow?.item || null, {
                  when: firstNonEmpty(firstRow?.when, inferWhenFromText(text)),
                  where: firstRow?.where,
                  who: p.who || firstRow?.who,
                  how: p.how || firstRow?.how
                });
                return "archive";
              }
            }
            return "skip";
          }


          if (p.type === "merge") {
            const sourceRows = (p.sourceIds || []).map(id => currentRows().find(r => r.id === id)).filter(Boolean);
            const firstRow = sourceRows.slice().sort((a, b) => (a.eventTime - b.eventTime) || (a.index - b.index))[0];
            const text = finalMemoryText(p.newText, p.keywords, state.settings);

            if (p.action === "DELETE") {
              for (const row of sourceRows) await roche.memory.delete(row.id);
              return "delete";
            }

            if (p.action === "MERGE_REPLACE") {
              if (!firstRow || !text) {
                log("跳过空合并结果，未修改来源记忆。");
                return "skip";
              }
              const rangeWhen = sanitizeWhen(p.when || mergeWhenFromRows(sourceRows));
              await updateMemory(firstRow.id, text, firstRow.item, {
                who: p.who || firstRow.who,
                when: rangeWhen || firstRow.when || inferWhenFromText(text),
                where: p.where || firstRow.where,
                how: p.how || firstRow.how
              });
              for (const row of sourceRows) {
                if (row.id !== firstRow.id) await roche.memory.delete(row.id);
              }
              return "merge";
            }
            return "skip";
          }

          const original = currentRows().find(r => r.id === p.id);
          if (!original) return "skip";

          if (p.action === "KEEP" && touchKeep) {
            await updateMemory(p.id, original.text, original.item, {
              who: p.who || original.who,
              when: p.when || original.when || inferWhenFromText(original.text),
              where: p.where || original.where,
              how: p.how || original.how
            });
            return "reorder";
          }

          if (p.action === "DELETE") {
            await roche.memory.delete(p.id);
            return "delete";
          }

          if (p.action === "COMPRESS") {
            const text = finalMemoryText(p.newText, p.keywords, state.settings);
            if (!text) return "skip";
            await updateMemory(p.id, text, original.item, {
              who: p.who || original.who,
              when: p.when || original.when || inferWhenFromText(text),
              where: p.where || original.where,
              how: p.how || original.how
            });
            return "compress";
          }

          if (p.action === "SPLIT") {
            const items = (p.newItems || []).map(x => ({
              text: finalMemoryText(x.text || x, x.keywords || [], state.settings),
              keywords: x.keywords || []
            })).filter(x => x.text);

            if (!items.length) return "skip";

            if (items.length === 1) {
              await updateMemory(p.id, items[0].text, original.item, {
                who: p.who || original.who,
                when: p.when || original.when || inferWhenFromText(items[0].text),
                where: p.where || original.where,
                how: p.how || original.how
              });
              return "compress";
            }

            // 顺序保护：第一条 update 原记忆，后续才新建。完全不拆时用户可用“改为单条压缩”。
            await updateMemory(p.id, items[0].text, original.item, {
              who: p.who || original.who,
              when: p.when || original.when || inferWhenFromText(items[0].text),
              where: p.where || original.where,
              how: p.how || original.how
            });
            for (const item of items.slice(1)) {
              await writeMemory(item.text, original.item, {
                who: p.who || original.who,
                when: p.when || original.when || inferWhenFromText(item.text),
                where: p.where || original.where,
                how: p.how || original.how
              });
            }
            return "split";
          }
          return "skip";
        }

        async function applyAllResults() {
          syncAllEdited();
          const all = Array.from(state.proposals.values());
          const isCleanNew = state.workflow === "cleanNew";
          let proposals = isCleanNew ? all : all.filter(p => p.action !== "KEEP");

          if (!proposals.length) {
            roche.ui.toast("没有可应用的 AI 结果。");
            return;
          }

          const warning = isCleanNew ? localReorderWarning(proposals) : "";
          const actionCount = proposals.filter(p => p.action !== "KEEP").length;
          const keepTouchCount = isCleanNew ? proposals.filter(p => p.action === "KEEP").length : 0;

          const ok = await roche.ui.confirm({
            title: "应用全部结果",
            message: isCleanNew
              ? `将应用 ${actionCount} 条修改，并按本次维护的 when 对 ${proposals.length} 条新增/变动记忆做局部重排。${warning ? "\\n\\n" + warning : ""}`
              : `将应用 ${proposals.length} 条结果，包括压缩、拆分、删除或归档。确定继续吗？`
          });
          if (!ok) return;

          if (isCleanNew) {
            proposals = sortProposalsForLocalReorder(proposals);
          }

          setBusy(true);
          try {
            const done = { compress:0, delete:0, split:0, archive:0, merge:0, reorder:0, skip:0 };
            for (const p of proposals) {
              const r = await applyOneProposal(p, { touchKeep: isCleanNew });
              if (r === "compress") done.compress++;
              else if (r === "delete") done.delete++;
              else if (r === "reorder") done.reorder++;
              else if (r.startsWith("split")) done.split++;
              else if (r.startsWith("archive")) done.archive++;
              else if (r === "merge") done.merge++;
              else done.skip++;
            }
            await refreshAfterApply();
            await markAllKnown();
            state.proposals.clear();
            state.showResults = false;
            state.workflow = "";
            roche.ui.toast(`完成：压缩 ${done.compress}，拆分 ${done.split}，合并 ${done.merge}，删除 ${done.delete}，归档 ${done.archive}，局部重排 ${done.reorder}。`);
            log(`已应用全部结果：压缩 ${done.compress}，拆分 ${done.split}，合并 ${done.merge}，删除 ${done.delete}，归档 ${done.archive}，局部重排 ${done.reorder}，跳过 ${done.skip}。${warning ? " " + warning : ""}`);
            render();
          } catch (err) {
            roche.ui.toast("应用失败：" + (err?.message || err));
            log("应用失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        function markKeep(id) {
          syncAllEdited();
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
          syncAllEdited();
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
          syncAllEdited();
          const p = state.proposals.get(id);
          if (!p) return;
          if (p._savedOriginal) state.proposals.set(id, p._savedOriginal);
          else state.proposals.delete(id);
          render();
        }

        async function rerunMergeAi(id) {
          syncAllEdited();
          const p = state.proposals.get(id);
          if (!p || p.type !== "merge") return;

          state.customInstruction = cleanCustomInstruction(root.querySelector("#mtc-custom-instruction")?.value || state.customInstruction || "");
          const rows = (p.sourceIds || []).map(sourceId => currentRows().find(r => r.id === sourceId)).filter(Boolean);
          if (rows.length < 2) {
            roche.ui.toast("合并来源不足，无法重改。");
            return;
          }

          setBusy(true);
          try {
            const records = rows.map(r => ({
              id: r.id,
              text: r.text,
              when: r.when,
              where: r.where,
              localFlags: r.analysis.flags,
              localRecommendation: r.analysis.recommendation
            }));
            const raw = await askAiForReview(roche, records, state.settings, state.customInstruction, "review");
            const picked = raw.find(x => String(x?.action || "").trim().toUpperCase() === "MERGE_REPLACE") || raw[0] || null;
            const factMap = new Map(currentRows().map(r => [r.id, r]));
            const next = normalizeProposal(
              picked || { action: "MERGE_REPLACE", sourceIds: p.sourceIds, newText: "", reason: "重改为空" },
              factMap,
              state.settings,
              "review"
            );

            state.proposals.delete(id);
            state.proposals.set(next.id, next);
            state.showResults = true;
            roche.ui.toast("合并结果已重新生成。");
            render();
          } catch (err) {
            roche.ui.toast("合并重改失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        async function rerunOneAi(id) {
          syncAllEdited();
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
          syncAllEdited();
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

        async function tightenProposal(id, index = null) {
          syncAllEdited();
          const p = state.proposals.get(id);
          if (!p) return;

          state.customInstruction = cleanCustomInstruction(root.querySelector("#mtc-custom-instruction")?.value || state.customInstruction || "");
          let currentText = "";
          let currentType = p.action;

          if (index !== null && p.action === "SPLIT") {
            const idx = Number(index);
            currentText = String(p.newItems?.[idx]?.text || "").trim();
            currentType = "SPLIT_ITEM";
          } else if (p.type === "archive") {
            currentText = String(p.archiveText || "").trim();
          } else {
            currentText = String(p.newText || "").trim();
          }

          if (!currentText) {
            roche.ui.toast("没有可压缩的内容。");
            return;
          }

          setBusy(true);
          try {
            const result = await askAiToTighten(roche, {
              action: currentType,
              text: currentText,
              who: p.who,
              when: p.when,
              where: p.where,
              how: p.how
            }, state.settings, state.customInstruction);

            if (!result) {
              roche.ui.toast("AI没有返回可用压缩文本。");
              return;
            }

            if (index !== null && p.action === "SPLIT") {
              const idx = Number(index);
              p.newItems[idx] = {
                ...(p.newItems[idx] || {}),
                text: result.text,
                keywords: result.keywords
              };
            } else if (p.type === "archive") {
              p.archiveText = result.text;
              p.keywords = result.keywords;
            } else {
              p.newText = result.text;
              p.keywords = result.keywords;
            }

            p.who = result.who || p.who;
            p.when = result.when || p.when;
            p.where = result.where || p.where;
            p.how = result.how || p.how;
            state.proposals.set(id, p);
            state.showResults = true;
            roche.ui.toast("已压短。");
            render();
          } catch (err) {
            roche.ui.toast("压短失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        function removeSplitItem(id, index) {
          syncAllEdited();
          const p = state.proposals.get(id);
          if (!p || p.action !== "SPLIT") return;
          const idx = Number(index);
          p.newItems = (p.newItems || []).filter((_, i) => i !== idx);

          if (p.newItems.length <= 0) {
            p.action = "KEEP";
            p._marked = "keep";
          } else if (p.newItems.length === 1) {
            p.action = "COMPRESS";
            p.newText = p.newItems[0].text || "";
            p.keywords = p.newItems[0].keywords || [];
            p.newItems = [];
          }

          state.proposals.set(id, p);
          render();
        }

        async function repairMemoryOrder() {
          let rows;
          try {
            rows = await ensureFreshMemoryForAction("修复顺序");
          } catch (err) {
            roche.ui.toast("修复顺序前读取失败：" + (err?.message || err));
            return;
          }
          if (!rows.length) {
            roche.ui.toast("没有可重排的事实记忆。");
            return;
          }

          const sortable = rows.filter(r => Number.isFinite(r.eventTime)).length;
          const unknown = rows.length - sortable;
          const ok = await roche.ui.confirm({
            title: "修复记忆顺序",
            message: `将备份并删除重建 ${rows.length} 条事实记忆，按 when/正文日期从旧到新写回。可排序 ${sortable} 条，缺少时间 ${unknown} 条。继续吗？`
          });
          if (!ok) return;

          const second = await roche.ui.confirm({
            title: "再次确认",
            message: "此操作会重建事实记忆顺序，用于修复最新事实注入被乱序影响的问题。确定执行吗？"
          });
          if (!second) return;

          setBusy(true);
          try {
            const backup = {
              createdAt: new Date().toISOString(),
              conversationId: state.conversationId,
              facts: rows.map(r => cloneFactForBackup(r))
            };
            await roche.storage.set(`memory-token-cleaner-reorder-backup:${state.conversationId}:${Date.now()}`, backup);
            await roche.storage.set(`memory-token-cleaner-reorder-backup:latest:${state.conversationId}`, backup);

            const sorted = rows.slice().sort((a, b) => {
              const at = Number.isFinite(a.eventTime) ? a.eventTime : -Infinity;
              const bt = Number.isFinite(b.eventTime) ? b.eventTime : -Infinity;
              return (at - bt) || (a.index - b.index);
            });

            for (const r of rows) {
              await roche.memory.delete(r.id);
            }

            for (const r of sorted) {
              const payloadText = r.text;
              await writeMemory(payloadText, r.item, {
                who: r.who || getFactWho(r.item),
                when: r.when || inferWhenFromText(r.text),
                where: r.where || getFactWhere(r.item),
                how: r.how || getFactHow(r.item)
              });
            }

            await refreshAfterApply();
            await markAllKnown();
            roche.ui.toast("记忆顺序已重建，并已更新清理新增索引。");
            log(`已修复记忆顺序：重建 ${rows.length} 条，备份已保存。`);
            render();
          } catch (err) {
            roche.ui.toast("修复顺序失败：" + (err?.message || err));
            log("修复顺序失败：" + (err?.message || err));
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

        function renderMergeProposal(p, factMap) {
          const sourceText = (p.sourceIds || []).map(id => factMap.get(id)?.text).filter(Boolean);
          return `
            <div class="mtc-fact" data-id="${escapeHtml(p.id)}">
              <div class="mtc-badges">
                ${actionBadge(p)}
                <span class="mtc-badge">合并 ${p.sourceIds.length} 条</span>
                ${p.when ? `<span class="mtc-badge">when: ${escapeHtml(p.when)}</span>` : ""}
                ${p.reason ? `<span class="mtc-badge">${escapeHtml(p.reason)}</span>` : ""}
              </div>
              <details style="margin-top:8px">
                <summary class="mtc-muted">来源记忆</summary>
                ${sourceText.map((t, i) => `<div class="mtc-text" style="margin-top:6px">${i + 1}. ${escapeHtml(t)}</div>`).join("")}
              </details>
              ${p.action === "DELETE" ? `<div class="mtc-proposal"><div class="mtc-text">已标记删除这些来源记忆。</div></div>` : `
                <div class="mtc-muted" style="margin-top:8px">合并后的完整事实，可编辑</div>
                <textarea class="mtc-edit-text" data-role="merge" data-id="${escapeHtml(p.id)}">${escapeHtml(finalMemoryText(p.newText, p.keywords, state.settings))}</textarea>
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
              <div class="mtc-row" style="justify-content:space-between">
                <div class="mtc-muted">新记忆 ${i + 1}</div>
                <span class="mtc-row">
                  <button type="button" data-action="tighten-split-item" data-id="${escapeHtml(p.id)}" data-index="${i}">AI压短此条</button>
                  <button type="button" class="danger" data-action="remove-split-item" data-id="${escapeHtml(p.id)}" data-index="${i}">删除此条</button>
                </span>
              </div>
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
          const isGrouped = p.type === "archive" || p.type === "merge";
          const canCompress = !isGrouped && (p.action === "SPLIT" || p.action === "DELETE");
          const canTighten = p.action === "COMPRESS" || p.action === "MERGE_REPLACE" || p.action === "ARCHIVE_REPLACE" || p.action === "ARCHIVE_KEEP";
          return `
            <div class="mtc-row" style="margin-top:8px">
              ${p.type === "merge" ? `<button type="button" data-action="rerun-merge" data-id="${id}">让AI重改</button>` : (!isGrouped ? `<button type="button" data-action="rerun" data-id="${id}">让AI重改</button>` : "")}
              ${canTighten ? `<button type="button" data-action="tighten" data-id="${id}">AI压短</button>` : ""}
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
              ${items.map(p => p.type === "archive" ? renderArchiveProposal(p, factMap) : (p.type === "merge" ? renderMergeProposal(p, factMap) : renderFactProposal(p, factMap))).join("")}
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

          const manualOptions = (state.manualIds || []).map(id =>
            `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`
          ).join("");

          root.innerHTML = `
            <div class="mtc-top">
              <button type="button" data-action="back">返回</button>
              <div class="mtc-title">记忆低Token清理器 v3.5.0</div>
            </div>

            <div class="mtc-card">
              <div class="mtc-row">
                <select id="mtc-conversation">${convOptions || `<option value="">未读取会话</option>`}</select>
                <button type="button" data-action="load-conv" ${disabled}>刷新会话列表</button>
                <button type="button" data-action="load-memory" class="act-apply" ${disabled}>重新读取记忆</button>
              </div>
              <div class="mtc-row" style="margin-top:8px">
                <input id="mtc-manual-conversation-id" placeholder="手动粘贴 conversationId / groupId" value="${escapeHtml(state.conversationId || "")}" style="flex:1;min-width:220px">
                <button type="button" data-action="use-manual-conv" ${disabled}>使用并保存</button>
              </div>
              ${manualOptions ? `
                <div class="mtc-row" style="margin-top:8px">
                  <select id="mtc-saved-manual-id" style="flex:1;min-width:220px">${manualOptions}</select>
                  <button type="button" data-action="use-saved-manual-id" ${disabled}>使用已保存ID</button>
                  <button type="button" data-action="remove-saved-manual-id" ${disabled}>删除已选</button>
                  <button type="button" class="danger" data-action="clear-saved-manual-ids" ${disabled}>清空</button>
                </div>
              ` : ""}
              <div class="mtc-muted" style="margin-top:8px">此插件仅影响事实记忆。最多保存 3 个手动 conversationId / groupId，方便群聊无法自动拉取时使用。</div>
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
                  <b>清理新增</b><span>日常维护，处理新增/变动事实，并按本次 when 自动局部重排。</span>
                </button>
                <button type="button" class="mtc-action act-compress" data-action="quick-compress" ${disabled}>
                  <b>压缩过长/流水账</b><span>只整理过长或流水账，偏保守，不主动删除。</span>
                </button>
                <button type="button" class="mtc-action act-wash" data-action="wash-all" ${disabled}>
                  <b>大清洗</b><span>全库扫描，动作最重，可能保留、压缩、拆分、合并或删除。</span>
                </button>
                <button type="button" class="mtc-action act-archive" data-action="archive-old" ${disabled}>
                  <b>旧记忆归档</b><span>记忆减退，把旧记忆合并成阶段叙事，属于特殊整理。</span>
                </button>
                <button type="button" class="mtc-action act-order" data-action="repair-order" ${disabled}>
                  <b>修复记忆顺序</b><span>按 when/正文日期重建卡片顺序，避免旧记忆污染最新事实注入。</span>
                </button>
                <button type="button" class="mtc-action act-prompt" data-action="toggle-prompt" ${disabled}>
                  <b>新增提示词</b><span>给本次 AI 操作加临时要求，不写入记忆。</span>
                </button>
              </div>

              <div id="mtc-custom-instruction-panel" class="${state.showPrompt ? "" : "hidden"}" style="margin-top:10px">
                <div style="font-weight:700; margin-bottom:8px">新增提示词</div>
                <textarea id="mtc-custom-instruction" placeholder="例：保留地点；注意时间顺序；只压缩不删除；保留未完成承诺。">${escapeHtml(state.customInstruction || "")}</textarea>
                <div class="mtc-field-note">仅影响本次会调用 AI 的记忆处理。</div>
              </div>

              <div class="mtc-muted" style="margin-top:8px;line-height:1.55">
                建议最新事实注入上限设为 3～5。<br>
                清理新增会按本次维护的 when 自动局部重排；执行大清洗、压缩过长/流水账、旧记忆归档，或应用包含旧记忆拆分/合并/归档/新建的结果后，建议使用“修复记忆顺序”。
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
            if (e.target?.matches?.("textarea[data-role][data-id]")) cacheEditedFromInput(e.target);
          });

          root.addEventListener("change", e => {
            if (e.target?.id === "mtc-conversation") {
              state.conversationId = e.target.value;
              state.facts = [];
              state.core = null;
              state.proposals.clear();
              state.tracker = { known: {}, hashes: {}, cleanedAt: null };
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

            const preservesDraftActions = new Set([
              "toggle-prompt", "apply-all", "rerun", "rerun-merge",
              "use-manual-conv", "use-saved-manual-id", "remove-saved-manual-id", "clear-saved-manual-ids",
              "single-compress", "tighten", "tighten-split-item", "remove-split-item",
              "mark-keep", "mark-delete", "undo"
            ]);
            if (preservesDraftActions.has(action)) {
              syncAllEdited();
            }

            if (action === "back") return roche.ui.closeApp();
            if (action === "load-conv") return loadConversations();
            if (action === "load-memory") return loadMemory();
            if (action === "use-manual-conv") {
              const manual = String(root.querySelector("#mtc-manual-conversation-id")?.value || "").trim();
              if (!manual) return roche.ui.toast("请先粘贴 conversationId / groupId。");
              await saveManualId(manual);
              state.conversationId = manual;
              state.facts = [];
              state.core = null;
              state.proposals.clear();
              state.tracker = { known: {}, hashes: {}, cleanedAt: null };
              roche.ui.toast("已使用并保存这个 ID。");
              return render();
            }
            if (action === "use-saved-manual-id") {
              const saved = String(root.querySelector("#mtc-saved-manual-id")?.value || "").trim();
              if (!saved) return roche.ui.toast("没有已保存的 ID。");
              await saveManualId(saved);
              state.conversationId = saved;
              state.facts = [];
              state.core = null;
              state.proposals.clear();
              state.tracker = { known: {}, hashes: {}, cleanedAt: null };
              roche.ui.toast("已切换到保存的 ID。");
              return render();
            }
            if (action === "remove-saved-manual-id") {
              const saved = String(root.querySelector("#mtc-saved-manual-id")?.value || "").trim();
              if (!saved) return roche.ui.toast("没有已保存的 ID。");
              await removeManualId(saved);
              roche.ui.toast("已删除这个保存 ID。");
              return render();
            }
            if (action === "clear-saved-manual-ids") {
              const ok = await roche.ui.confirm({
                title: "清空保存 ID",
                message: "确定清空全部手动保存的 conversationId / groupId 吗？"
              });
              if (!ok) return;
              await clearManualIds();
              roche.ui.toast("已清空保存 ID。");
              return render();
            }
            if (action === "clean-new") return cleanNew();
            if (action === "wash-all") return washAll();
            if (action === "quick-compress") return quickCompressFlagged();
            if (action === "archive-old") return archiveOldMemories();
            if (action === "repair-order") return repairMemoryOrder();
            if (action === "toggle-prompt") {
              state.showPrompt = !state.showPrompt;
              return render();
            }
            if (action === "apply-all") return applyAllResults();
            if (action === "save-settings") return saveSettingsFromUi();
            if (action === "restore-defaults") return restoreDefaultSettings();
            if (action === "rerun") return rerunOneAi(id);
            if (action === "rerun-merge") return rerunMergeAi(id);
            if (action === "single-compress") return convertToSingleCompress(id);
            if (action === "tighten") return tightenProposal(id);
            if (action === "tighten-split-item") return tightenProposal(id, btn.dataset.index);
            if (action === "remove-split-item") return removeSplitItem(id, btn.dataset.index);
            if (action === "mark-keep") return markKeep(id);
            if (action === "mark-delete") return markDelete(id);
            if (action === "undo") return undoMark(id);
          });
        }

        await loadManualIds();
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