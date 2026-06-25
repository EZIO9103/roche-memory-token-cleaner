;(() => {
  "use strict";

  const PLUGIN_ID = "memory-token-cleaner";
  const APP_ID = "memory-token-cleaner-home";
  const VERSION = "2.0.0";

  const DEFAULT_SETTINGS = {
    maxChars: 180,
    preferredMin: 80,
    preferredMax: 140,
    majorMax: 220,
    keywordLimit: 4,
    batchSize: 1,
    longTermLimit: 300,
    writeKeywords: true,
    autoApplySafeCompress: false,
    showCore: false,
    showVectors: true
  };

  const IMPORTANT_HINTS = [
    "承诺","答应","拒绝","边界","和解","争吵","冲突","分手","复合","告白","认错",
    "亲密","关系","信任","远距离","离开","重逢","搬家","地点","见面","以后","未来",
    "配偶","婚姻","称呼","面具","钥匙","家","公寓","主动","不再","默认","拉黑",
    "道歉","love","照片","自拍","石头","物件","贴身","香港","英国","伦敦"
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

  function cleanCustomInstruction(text) {
    return String(text || "").replace(/\r/g, "").trim().slice(0, 1200);
  }

  function keywordTags(keywords, limit) {
    return unique(keywords)
      .slice(0, limit)
      .map(k => k.replace(/^#/, "").replace(/\s+/g, ""))
      .filter(Boolean)
      .map(k => `#${k}`)
      .join(" ");
  }

  function extractKeywordsFromText(text, limit = 4) {
    const t = String(text || "");
    const hits = [];
    for (const k of IMPORTANT_HINTS) {
      if (t.includes(k)) hits.push(k);
    }
    const hashTags = (t.match(/#[\u4e00-\u9fffA-Za-z0-9_-]+/g) || []).map(x => x.slice(1));
    return unique([...hashTags, ...hits]).slice(0, Math.max(0, limit));
  }

  function finalMemoryText(text, keywords, settings) {
    const body = String(text || "").trim();
    if (!body) return "";
    if (!settings.writeKeywords) return body;
    const tags = keywordTags(keywords, settings.keywordLimit);
    return tags ? `${body} ${tags}` : body;
  }

  function stripCodeFence(text) {
    let t = String(text || "").trim();
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    return t;
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

    const parseAndNormalize = obj => {
      if (Array.isArray(obj)) return obj;
      if (Array.isArray(obj?.items)) return obj.items;
      if (Array.isArray(obj?.results)) return obj.results;
      if (Array.isArray(obj?.proposals)) return obj.proposals;
      if (obj && typeof obj === "object") return [obj];
      return [];
    };

    try { return parseAndNormalize(JSON.parse(raw)); } catch (_) {}

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { return parseAndNormalize(JSON.parse(repairJsonText(fenced[1]))); } catch (_) {}
    }

    const objectStart = raw.indexOf("{");
    const objectEnd = raw.lastIndexOf("}");
    if (objectStart !== -1 && objectEnd > objectStart) {
      try { return parseAndNormalize(JSON.parse(raw.slice(objectStart, objectEnd + 1))); } catch (_) {}
    }

    const arrayStart = raw.indexOf("[");
    const arrayEnd = raw.lastIndexOf("]");
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      try { return parseAndNormalize(JSON.parse(raw.slice(arrayStart, arrayEnd + 1))); } catch (_) {}
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
          (/"action"|"items"|KEEP|COMPRESS|SPLIT|DELETE/.test(t) ? 5 : 0) +
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
    const hasHash = /#[\u4e00-\u9fffA-Za-z0-9_-]+/.test(t);

    const flags = [];
    if (len > settings.maxChars) flags.push("过长");
    if (timeHits >= 2 || timelineWords >= 3) flags.push("像流水账");
    if (sentenceCount >= 3) flags.push("多事件");
    if (lowHits >= 2 && importantHits === 0) flags.push("低价值倾向");
    if (!hasHash && settings.writeKeywords) flags.push("无关键词");

    let recommendation = "KEEP";
    if (flags.includes("低价值倾向") && importantHits === 0) recommendation = "DELETE";
    else if (flags.length) recommendation = "COMPRESS";

    return { len, flags, recommendation, tokenEstimate: estimateTokens(t), lowHits, importantHits };
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

  function looseParseReviewText(text, records, settings, mode = "review") {
    const raw = String(text || "").trim();
    if (!raw) return [];
    const results = [];
    for (const record of records || []) {
      const id = String(record.id || "");
      if (!id) continue;
      const idx = raw.indexOf(id);
      if (idx === -1) continue;
      const chunk = raw.slice(idx, idx + 1200);
      let action = "";
      if (/SPLIT|拆分/.test(chunk) && mode !== "compressOnly") action = "SPLIT";
      else if (/DELETE|删除|遗忘/.test(chunk) && mode !== "compressOnly") action = "DELETE";
      else if (/COMPRESS|压缩|改写|重写/.test(chunk)) action = "COMPRESS";
      else if (/KEEP|保留/.test(chunk)) action = "KEEP";
      if (!action) continue;

      const newText = action === "COMPRESS" ? simpleCompressText(record.text, settings) : "";
      results.push({
        id,
        action,
        newText,
        newItems: [],
        keywords: extractKeywordsFromText((record.text || "") + " " + newText, settings.keywordLimit),
        risk: action === "SPLIT" || (action === "DELETE" && isImportantText(record.text)) ? "confirm" : "safe",
        reason: "宽松解析"
      });
    }
    return results;
  }

  function buildReviewerPrompt(records, settings, customInstruction = "", mode = "review") {
    const compressOnly = mode === "compressOnly";
    const extra = cleanCustomInstruction(customInstruction);
    return `你是 Roche 事实记忆清理器。你不是在总结聊天，而是在整理长期记忆。

本次模式：
${compressOnly ? "仅压缩过长/流水账。只能返回 KEEP 或 COMPRESS，不能返回 DELETE 或 SPLIT。" : "完整审查。可以返回 KEEP、COMPRESS、SPLIT、DELETE。"}

核心原则：
1. 降 token 的目标不是把记忆压到最短，而是删掉流水账和重复噪音，保留能让角色继续接戏的具体事件锚点。
2. Fact Memory 必须保持事件形态：谁因为什么，在什么情况下做了什么，造成什么关系后果。
3. 禁止把事件熬成人设标签。不要写“逐渐习惯”“形成模式”“通常会”“倾向于”“已经开始用……维持……”这类归纳句。
4. 旧事件可以变短，但不能变成抽象标签。必须保留事件骨架。
5. 长流水账如果包含多个重要事件，优先 SPLIT 成 2-3 条，而不是压成一句。
6. 关键词必须是具体搜索钩子，不要写抽象概念标签。好关键词：#拉黑 #认错 #love #石头 #面具 #香港。坏关键词：#关系 #未来 #情绪。
7. 普通重复调情、表情包、无新后果的照片、临时害羞、普通玩笑，可以 DELETE。
8. 如果某个普通元素承载了关系后果，例如道歉后的自拍、第一次边界让步、第一次明确拒绝降级，它不是噪音，应该保留为事件。
9. Core Memory 不在本次处理范围。不要建议改人设。

长度：
- 轻量事实：50-80 中文字。
- 普通关系节点：80-140 中文字。
- 重大转折/冲突和解：140-220 中文字。
不要为了短而丢掉关键称呼、关键物品、关键动作、重要原话、地点变化、未完成承诺。

动作定义：
KEEP：保留，不改。
COMPRESS：单条事件仍有价值，但太长或流水账，压成一条事件记忆。
SPLIT：一条旧记忆包含多个重要事件，拆成 2-3 条事件记忆。SPLIT 属于高风险，需要人工确认。
DELETE：无长期后果、重复、过时、低价值，应遗忘。涉及承诺/地点/关系变化/边界/冲突和解的删除必须标为 confirm。

${extra ? `本次用户补充要求：\n${extra}\n` : ""}

只返回严格 JSON 对象，不要解释，不要 Markdown。格式：
{
  "items": [
    {
      "id": "原id",
      "action": "KEEP|COMPRESS${compressOnly ? "" : "|SPLIT|DELETE"}",
      "newText": "COMPRESS时填写；其他动作可空",
      "newItems": ["SPLIT时填写2-3条新事件记忆"],
      "keywords": ["具体关键词1","具体关键词2"],
      "risk": "safe|confirm",
      "reason": "不超过18字"
    }
  ]
}

待审查记忆：
${JSON.stringify(records, null, 2)}`;
  }

  async function askAiForReview(roche, records, settings, customInstruction = "", mode = "review") {
    const prompt = buildReviewerPrompt(records, settings, customInstruction, mode);
    const result = await roche.ai.chat({
      messages: [
        { role: "system", content: "你是 JSON API。只输出有效 JSON 对象，格式为 {\"items\":[...]}。不要解释，不要 Markdown。" },
        { role: "user", content: prompt }
      ],
      temperature: 0
    });

    const text = extractAiText(result);
    let parsed = safeJsonParse(text);
    if (parsed.length) return parsed;

    const loose = looseParseReviewText(text, records, settings, mode);
    if (loose.length) return loose;

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

  function normalizeProposal(p, factMap, settings, mode = "review") {
    const id = String(p?.id || "").trim();
    let action = String(p?.action || "KEEP").trim().toUpperCase();
    if (mode === "compressOnly" && !["KEEP","COMPRESS"].includes(action)) action = "COMPRESS";
    if (!["KEEP","COMPRESS","SPLIT","DELETE"].includes(action)) action = "KEEP";
    if (!factMap.has(id)) action = "KEEP";

    let newText = String(p?.newText || "").trim();
    let newItems = Array.isArray(p?.newItems) ? p.newItems.map(x => String(x || "").trim()).filter(Boolean) : [];
    const keywords = unique(p?.keywords || []).slice(0, settings.keywordLimit);
    const reason = String(p?.reason || "").trim().slice(0, 40);
    const original = factMap.get(id)?.text || "";

    if (action === "COMPRESS") {
      if (!newText) newText = simpleCompressText(original, settings);
      if (charLen(newText) > settings.majorMax) newText = [...newText].slice(0, settings.majorMax).join("");
    }

    if (action === "SPLIT") {
      newItems = newItems.slice(0, 3).map(x => {
        if (charLen(x) > settings.majorMax) return [...x].slice(0, settings.majorMax).join("");
        return x;
      });
      if (newItems.length < 2) {
        action = "COMPRESS";
        newText = newText || simpleCompressText(original, settings);
      }
    }

    let risk = String(p?.risk || "").toLowerCase();
    if (!["safe","confirm"].includes(risk)) risk = "safe";
    if (action === "SPLIT") risk = "confirm";
    if (action === "DELETE" && isImportantText(original)) risk = "confirm";

    return { id, action, newText, newItems, keywords, reason, risk };
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
        --mtc-top-bg:rgba(255,255,255,.96); --mtc-primary-bg:#dfe8ff; --mtc-primary-border:#b7c7ff;
        --mtc-danger-bg:#ffe5e5; --mtc-danger-border:#ffc1c1; --mtc-success-bg:#dff7e8; --mtc-success-border:#9fddb8;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--mtc-text);
        background: var(--mtc-bg);
        position:absolute; inset:0; display:block;
        padding:14px; padding-bottom:calc(40px + env(safe-area-inset-bottom,0px));
        overflow-y:scroll !important; overflow-x:hidden !important;
        -webkit-overflow-scrolling:touch; overscroll-behavior-y:contain; touch-action:pan-y;
        box-sizing:border-box;
      }
      @media (prefers-color-scheme: dark) {
        .roche-plugin-memory-token-cleaner {
          --mtc-bg:#111216; --mtc-text:#f4f6f8; --mtc-muted-color:rgba(244,246,248,.68);
          --mtc-card-bg:rgba(255,255,255,.07); --mtc-soft-bg:rgba(255,255,255,.10); --mtc-border-color:rgba(255,255,255,.14);
          --mtc-top-bg:rgba(17,18,22,.96); --mtc-primary-bg:rgba(100,145,255,.28); --mtc-primary-border:rgba(140,170,255,.50);
          --mtc-danger-bg:rgba(255,90,90,.18); --mtc-danger-border:rgba(255,120,120,.42); --mtc-success-bg:rgba(70,190,120,.22); --mtc-success-border:rgba(110,220,150,.45);
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
        border-radius:10px; border:1px solid var(--mtc-border-color); background:var(--mtc-card-bg); color:var(--mtc-text);
        padding:9px 10px; font-size:14px; font-family:inherit;
      }
      .roche-plugin-memory-token-cleaner textarea { width:100%; min-height:96px; resize:vertical; line-height:1.5; }
      .roche-plugin-memory-token-cleaner textarea::placeholder { color:rgba(31,35,40,.38); }
      @media (prefers-color-scheme: dark) {
        .roche-plugin-memory-token-cleaner textarea::placeholder { color:rgba(244,246,248,.38); }
      }
      .roche-plugin-memory-token-cleaner button { cursor:pointer; -webkit-tap-highlight-color:transparent; }
      .roche-plugin-memory-token-cleaner button.primary { background:var(--mtc-primary-bg); border-color:var(--mtc-primary-border); }
      .roche-plugin-memory-token-cleaner button.danger { background:var(--mtc-danger-bg); border-color:var(--mtc-danger-border); }
      .roche-plugin-memory-token-cleaner button.success { background:var(--mtc-success-bg); border-color:var(--mtc-success-border); }
      .roche-plugin-memory-token-cleaner button:disabled { opacity:.45; cursor:not-allowed; }
      .roche-plugin-memory-token-cleaner .mtc-card,
      .roche-plugin-memory-token-cleaner .mtc-fact {
        border:1px solid var(--mtc-border-color); background:var(--mtc-card-bg); border-radius:14px; padding:12px; margin:10px 0;
      }
      .roche-plugin-memory-token-cleaner .mtc-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .roche-plugin-memory-token-cleaner .mtc-row select { flex:1; min-width:180px; }
      .roche-plugin-memory-token-cleaner .mtc-muted, .roche-plugin-memory-token-cleaner .mtc-field-note { color:var(--mtc-muted-color); font-size:12px; line-height:1.45; }
      .roche-plugin-memory-token-cleaner .mtc-stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .roche-plugin-memory-token-cleaner .mtc-stat { background:var(--mtc-soft-bg); border-radius:12px; padding:9px; }
      .roche-plugin-memory-token-cleaner .mtc-stat b { display:block; font-size:18px; }
      .roche-plugin-memory-token-cleaner .mtc-list { display:flex; flex-direction:column; gap:10px; }
      .roche-plugin-memory-token-cleaner .mtc-fact { background:var(--mtc-soft-bg); }
      .roche-plugin-memory-token-cleaner .mtc-badges { display:flex; gap:5px; flex-wrap:wrap; }
      .roche-plugin-memory-token-cleaner .mtc-badge {
        display:inline-flex; align-items:center; border-radius:999px; padding:2px 7px; font-size:11px;
        background:var(--mtc-card-bg); border:1px solid var(--mtc-border-color);
      }
      .roche-plugin-memory-token-cleaner .mtc-badge.warn { background:rgba(255,180,60,.14); border-color:rgba(255,180,60,.3); }
      .roche-plugin-memory-token-cleaner .mtc-badge.danger { background:rgba(255,80,80,.14); border-color:rgba(255,80,80,.3); }
      .roche-plugin-memory-token-cleaner .mtc-badge.confirm { background:rgba(180,120,255,.14); border-color:rgba(180,120,255,.35); }
      .roche-plugin-memory-token-cleaner .mtc-text { white-space:pre-wrap; line-height:1.5; font-size:13px; word-break:break-word; }
      .roche-plugin-memory-token-cleaner .mtc-proposal { margin-top:8px; padding:8px; border-radius:10px; background:rgba(90,140,255,.10); border:1px solid var(--mtc-primary-border); }
      .roche-plugin-memory-token-cleaner .mtc-settings-grid { display:grid; grid-template-columns:1fr 90px; gap:8px; align-items:center; }
      .roche-plugin-memory-token-cleaner .mtc-switch-button {
        width:100%; display:grid; grid-template-columns:1fr auto; gap:12px; align-items:center; text-align:left;
        padding:12px 10px; border-radius:0; border-width:0 0 1px 0; background:transparent;
      }
      .roche-plugin-memory-token-cleaner .mtc-switch-pill { min-width:44px; text-align:center; border-radius:999px; padding:4px 10px; font-size:12px; background:var(--mtc-soft-bg); border:1px solid var(--mtc-border-color); }
      .roche-plugin-memory-token-cleaner .mtc-switch-button.on .mtc-switch-pill { background:var(--mtc-primary-bg); border-color:var(--mtc-primary-border); }
      .roche-plugin-memory-token-cleaner .mtc-custom-panel.hidden { display:none; }
      .roche-plugin-memory-token-cleaner .mtc-log { max-height:160px; overflow:auto; font-size:12px; line-height:1.4; background:var(--mtc-soft-bg); border-radius:12px; padding:8px; }
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
          position: container.style.position,
          touchAction: container.style.touchAction,
          webkitOverflowScrolling: container.style.webkitOverflowScrolling
        };
        container.style.position = "relative";
        container.style.overflow = "hidden";
        container.style.height = "100dvh";
        container.style.minHeight = "0";
        container.style.touchAction = "pan-y";
        container.style.webkitOverflowScrolling = "touch";

        const root = document.createElement("div");
        root.className = "roche-plugin-memory-token-cleaner";
        container.replaceChildren(root);

        let state = {
          settings: await loadSettings(roche),
          conversations: [],
          conversationId: "",
          facts: [],
          core: null,
          vectors: [],
          proposals: new Map(),
          selected: new Set(),
          customInstruction: "",
          reviewMode: "review",
          showCustomInstruction: false,
          showConfirmPanel: false,
          busy: false
        };

        function installTouchScrollFallback(scrollEl) {
          let lastY = 0, active = false;
          const isInteractive = target => !!target?.closest?.("input, textarea, select, button, summary, .mtc-log");
          scrollEl.addEventListener("touchstart", e => {
            if (!e.touches?.length) return;
            active = true; lastY = e.touches[0].clientY;
          }, { passive:true });
          scrollEl.addEventListener("touchmove", e => {
            if (!active || !e.touches?.length) return;
            const y = e.touches[0].clientY;
            const dy = lastY - y;
            lastY = y;
            if (Math.abs(dy) < 1 || scrollEl.scrollHeight <= scrollEl.clientHeight + 2) return;
            const before = scrollEl.scrollTop;
            scrollEl.scrollTop = before + dy;
            if (scrollEl.scrollTop !== before && !isInteractive(e.target)) e.preventDefault();
          }, { passive:false });
          scrollEl.addEventListener("touchend", () => active = false, { passive:true });
          scrollEl.addEventListener("touchcancel", () => active = false, { passive:true });
        }
        installTouchScrollFallback(root);

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

        function currentRows() {
          return state.facts.map(item => {
            const id = getMemoryId(item);
            const text = getFactText(item);
            return { id, item, text, analysis: localAnalyzeFact(text, state.settings) };
          });
        }

        function stats() {
          const rows = currentRows();
          const totalTokens = rows.reduce((sum, r) => sum + r.analysis.tokenEstimate, 0);
          const flagged = rows.filter(r => r.analysis.flags.length || r.analysis.recommendation !== "KEEP").length;
          const safe = Array.from(state.proposals.values()).filter(p => p.action !== "KEEP" && p.risk !== "confirm").length;
          const confirm = Array.from(state.proposals.values()).filter(p => p.action !== "KEEP" && p.risk === "confirm").length;
          return { rows, totalTokens, flagged, safe, confirm };
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
            if (!state.conversationId && state.conversations.length) {
              state.conversationId = state.conversations[0].id;
            }
          } catch (err) {
            roche.ui.toast("读取会话失败：" + (err?.message || err));
            log("读取会话失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        async function loadMemory() {
          if (!state.conversationId) {
            roche.ui.toast("请先选择会话。");
            return;
          }
          setBusy(true);
          try {
            const memory = await roche.memory.getLongTerm({
              conversationId: state.conversationId,
              limit: state.settings.longTermLimit
            });
            state.core = memory?.core || null;
            state.facts = Array.isArray(memory?.facts) ? memory.facts : [];
            state.vectors = Array.isArray(memory?.vectors) ? memory.vectors : [];
            state.proposals.clear();
            state.selected.clear();
            log(`已读取长期记忆：facts ${state.facts.length}，vectors ${state.vectors.length}。`);
          } catch (err) {
            roche.ui.toast("读取记忆失败：" + (err?.message || err));
            log("读取记忆失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        function selectedOrFlaggedRows() {
          const rows = currentRows();
          if (state.selected.size) return rows.filter(r => state.selected.has(r.id));
          return rows.filter(r => r.analysis.flags.length || r.analysis.recommendation !== "KEEP");
        }

        async function reviewWithAi() {
          const rows = selectedOrFlaggedRows();
          if (!rows.length) {
            roche.ui.toast("没有需要审查的记忆。");
            return;
          }
          state.customInstruction = cleanCustomInstruction(root.querySelector("#mtc-custom-instruction")?.value || state.customInstruction || "");
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
              log(`AI审查第 ${Math.floor(i / state.settings.batchSize) + 1} 批，共 ${records.length} 条。`);
              const raw = await askAiForReview(roche, records, state.settings, state.customInstruction, state.reviewMode);
              const factMap = new Map(currentRows().map(r => [r.id, r]));
              raw.map(p => normalizeProposal(p, factMap, state.settings, state.reviewMode)).forEach(p => {
                state.proposals.set(p.id, p);
                count++;
              });
            }
            const st = stats();
            roche.ui.toast(`审查完成：安全建议 ${st.safe}，待确认 ${st.confirm}。`);
            log(`审查完成：${count} 条建议。安全 ${st.safe}，待确认 ${st.confirm}。`);
          } catch (err) {
            roche.ui.toast("AI审查失败：" + (err?.message || err));
            log("AI审查失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        async function quickCompressFlagged() {
          const rows = currentRows().filter(r =>
            r.analysis.flags.includes("过长") ||
            r.analysis.flags.includes("像流水账") ||
            r.analysis.flags.includes("多事件")
          );
          if (!rows.length) {
            roche.ui.toast("没有本地识别到需要压缩的记忆。");
            return;
          }
          const oldMode = state.reviewMode;
          state.reviewMode = "compressOnly";
          state.selected = new Set(rows.map(r => r.id));
          await reviewWithAi();
          state.reviewMode = oldMode || "review";
        }

        async function updateMemory(id, text) {
          await roche.memory.update(id, {
            summaryText: text,
            action: text,
            text,
            content: text,
            source: "plugin_memory_token_cleaner_v2"
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
            source: "plugin_memory_token_cleaner_v2"
          });
        }

        async function applyOneProposal(p) {
          if (!p || p.action === "KEEP") return "skip";
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
            const items = (p.newItems || []).map(x => finalMemoryText(x, p.keywords, state.settings)).filter(Boolean);
            if (items.length < 2) return "skip";
            try {
              for (const item of items) await writeMemory(item);
              await roche.memory.delete(p.id);
              return "split";
            } catch (err) {
              // 如果当前构建不能新建 fact，至少把原条压成多事件短版，避免操作失败。
              await updateMemory(p.id, items.join("\n"));
              return "split-fallback";
            }
          }
          return "skip";
        }

        async function applySafeProposals() {
          const proposals = Array.from(state.proposals.values()).filter(p => p.action !== "KEEP" && p.risk !== "confirm");
          if (!proposals.length) {
            roche.ui.toast("没有安全建议可应用。");
            return;
          }
          const ok = await roche.ui.confirm({
            title: "应用安全建议",
            message: `将应用 ${proposals.length} 条低风险建议。高风险拆分/删除不会自动应用。确定继续吗？`
          });
          if (!ok) return;

          setBusy(true);
          try {
            const done = { compress:0, delete:0, split:0, skip:0 };
            for (const p of proposals) {
              const r = await applyOneProposal(p);
              if (r === "compress") done.compress++;
              else if (r === "delete") done.delete++;
              else if (r.startsWith("split")) done.split++;
              else done.skip++;
            }
            roche.ui.toast(`完成：压缩 ${done.compress}，删除 ${done.delete}，拆分 ${done.split}。`);
            log(`已应用安全建议：压缩 ${done.compress}，删除 ${done.delete}，拆分 ${done.split}，跳过 ${done.skip}。`);
            await loadMemory();
          } catch (err) {
            roche.ui.toast("应用失败：" + (err?.message || err));
            log("应用失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        async function applyConfirmProposal(id) {
          const p = state.proposals.get(id);
          if (!p) return;
          const ok = await roche.ui.confirm({
            title: "应用待确认建议",
            message: `将执行 ${p.action}。此操作可能修改或删除主事实记忆，确定继续吗？`
          });
          if (!ok) return;
          setBusy(true);
          try {
            await applyOneProposal(p);
            roche.ui.toast("已应用。");
            await loadMemory();
          } catch (err) {
            roche.ui.toast("应用失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        function keepProposal(id) {
          state.proposals.delete(id);
          render();
        }

        async function deleteSelected() {
          const ids = Array.from(state.selected);
          if (!ids.length) {
            roche.ui.toast("请先勾选要删除的记忆。");
            return;
          }
          const ok = await roche.ui.confirm({
            title: "删除事实记忆",
            message: `将删除 ${ids.length} 条 Roche 主事实记忆。确定继续吗？`
          });
          if (!ok) return;
          setBusy(true);
          try {
            for (const id of ids) await roche.memory.delete(id);
            roche.ui.toast(`已删除 ${ids.length} 条。`);
            await loadMemory();
          } catch (err) {
            roche.ui.toast("删除失败：" + (err?.message || err));
          } finally {
            setBusy(false);
          }
        }

        async function tryDeleteVectors() {
          if (!state.vectors.length) return roche.ui.toast("当前没有向量记忆。");
          const ok = await roche.ui.confirm({
            title: "尝试删除向量记忆",
            message: `将尝试删除 ${state.vectors.length} 条向量记忆。如果当前 Roche 不支持，会自动跳过失败项。确定继续吗？`
          });
          if (!ok) return;
          setBusy(true);
          try {
            let done = 0, failed = 0;
            for (const v of state.vectors) {
              const id = getMemoryId(v);
              if (!id) { failed++; continue; }
              try { await roche.memory.delete(id); done++; } catch (_) { failed++; }
            }
            roche.ui.toast(`向量删除尝试完成：成功 ${done}，失败 ${failed}。`);
            await loadMemory();
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

        function proposalBadge(p) {
          if (!p || p.action === "KEEP") return "";
          const cls = p.action === "DELETE" ? "danger" : (p.risk === "confirm" ? "confirm" : "warn");
          return `<span class="mtc-badge ${cls}">${escapeHtml(p.action)}${p.risk === "confirm" ? " 待确认" : ""}</span>`;
        }

        function renderProposal(p) {
          if (!p || p.action === "KEEP") return "";
          const splitItems = (p.newItems || []).map((x, i) => `<div class="mtc-text">${i + 1}. ${escapeHtml(finalMemoryText(x, p.keywords, state.settings))}</div>`).join("");
          return `
            <div class="mtc-proposal">
              <div class="mtc-badges">
                ${proposalBadge(p)}
                ${p.reason ? `<span class="mtc-badge">${escapeHtml(p.reason)}</span>` : ""}
                ${p.keywords?.length ? `<span class="mtc-badge">${escapeHtml(p.keywords.join(" / "))}</span>` : ""}
              </div>
              ${p.action === "COMPRESS" ? `<div class="mtc-text" style="margin-top:6px">${escapeHtml(finalMemoryText(p.newText, p.keywords, state.settings))}</div>` : ""}
              ${p.action === "SPLIT" ? `<div style="margin-top:6px">${splitItems}</div>` : ""}
            </div>
          `;
        }

        function renderFact(r) {
          const p = state.proposals.get(r.id);
          const checked = state.selected.has(r.id) ? "checked" : "";
          const recClass = r.analysis.recommendation === "DELETE" ? "danger" : (r.analysis.recommendation === "COMPRESS" ? "warn" : "");
          const flags = r.analysis.flags.map(f => `<span class="mtc-badge warn">${escapeHtml(f)}</span>`).join("");
          return `
            <div class="mtc-fact" data-id="${escapeHtml(r.id)}">
              <div class="mtc-row" style="justify-content:space-between">
                <label class="mtc-row" style="gap:6px">
                  <input type="checkbox" class="mtc-check" data-id="${escapeHtml(r.id)}" ${checked}>
                  <span class="mtc-badge ${recClass}">${escapeHtml(r.analysis.recommendation)}</span>
                  <span class="mtc-badge">${r.analysis.len}字</span>
                  <span class="mtc-badge">~${r.analysis.tokenEstimate}tok</span>
                </label>
              </div>
              <div class="mtc-badges" style="margin-top:6px">${flags}</div>
              <div class="mtc-text" style="margin-top:8px">${escapeHtml(r.text)}</div>
              ${renderProposal(p)}
            </div>
          `;
        }

        function renderConfirmPanel() {
          const items = Array.from(state.proposals.values()).filter(p => p.action !== "KEEP" && p.risk === "confirm");
          if (!state.showConfirmPanel || !items.length) return "";
          const factMap = new Map(currentRows().map(r => [r.id, r]));
          return `
            <div class="mtc-card">
              <div style="font-weight:700;margin-bottom:8px">待人工确认 ${items.length} 条</div>
              ${items.map(p => {
                const original = factMap.get(p.id)?.text || "";
                return `
                  <div class="mtc-fact">
                    <div class="mtc-badges">${proposalBadge(p)} ${p.reason ? `<span class="mtc-badge">${escapeHtml(p.reason)}</span>` : ""}</div>
                    <div class="mtc-muted" style="margin-top:8px">原记忆</div>
                    <div class="mtc-text">${escapeHtml(original)}</div>
                    <div class="mtc-muted" style="margin-top:8px">建议</div>
                    ${renderProposal(p)}
                    <div class="mtc-row" style="margin-top:8px">
                      <button class="primary mtc-apply-confirm" data-id="${escapeHtml(p.id)}">应用</button>
                      <button class="mtc-keep-proposal" data-id="${escapeHtml(p.id)}">保留原文</button>
                    </div>
                  </div>
                `;
              }).join("")}
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
              <button id="mtc-back">返回</button>
              <div class="mtc-title">记忆低Token清理器 v2</div>
            </div>

            <div class="mtc-card">
              <div class="mtc-row">
                <select id="mtc-conversation">${convOptions || `<option value="">未读取会话</option>`}</select>
                <button id="mtc-load-conv" ${disabled}>刷新会话</button>
                <button id="mtc-load-memory" class="primary" ${disabled}>读取记忆</button>
              </div>
              <div class="mtc-row" style="margin-top:8px">
                <input id="mtc-manual-conversation-id" placeholder="兼容模式：手动粘贴 conversationId" value="${escapeHtml(state.conversationId || "")}" style="flex:1;min-width:220px">
                <button id="mtc-use-manual-conv" ${disabled}>使用这个ID</button>
              </div>
              <div class="mtc-muted" style="margin-top:8px">Core Memory 只读不改。v2 会优先保留事件锚点，不把记忆压成人设标签。</div>
            </div>

            <div class="mtc-card">
              <div class="mtc-stats">
                <div class="mtc-stat"><b>${state.facts.length}</b><span>事实记忆</span></div>
                <div class="mtc-stat"><b>${state.vectors.length}</b><span>向量记忆</span></div>
                <div class="mtc-stat"><b>${s.flagged}</b><span>疑似需处理</span></div>
                <div class="mtc-stat"><b>${s.totalTokens}</b><span>事实估算token</span></div>
                <div class="mtc-stat"><b>${s.safe}</b><span>安全建议</span></div>
                <div class="mtc-stat"><b>${s.confirm}</b><span>待确认</span></div>
              </div>
            </div>

            <div class="mtc-card">
              <div class="mtc-row">
                <button id="mtc-ai-review" class="primary" ${disabled}>AI审查疑似记忆</button>
                <button id="mtc-quick-compress" ${disabled}>压缩过长/流水账</button>
                <button id="mtc-apply-safe" class="primary" ${disabled}>应用安全建议${s.safe ? `(${s.safe})` : ""}</button>
                <button id="mtc-toggle-confirm" ${disabled}>待确认${s.confirm ? `(${s.confirm})` : ""}</button>
                <button id="mtc-toggle-custom-instruction" class="success" ${disabled}>审查补充要求</button>
                <button id="mtc-delete-selected" class="danger" ${disabled}>删除勾选</button>
                <button id="mtc-scroll-top" ${disabled}>回到顶部</button>
                <button id="mtc-scroll-bottom" ${disabled}>到底部</button>
              </div>
              <div id="mtc-custom-instruction-panel" class="mtc-custom-panel ${state.showCustomInstruction ? "" : "hidden"}" style="margin-top:10px">
                <div style="font-weight:700; margin-bottom:8px">本次 AI 审查补充要求</div>
                <textarea id="mtc-custom-instruction" placeholder="例：保留地点；注意时间顺序；只压缩不删除；保留未完成承诺。">${escapeHtml(state.customInstruction || "")}</textarea>
                <div class="mtc-field-note">仅影响本次 AI 审查。</div>
              </div>
              <div class="mtc-muted" style="margin-top:8px">建议：Roche“最新事实注入上限”设为 3～5。安全建议可批量应用，高风险拆分/删除会进入待确认。</div>
            </div>

            ${renderConfirmPanel()}

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
              </div>

              <details style="margin-top:12px">
                <summary>高级开关</summary>
                <div style="margin-top:8px">
                  ${renderSwitchRow("writeKeywords", "关键词写回主记忆", state.settings.writeKeywords)}
                  ${renderSwitchRow("autoApplySafeCompress", "压缩建议可自动应用", state.settings.autoApplySafeCompress)}
                  ${renderSwitchRow("showCore", "显示Core Memory", state.settings.showCore)}
                  ${renderSwitchRow("showVectors", "显示向量区", state.settings.showVectors)}
                </div>
              </details>

              <div class="mtc-row" style="margin-top:10px">
                <button id="mtc-save-settings" ${disabled}>保存设置</button>
                <button id="mtc-restore-defaults" class="danger" ${disabled}>恢复默认</button>
              </div>
            </details>

            ${state.settings.showCore ? `
              <details class="mtc-card">
                <summary>Core Memory（只读）</summary>
                <div class="mtc-text" style="margin-top:8px">${escapeHtml(state.core?.summary || state.core?.text || JSON.stringify(state.core || {}, null, 2))}</div>
              </details>` : ""}

            ${state.settings.showVectors ? `
              <div class="mtc-card">
                <div class="mtc-row">
                  <div style="flex:1">向量记忆：${state.vectors.length} 条</div>
                  <button id="mtc-delete-vectors" class="danger" ${disabled}>尝试删除全部向量</button>
                </div>
                <div class="mtc-muted" style="margin-top:8px">如果 Roche 不支持删除 vector，会显示失败数量。</div>
              </div>` : ""}

            <div class="mtc-card">
              <div class="mtc-row">
                <button id="mtc-select-flagged" ${disabled}>勾选疑似</button>
                <button id="mtc-clear-select" ${disabled}>取消勾选</button>
                <span class="mtc-muted">已勾选 ${state.selected.size} 条</span>
              </div>
            </div>

            <div class="mtc-list">${s.rows.map(r => renderFact(r)).join("") || `<div class="mtc-card mtc-muted">暂无事实记忆。请先读取会话记忆。</div>`}</div>

            <div class="mtc-card"><div class="mtc-log" id="mtc-log"></div></div>
            <div class="mtc-bottom-spacer"></div>
          `;

          bindEvents();
        }

        function bindEvents() {
          root.querySelector("#mtc-back")?.addEventListener("click", () => roche.ui.closeApp());
          root.querySelector("#mtc-load-conv")?.addEventListener("click", loadConversations);
          root.querySelector("#mtc-load-memory")?.addEventListener("click", loadMemory);
          root.querySelector("#mtc-use-manual-conv")?.addEventListener("click", () => {
            const manual = String(root.querySelector("#mtc-manual-conversation-id")?.value || "").trim();
            if (!manual) return roche.ui.toast("请先粘贴 conversationId。");
            state.conversationId = manual;
            state.facts = []; state.vectors = []; state.core = null; state.proposals.clear(); state.selected.clear();
            render();
          });
          root.querySelector("#mtc-conversation")?.addEventListener("change", e => {
            state.conversationId = e.target.value;
            state.facts = []; state.vectors = []; state.core = null; state.proposals.clear(); state.selected.clear();
            render();
          });
          root.querySelector("#mtc-custom-instruction")?.addEventListener("input", e => state.customInstruction = e.target.value);
          root.querySelector("#mtc-ai-review")?.addEventListener("click", () => { state.reviewMode = "review"; reviewWithAi(); });
          root.querySelector("#mtc-quick-compress")?.addEventListener("click", quickCompressFlagged);
          root.querySelector("#mtc-apply-safe")?.addEventListener("click", applySafeProposals);
          root.querySelector("#mtc-toggle-confirm")?.addEventListener("click", () => { state.showConfirmPanel = !state.showConfirmPanel; render(); });
          root.querySelector("#mtc-toggle-custom-instruction")?.addEventListener("click", () => {
            state.showCustomInstruction = !state.showCustomInstruction;
            const panel = root.querySelector("#mtc-custom-instruction-panel");
            if (panel) panel.classList.toggle("hidden", !state.showCustomInstruction);
          });
          root.querySelector("#mtc-delete-selected")?.addEventListener("click", deleteSelected);
          root.querySelector("#mtc-scroll-top")?.addEventListener("click", () => root.scrollTo({ top: 0, behavior: "smooth" }));
          root.querySelector("#mtc-scroll-bottom")?.addEventListener("click", () => root.scrollTo({ top: root.scrollHeight, behavior: "smooth" }));
          root.querySelector("#mtc-save-settings")?.addEventListener("click", saveSettingsFromUi);
          root.querySelector("#mtc-restore-defaults")?.addEventListener("click", restoreDefaultSettings);
          root.querySelector("#mtc-delete-vectors")?.addEventListener("click", tryDeleteVectors);
          root.querySelector("#mtc-select-flagged")?.addEventListener("click", () => {
            currentRows().forEach(r => {
              if (r.analysis.flags.length || r.analysis.recommendation !== "KEEP") state.selected.add(r.id);
            });
            render();
          });
          root.querySelector("#mtc-clear-select")?.addEventListener("click", () => { state.selected.clear(); render(); });
          root.querySelectorAll(".mtc-check").forEach(cb => cb.addEventListener("change", e => {
            const id = e.target.dataset.id;
            if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
            render();
          }));
          root.querySelectorAll(".mtc-switch-button").forEach(btn => btn.addEventListener("click", () => {
            const key = btn.dataset.settingKey;
            if (!key || !(key in state.settings)) return;
            state.settings[key] = !state.settings[key];
            const value = !!state.settings[key];
            btn.classList.toggle("on", value);
            btn.setAttribute("aria-pressed", value ? "true" : "false");
            const pill = btn.querySelector(".mtc-switch-pill");
            if (pill) pill.textContent = value ? "开" : "关";
          }));
          root.querySelectorAll(".mtc-apply-confirm").forEach(btn => btn.addEventListener("click", () => applyConfirmProposal(btn.dataset.id)));
          root.querySelectorAll(".mtc-keep-proposal").forEach(btn => btn.addEventListener("click", () => keepProposal(btn.dataset.id)));
        }

        await loadConversations();
        if (state.conversationId) await loadMemory();
        render();

        container.__memoryTokenCleanerUnmount = () => {
          style.remove();
          container.style.overflow = previous.overflow;
          container.style.height = previous.height;
          container.style.minHeight = previous.minHeight;
          container.style.position = previous.position;
          container.style.touchAction = previous.touchAction;
          container.style.webkitOverflowScrolling = previous.webkitOverflowScrolling;
        };
      },
      async unmount(container) {
        try { container.__memoryTokenCleanerUnmount?.(); } catch (_) {}
        container.replaceChildren();
      }
    }]
  });
})();