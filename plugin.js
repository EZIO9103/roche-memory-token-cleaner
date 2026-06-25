;(() => {
  "use strict";

  const PLUGIN_ID = "memory-token-cleaner";
  const APP_ID = "memory-token-cleaner-home";
  const VERSION = "1.0.8";

  const DEFAULT_SETTINGS = {
    maxChars: 70,
    preferredMin: 30,
    preferredMax: 50,
    keywordLimit: 3,
    writeKeywords: true,
    strictMode: true,
    autoApplyCompress: false,
    deleteNeedsConfirm: true,
    batchSize: 3,
    longTermLimit: 300,
    showCore: false,
    showVectors: true
  };

  const LOW_VALUE_HINTS = [
    "表情", "贴纸", "sticker", "emoji", "哈哈", "笑死", "调侃", "玩笑", "破防",
    "自拍", "照片", "合照", "发图", "图片", "涩", "黄段子", "露骨",
    "吃饭", "早餐", "午餐", "晚餐", "睡觉", "洗澡", "刷牙", "喝水",
    "道歉", "抱歉", "尴尬", "脸红", "害羞", "沉默", "已读", "Noted"
  ];

  const IMPORTANT_HINTS = [
    "承诺", "答应", "拒绝", "边界", "和解", "争吵", "分手", "复合",
    "告白", "亲密", "关系", "信任", "远距离", "离开", "重逢", "搬家",
    "香港", "英国", "伦敦", "见面", "以后", "未来", "配偶", "婚姻",
    "称呼", "面具", "钥匙", "家", "公寓", "主动", "不再", "默认"
  ];

  function escapeHtml(text) {
    return String(text ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function nowDateText() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function countChineseChars(text) {
    return [...String(text || "")].length;
  }

  function getMemoryId(item) {
    return item?.id || item?.memoryId || item?.factId || item?.sourceFactId || item?._id || "";
  }

  function getFactText(item) {
    return String(item?.summaryText || item?.action || item?.text || item?.content || "").trim();
  }

  function unique(arr) {
    return Array.from(new Set((arr || []).map(x => String(x || "").trim()).filter(Boolean)));
  }

  function keywordTags(keywords, limit) {
    return unique(keywords)
      .slice(0, limit)
      .map(k => k.replace(/^#/, "").replace(/\s+/g, ""))
      .filter(Boolean)
      .map(k => `#${k}`)
      .join(" ");
  }

  function stripCodeFence(text) {
    let t = String(text || "").trim();
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    return t;
  }

  function extractAiText(result) {
    if (typeof result === "string") return result;
    if (!result) return "";
    const candidates = [
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
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c;
    }
    try { return JSON.stringify(result); } catch (_) { return ""; }
  }

  function repairJsonLikeText(text) {
    return String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .trim();
  }

  function safeJsonParse(text) {
    const raw = repairJsonLikeText(stripCodeFence(text));

    try { return JSON.parse(raw); } catch (_) {}

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { return JSON.parse(repairJsonLikeText(fenced[1])); } catch (_) {}
    }

    const arrayStart = raw.indexOf("[");
    const arrayEnd = raw.lastIndexOf("]");
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      const arrText = raw.slice(arrayStart, arrayEnd + 1);
      try { return JSON.parse(arrText); } catch (_) {}
    }

    const objectStart = raw.indexOf("{");
    const objectEnd = raw.lastIndexOf("}");
    if (objectStart !== -1 && objectEnd > objectStart) {
      const objText = raw.slice(objectStart, objectEnd + 1);
      try {
        const obj = JSON.parse(objText);
        if (Array.isArray(obj)) return obj;
        if (Array.isArray(obj.items)) return obj.items;
        if (Array.isArray(obj.results)) return obj.results;
        if (Array.isArray(obj.memories)) return obj.memories;
        if (Array.isArray(obj.proposals)) return obj.proposals;
        return [obj];
      } catch (_) {}
    }

    const lines = raw.split(/\n+/).map(x => x.trim()).filter(Boolean);
    const parsedLines = [];
    for (const line of lines) {
      if (!line.startsWith("{") || !line.endsWith("}")) continue;
      try { parsedLines.push(JSON.parse(line)); } catch (_) {}
    }
    if (parsedLines.length) return parsedLines;

    const preview = raw.slice(0, 300).replace(/\s+/g, " ");
    throw new Error("AI 返回内容不是可解析 JSON。返回开头：" + preview);
  }

  function estimateTokens(text) {
    const s = String(text || "");
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const asciiWords = (s.replace(/[\u4e00-\u9fff]/g, " ").match(/[A-Za-z0-9_#-]+/g) || []).length;
    const punct = Math.ceil(Math.max(0, s.length - cjk) / 8);
    return Math.max(1, cjk + asciiWords + punct);
  }

  function cleanCustomInstruction(text) {
    return String(text || "")
      .replace(/\r/g, "")
      .trim()
      .slice(0, 1200);
  }

  function localAnalyzeFact(text, settings) {
    const t = String(text || "");
    const len = countChineseChars(t);
    const timeHits = (t.match(/\d{1,2}[:：]\d{2}|20\d{2}-\d{2}-\d{2}|6\s*月|\d{1,2}\s*日|约\s*\d{1,2}\s*时/g) || []).length;
    const hasTimeline = timeHits >= 2 || /随后|期间|之后|接着|同时|最终|然后|再|又|起|至|到/.test(t);
    const lowHits = LOW_VALUE_HINTS.filter(k => t.includes(k)).length;
    const importantHits = IMPORTANT_HINTS.filter(k => t.includes(k)).length;
    const hasManySentences = (t.match(/[。！？.!?]/g) || []).length >= 3;
    const hasHash = /#[\u4e00-\u9fffA-Za-z0-9_-]+/.test(t);

    const flags = [];
    if (len > settings.maxChars) flags.push("过长");
    if (hasTimeline) flags.push("像流水账");
    if (hasManySentences) flags.push("多事件");
    if (lowHits >= 2 && importantHits === 0) flags.push("低价值倾向");
    if (!hasHash && settings.writeKeywords) flags.push("无关键词");

    let score = 0;
    score += Math.min(3, importantHits) * 2;
    score -= Math.min(3, lowHits);
    if (len > settings.maxChars) score -= 1;
    if (hasTimeline) score -= 1;
    if (hasHash) score += 1;

    let recommendation = "KEEP";
    if (score <= -2) recommendation = "DELETE";
    else if (flags.length > 0) recommendation = "COMPRESS";

    return { len, timeHits, lowHits, importantHits, flags, recommendation, tokenEstimate: estimateTokens(t) };
  }

  function buildReviewerPrompt(records, settings, customInstruction = "", mode = "review") {
    const today = nowDateText();
    return `你是 Roche 记忆低 Token 清理器。今天是 ${today}。

你正在审查一组事实记忆。你的任务不是总结聊天，而是判断这些记忆是否值得继续留在长期记忆里。

${mode === "compressOnly" ? "本次模式：仅压缩过长/流水账。只能返回 KEEP 或 COMPRESS，不能返回 DELETE。除非完全无文本可处理，否则不要删除。" : "本次模式：完整审查。可以返回 KEEP、COMPRESS 或 DELETE。"}

对每条记忆只允许选择一个动作：
KEEP：仍然重要，保留不动。
COMPRESS：有价值但太长、太流水账，需要压缩。
${mode === "compressOnly" ? "" : "DELETE：普通、重复、过时、无后续意义，应遗忘。"}

判断标准：
${cleanCustomInstruction(customInstruction) ? `

本次用户补充要求：
${cleanCustomInstruction(customInstruction)}

以上补充要求优先用于判断取舍，但不得违反低 Token 原则；如果补充要求为空，则只按默认规则处理。
` : ""}
1. 这条记忆是否造成了 {{char}} 与 {{user}} 之间长期的关系后果？
2. 它是否影响关系、信任、边界、承诺、冲突、和解、亲密、距离、地点或未来方向？
3. 它是否是新先例，而不是重复玩笑或普通互动？
4. 几周或几个月后，真实的人是否还会记住它？
5. 如果忘掉它，{{char}} 是否会明显倒退或回应错误？

删除倾向：
普通闲聊、重复调侃、表情包、一次性自拍索要、临时害羞、普通道歉、黄段子细节、日常吃饭睡觉洗澡、没有新关系后果的热闹互动。

压缩要求：
像第三人称日记句，不像报告。
只保留一个长期记忆点。
不写时间流水账。
不写多个事件。
不写露骨细节。
默认 ${settings.preferredMin}-${settings.preferredMax} 个中文字，最多 ${settings.maxChars} 个中文字。
关键词只给 2-${settings.keywordLimit} 个，用于检索。

只返回严格 JSON 数组。不要解释，不要寒暄，不要 Markdown，不要代码块。输出必须以 [ 开头，以 ] 结尾。
每项格式：
{
  "id": "原id",
  "action": "KEEP|COMPRESS|DELETE",
  "newText": "COMPRESS时填写压缩后的中文记忆；KEEP和DELETE时留空",
  "keywords": ["关键词1","关键词2"],
  "reason": "不超过18字"
}

待审查记忆：
${JSON.stringify(records, null, 2)}`;
  }

  async function askAiForReview(roche, records, settings, customInstruction = "", mode = "review") {
    const prompt = buildReviewerPrompt(records, settings, customInstruction, mode);
    const result = await roche.ai.chat({
      messages: [
        { role: "system", content: "你是 JSON API。只输出有效 JSON 数组，不输出解释、Markdown 或代码块。输出必须以 [ 开头，以 ] 结尾。" },
        { role: "user", content: prompt }
      ],
      temperature: 0
    });

    const text = extractAiText(result);
    try {
      const parsed = safeJsonParse(text);
      if (!Array.isArray(parsed)) throw new Error("AI 返回 JSON 不是数组。");
      return parsed;
    } catch (err) {
      if (records.length <= 1) throw err;

      // 有些模型在批量时会返回说明文字或截断 JSON。失败时自动降级为逐条审查，避免整批报错。
      const recovered = [];
      for (const record of records) {
        const singlePrompt = buildReviewerPrompt([record], settings, customInstruction, mode);
        const single = await roche.ai.chat({
          messages: [
            { role: "system", content: "你是 JSON API。只输出一个 JSON 数组，数组内只有一个对象。不要解释、Markdown 或代码块。" },
            { role: "user", content: singlePrompt }
          ],
          temperature: 0
        });
        const singleText = extractAiText(single);
        const parsedSingle = safeJsonParse(singleText);
        if (Array.isArray(parsedSingle)) recovered.push(...parsedSingle);
        else recovered.push(parsedSingle);
      }
      return recovered;
    }
  }

  function normalizeProposal(p, factMap, settings) {
    const id = String(p?.id || "").trim();
    let action = String(p?.action || "KEEP").trim().toUpperCase();
    if (!["KEEP", "COMPRESS", "DELETE"].includes(action)) action = "KEEP";
    let newText = String(p?.newText || "").trim();
    const keywords = unique(p?.keywords || []).slice(0, settings.keywordLimit);
    const reason = String(p?.reason || "").trim().slice(0, 40);

    if (action === "COMPRESS") {
      if (!newText) action = "KEEP";
      if (countChineseChars(newText) > settings.maxChars) {
        newText = [...newText].slice(0, settings.maxChars).join("");
      }
    }
    if (!factMap.has(id)) action = "KEEP";
    return { id, action, newText, keywords, reason };
  }

  function finalMemoryText(newText, keywords, settings) {
    const body = String(newText || "").trim();
    if (!body) return "";
    if (!settings.writeKeywords) return body;
    const tags = keywordTags(keywords, settings.keywordLimit);
    return tags ? `${body} ${tags}` : body;
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
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--text-primary, #f5f5f5);
        position: absolute;
        inset: 0;
        display: block;
        padding: 14px;
        padding-bottom: calc(40px + env(safe-area-inset-bottom, 0px));
        height: auto;
        min-height: 0;
        max-height: none;
        overflow-y: scroll !important;
        overflow-x: hidden !important;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior-y: contain;
        touch-action: pan-y;
        box-sizing: border-box;
      }
      .roche-plugin-memory-token-cleaner * { box-sizing: border-box; }
      .roche-plugin-memory-token-cleaner .mtc-top {
        display: flex; gap: 8px; align-items: center; margin-bottom: 12px;
        position: sticky;
        top: 0;
        z-index: 10;
        padding: 4px 0 8px;
        background: var(--bg-primary, rgba(20,20,24,.92));
        backdrop-filter: blur(10px);
      }
      .roche-plugin-memory-token-cleaner button,
      .roche-plugin-memory-token-cleaner select,
      .roche-plugin-memory-token-cleaner input {
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.08);
        color: inherit;
        padding: 9px 10px;
        font-size: 14px;
      }
      .roche-plugin-memory-token-cleaner button {
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .roche-plugin-memory-token-cleaner button.primary {
        background: rgba(90,140,255,.28);
        border-color: rgba(120,165,255,.5);
      }
      .roche-plugin-memory-token-cleaner button.danger {
        background: rgba(255,80,80,.18);
        border-color: rgba(255,100,100,.45);
      }
      .roche-plugin-memory-token-cleaner button:disabled {
        opacity: .45; cursor: not-allowed;
      }
      .roche-plugin-memory-token-cleaner .mtc-title {
        font-size: 19px; font-weight: 700; flex: 1;
      }
      .roche-plugin-memory-token-cleaner .mtc-card {
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.06);
        border-radius: 14px;
        padding: 12px;
        margin: 10px 0;
      }
      .roche-plugin-memory-token-cleaner .mtc-row {
        display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      }
      .roche-plugin-memory-token-cleaner .mtc-row > * { flex: none; }
      .roche-plugin-memory-token-cleaner .mtc-row select { flex: 1; min-width: 180px; }
      .roche-plugin-memory-token-cleaner .mtc-muted {
        opacity: .7; font-size: 12px; line-height: 1.45;
      }
      .roche-plugin-memory-token-cleaner .mtc-stats {
        display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px;
      }
      .roche-plugin-memory-token-cleaner .mtc-stat {
        background: rgba(0,0,0,.15);
        border-radius: 12px;
        padding: 9px;
      }
      .roche-plugin-memory-token-cleaner .mtc-stat b {
        display: block; font-size: 18px;
      }
      .roche-plugin-memory-token-cleaner .mtc-list {
        display: flex; flex-direction: column; gap: 10px;
      }
      .roche-plugin-memory-token-cleaner .mtc-fact {
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(0,0,0,.16);
        border-radius: 14px;
        padding: 10px;
      }
      .roche-plugin-memory-token-cleaner .mtc-fact-top {
        display: flex; justify-content: space-between; gap: 8px; align-items: center;
        margin-bottom: 6px;
      }
      .roche-plugin-memory-token-cleaner .mtc-badges { display: flex; gap: 5px; flex-wrap: wrap; }
      .roche-plugin-memory-token-cleaner .mtc-badge {
        display: inline-flex; align-items: center;
        border-radius: 999px;
        padding: 2px 7px;
        font-size: 11px;
        background: rgba(255,255,255,.1);
        border: 1px solid rgba(255,255,255,.12);
      }
      .roche-plugin-memory-token-cleaner .mtc-badge.warn { background: rgba(255,180,60,.14); border-color: rgba(255,180,60,.3); }
      .roche-plugin-memory-token-cleaner .mtc-badge.danger { background: rgba(255,80,80,.14); border-color: rgba(255,80,80,.3); }
      .roche-plugin-memory-token-cleaner .mtc-text {
        white-space: pre-wrap;
        line-height: 1.5;
        font-size: 13px;
        word-break: break-word;
      }
      .roche-plugin-memory-token-cleaner .mtc-proposal {
        margin-top: 8px;
        padding: 8px;
        border-radius: 10px;
        background: rgba(90,140,255,.10);
        border: 1px solid rgba(90,140,255,.22);
      }
      .roche-plugin-memory-token-cleaner .mtc-settings-grid {
        display: grid; grid-template-columns: 1fr 90px; gap: 8px; align-items: center;
      }
      .roche-plugin-memory-token-cleaner .mtc-settings-grid label { font-size: 13px; opacity: .86; }
      .roche-plugin-memory-token-cleaner .mtc-settings-grid input[type="checkbox"] { width: 22px; height: 22px; }
      .roche-plugin-memory-token-cleaner textarea {
        width: 100%;
        min-height: 96px;
        resize: vertical;
        border-radius: 12px;
        border: 1px solid var(--mtc-border-color, rgba(31,35,40,.13));
        background: var(--mtc-card-bg, #fff);
        color: var(--mtc-text, #1f2328);
        padding: 10px 12px;
        font-size: 14px;
        line-height: 1.5;
        font-family: inherit;
        box-sizing: border-box;
      }
      .roche-plugin-memory-token-cleaner textarea::placeholder {
        color: rgba(31,35,40,.38);
      }
      @media (prefers-color-scheme: dark) {
        .roche-plugin-memory-token-cleaner textarea::placeholder {
          color: rgba(244,246,248,.38);
        }
      }
      .roche-plugin-memory-token-cleaner .mtc-switch-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        align-items: center;
        padding: 10px 0;
        border-bottom: 1px solid var(--mtc-border-color, rgba(31,35,40,.13));
      }
      .roche-plugin-memory-token-cleaner .mtc-switch-row:last-child {
        border-bottom: none;
      }
      .roche-plugin-memory-token-cleaner .mtc-switch-row input[type="checkbox"] {
        width: 22px !important;
        height: 22px !important;
        accent-color: #6f8cff;
      }
      .roche-plugin-memory-token-cleaner .mtc-field-note {
        font-size: 12px;
        line-height: 1.45;
        color: var(--mtc-muted-color, rgba(31,35,40,.62));
        margin-top: 6px;
      }
      .roche-plugin-memory-token-cleaner .mtc-switch-button {
        width: 100%;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        align-items: center;
        text-align: left;
        padding: 12px 10px;
        border-radius: 0 !important;
        border-width: 0 0 1px 0 !important;
        background: transparent !important;
      }
      .roche-plugin-memory-token-cleaner .mtc-switch-button:last-child {
        border-bottom-width: 0 !important;
      }
      .roche-plugin-memory-token-cleaner .mtc-switch-pill {
        min-width: 44px;
        text-align: center;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        background: var(--mtc-soft-bg, #f1f3f5);
        border: 1px solid var(--mtc-border-color, rgba(31,35,40,.13));
      }
      .roche-plugin-memory-token-cleaner .mtc-switch-button.on .mtc-switch-pill {
        background: var(--mtc-primary-bg, #dfe8ff);
        border-color: var(--mtc-primary-border, #b7c7ff);
      }
      .roche-plugin-memory-token-cleaner .mtc-hidden { display: none !important; }
      .roche-plugin-memory-token-cleaner .mtc-log {
        max-height: 160px; overflow: auto; font-size: 12px; line-height: 1.4;
        background: rgba(0,0,0,.18); border-radius: 12px; padding: 8px;
      }
      .roche-plugin-memory-token-cleaner .mtc-bottom-spacer {
        height: calc(80px + env(safe-area-inset-bottom, 0px));
        flex: 0 0 auto;
      }
      .roche-plugin-memory-token-cleaner {
        --mtc-bg: #ffffff;
        --mtc-text: #1f2328;
        --mtc-muted-color: rgba(31,35,40,.62);
        --mtc-card-bg: #ffffff;
        --mtc-soft-bg: #f1f3f5;
        --mtc-border-color: rgba(31,35,40,.13);
        --mtc-top-bg: rgba(255,255,255,.96);
        --mtc-primary-bg: #dfe8ff;
        --mtc-primary-border: #b7c7ff;
        --mtc-danger-bg: #ffe5e5;
        --mtc-danger-border: #ffc1c1;
        background: var(--mtc-bg);
        color: var(--mtc-text);
      }
      @media (prefers-color-scheme: dark) {
        .roche-plugin-memory-token-cleaner {
          --mtc-bg: #111216;
          --mtc-text: #f4f6f8;
          --mtc-muted-color: rgba(244,246,248,.68);
          --mtc-card-bg: rgba(255,255,255,.07);
          --mtc-soft-bg: rgba(255,255,255,.10);
          --mtc-border-color: rgba(255,255,255,.14);
          --mtc-top-bg: rgba(17,18,22,.96);
          --mtc-primary-bg: rgba(100,145,255,.28);
          --mtc-primary-border: rgba(140,170,255,.50);
          --mtc-danger-bg: rgba(255,90,90,.18);
          --mtc-danger-border: rgba(255,120,120,.42);
        }
      }
      .roche-plugin-memory-token-cleaner .mtc-top {
        background: var(--mtc-top-bg) !important;
        color: var(--mtc-text) !important;
        border-bottom: 1px solid var(--mtc-border-color);
      }
      .roche-plugin-memory-token-cleaner .mtc-title {
        color: var(--mtc-text) !important;
        opacity: 1 !important;
      }
      .roche-plugin-memory-token-cleaner button,
      .roche-plugin-memory-token-cleaner select,
      .roche-plugin-memory-token-cleaner input {
        background: var(--mtc-card-bg) !important;
        color: var(--mtc-text) !important;
        border-color: var(--mtc-border-color) !important;
      }
      .roche-plugin-memory-token-cleaner button.primary {
        background: var(--mtc-primary-bg) !important;
        border-color: var(--mtc-primary-border) !important;
      }
      .roche-plugin-memory-token-cleaner button.danger {
        background: var(--mtc-danger-bg) !important;
        border-color: var(--mtc-danger-border) !important;
      }
      .roche-plugin-memory-token-cleaner button.success {
        background: #dff7e8 !important;
        border-color: #9fddb8 !important;
        color: var(--mtc-text) !important;
      }
      @media (prefers-color-scheme: dark) {
        .roche-plugin-memory-token-cleaner button.success {
          background: rgba(70,190,120,.22) !important;
          border-color: rgba(110,220,150,.45) !important;
        }
      }
      .roche-plugin-memory-token-cleaner .mtc-custom-panel {
        margin-top: 10px;
        padding: 10px;
        border-radius: 14px;
        border: 1px solid var(--mtc-border-color, rgba(31,35,40,.13));
        background: var(--mtc-card-bg, #fff);
      }
      .roche-plugin-memory-token-cleaner .mtc-custom-panel.hidden {
        display: none;
      }
      .roche-plugin-memory-token-cleaner .mtc-card,
      .roche-plugin-memory-token-cleaner .mtc-fact {
        background: var(--mtc-card-bg) !important;
        border-color: var(--mtc-border-color) !important;
        color: var(--mtc-text) !important;
      }
      .roche-plugin-memory-token-cleaner .mtc-stat,
      .roche-plugin-memory-token-cleaner .mtc-badge,
      .roche-plugin-memory-token-cleaner .mtc-log {
        background: var(--mtc-soft-bg) !important;
        border-color: var(--mtc-border-color) !important;
        color: var(--mtc-text) !important;
      }
      .roche-plugin-memory-token-cleaner .mtc-muted {
        color: var(--mtc-muted-color) !important;
        opacity: 1 !important;
      }
      .roche-plugin-memory-token-cleaner .mtc-proposal {
        background: color-mix(in srgb, var(--mtc-primary-bg) 45%, transparent) !important;
        border-color: var(--mtc-primary-border) !important;
      }

    `;
    return style;
  }

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: "记忆低Token清理器",
    version: VERSION,
    apps: [
      {
        id: APP_ID,
        name: "记忆低Token清理器",
        icon: "settings",
        iconImage: "",
        async mount(container, roche) {
          const style = createStyle();
          document.head.appendChild(style);

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
            busy: false
          };

          const previousContainerOverflow = container.style.overflow;
          const previousContainerHeight = container.style.height;
          const previousContainerMinHeight = container.style.minHeight;
          const previousContainerPosition = container.style.position;
          const previousContainerTouchAction = container.style.touchAction;
          const previousContainerWebkitOverflowScrolling = container.style.webkitOverflowScrolling;
          container.style.position = "relative";
          container.style.overflow = "hidden";
          container.style.height = "100dvh";
          container.style.minHeight = "0";
          container.style.touchAction = "pan-y";
          container.style.webkitOverflowScrolling = "touch";

          const root = document.createElement("div");
          root.className = "roche-plugin-memory-token-cleaner";
          container.replaceChildren(root);
          installTouchScrollFallback(root);

          function log(msg) {
            const el = root.querySelector("#mtc-log");
            if (!el) return;
            const time = new Date().toLocaleTimeString();
            el.insertAdjacentHTML("afterbegin", `<div>[${escapeHtml(time)}] ${escapeHtml(msg)}</div>`);
          }

          function installTouchScrollFallback(scrollEl) {
            let lastY = 0;
            let active = false;
            let moved = false;

            const isInteractive = target => {
              return !!target?.closest?.("input, textarea, select, button, summary, .mtc-log");
            };

            scrollEl.addEventListener("touchstart", e => {
              if (!e.touches || !e.touches.length) return;
              active = true;
              moved = false;
              lastY = e.touches[0].clientY;
            }, { passive: true });

            scrollEl.addEventListener("touchmove", e => {
              if (!active || !e.touches || !e.touches.length) return;
              if (isInteractive(e.target) && Math.abs(e.touches[0].clientY - lastY) < 6) return;

              const y = e.touches[0].clientY;
              const dy = lastY - y;
              lastY = y;

              if (Math.abs(dy) < 1) return;
              const canScroll = scrollEl.scrollHeight > scrollEl.clientHeight + 2;
              if (!canScroll) return;

              const before = scrollEl.scrollTop;
              scrollEl.scrollTop = before + dy;
              moved = true;

              // 在部分 Android WebView 中，默认 touch 滚动被宿主拦截；这里手动滚动后阻止默认事件。
              if (scrollEl.scrollTop !== before || moved) {
                e.preventDefault();
              }
            }, { passive: false });

            scrollEl.addEventListener("touchend", () => {
              active = false;
              moved = false;
            }, { passive: true });

            scrollEl.addEventListener("touchcancel", () => {
              active = false;
              moved = false;
            }, { passive: true });
          }

          function setBusy(busy) {
            state.busy = busy;
            render();
          }

          function currentFactsWithAnalysis() {
            return state.facts.map(item => {
              const id = getMemoryId(item);
              const text = getFactText(item);
              return { id, item, text, analysis: localAnalyzeFact(text, state.settings) };
            });
          }

          function stats() {
            const rows = currentFactsWithAnalysis();
            const totalChars = rows.reduce((sum, r) => sum + countChineseChars(r.text), 0);
            const totalTokens = rows.reduce((sum, r) => sum + r.analysis.tokenEstimate, 0);
            const flagged = rows.filter(r => r.analysis.flags.length).length;
            const overLong = rows.filter(r => r.analysis.len > state.settings.maxChars).length;
            const low = rows.filter(r => r.analysis.recommendation === "DELETE").length;
            return { rows, totalChars, totalTokens, flagged, overLong, low };
          }

          async function loadConversations() {
            setBusy(true);
            try {
              let list = [];

              // 新版/部分构建可能提供 conversation.list。
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

              // 说明书稳定公开的是 character.list；角色字段里有 conversationId。
              // 某些 Roche 构建没有 conversation.list，所以这里用角色列表降级。
              if ((!list || !list.length) && roche.character?.list) {
                const chars = await roche.character.list();
                list = (Array.isArray(chars) ? chars : [])
                  .map(ch => ({
                    id: ch.conversationId || "",
                    characterId: ch.id || "",
                    name: ch.handle || ch.name || ch.displayName || ch.id || "未命名角色",
                    title: ch.name || ch.handle || ch.displayName || "",
                    avatar: ch.avatar || "",
                    isGroup: false,
                    type: "character",
                    source: "character"
                  }))
                  .filter(c => c.id);
                log(`当前 Roche 未提供 conversation.list，已改用 character.list 读取 ${list.length} 个角色会话。`);
              }

              // 最后的兜底：保留手动输入。
              state.conversations = Array.isArray(list) ? list : [];
              if (!state.conversationId && state.conversations.length) {
                const first = state.conversations[0];
                state.conversationId = first.id || first.conversationId || "";
              }

              if (!state.conversations.length) {
                log("未能自动拉取会话。可在下方手动粘贴 conversationId 后读取记忆。");
                roche.ui.toast("未能自动拉取会话：当前 Roche 可能缺少 conversation.list 和 character.list。");
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
            } finally {
              setBusy(false);
            }
          }

          function selectedOrFlaggedRows() {
            const rows = currentFactsWithAnalysis();
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
                const raw = await askAiForReview(roche, records, state.settings, state.customInstruction, state.reviewMode || "review");
                const factMap = new Map(currentFactsWithAnalysis().map(r => [r.id, r]));
                raw.map(p => normalizeProposal(p, factMap, state.settings)).forEach(p => {
                  state.proposals.set(p.id, p);
                  count++;
                });
                render();
              }
              roche.ui.toast(`AI 已生成 ${count} 条处理建议。`);
              log(`AI审查完成：${count} 条建议。`);
            } catch (err) {
              roche.ui.toast("AI审查失败：" + (err?.message || err));
              log("AI审查失败：" + (err?.message || err));
            } finally {
              setBusy(false);
            }
          }

          async function applyProposals() {
            const proposals = Array.from(state.proposals.values()).filter(p => p.action !== "KEEP");
            if (!proposals.length) {
              roche.ui.toast("没有可应用的建议。");
              return;
            }

            const deletes = proposals.filter(p => p.action === "DELETE").length;
            const compresses = proposals.filter(p => p.action === "COMPRESS").length;
            let ok = true;
            if (deletes > 0 || !state.settings.autoApplyCompress) {
              ok = await roche.ui.confirm({
                title: "应用记忆清理建议",
                message: `将压缩 ${compresses} 条，删除 ${deletes} 条 Roche 主事实记忆。删除不会随插件卸载自动恢复。确定继续吗？`
              });
            }
            if (!ok) return;

            setBusy(true);
            try {
              let doneCompress = 0, doneDelete = 0, skipped = 0;
              for (const p of proposals) {
                const id = p.id;
                if (!id) { skipped++; continue; }
                if (p.action === "DELETE") {
                  await roche.memory.delete(id);
                  doneDelete++;
                } else if (p.action === "COMPRESS") {
                  const text = finalMemoryText(p.newText, p.keywords, state.settings);
                  if (!text) { skipped++; continue; }
                  await roche.memory.update(id, {
                    summaryText: text,
                    action: text,
                    source: "plugin_memory_token_cleaner"
                  });
                  doneCompress++;
                }
              }
              roche.ui.toast(`完成：压缩 ${doneCompress} 条，删除 ${doneDelete} 条。`);
              log(`已应用：压缩 ${doneCompress}，删除 ${doneDelete}，跳过 ${skipped}。`);
              await loadMemory();
            } catch (err) {
              roche.ui.toast("应用建议失败：" + (err?.message || err));
              log("应用建议失败：" + (err?.message || err));
            } finally {
              setBusy(false);
            }
          }

          async function quickCompressFlagged() {
            const rows = currentFactsWithAnalysis().filter(r =>
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

          async function deleteSelected() {
            const ids = Array.from(state.selected);
            if (!ids.length) {
              roche.ui.toast("请先勾选要删除的记忆。");
              return;
            }
            const ok = await roche.ui.confirm({
              title: "删除事实记忆",
              message: `将删除 ${ids.length} 条 Roche 主事实记忆。此操作不会随插件卸载自动恢复。确定继续吗？`
            });
            if (!ok) return;
            setBusy(true);
            try {
              let done = 0;
              for (const id of ids) {
                await roche.memory.delete(id);
                done++;
              }
              roche.ui.toast(`已删除 ${done} 条。`);
              log(`已删除 ${done} 条事实记忆。`);
              await loadMemory();
            } catch (err) {
              roche.ui.toast("删除失败：" + (err?.message || err));
            } finally {
              setBusy(false);
            }
          }

          async function tryDeleteVectors() {
            if (!state.vectors.length) {
              roche.ui.toast("当前没有向量记忆。");
              return;
            }
            const ok = await roche.ui.confirm({
              title: "尝试删除向量记忆",
              message: `将尝试通过公开 memory.delete API 删除 ${state.vectors.length} 条向量记忆。如果当前 Roche 不支持，会自动跳过失败项。确定继续吗？`
            });
            if (!ok) return;

            setBusy(true);
            try {
              let done = 0, failed = 0;
              for (const v of state.vectors) {
                const id = getMemoryId(v);
                if (!id) { failed++; continue; }
                try {
                  await roche.memory.delete(id);
                  done++;
                } catch (_) {
                  failed++;
                }
              }
              roche.ui.toast(`向量删除尝试完成：成功 ${done}，失败 ${failed}。`);
              log(`向量删除尝试完成：成功 ${done}，失败 ${failed}。`);
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
            next.maxChars = Math.max(30, Math.min(120, num("#mtc-max-chars", next.maxChars)));
            next.preferredMin = Math.max(10, Math.min(80, num("#mtc-pref-min", next.preferredMin)));
            next.preferredMax = Math.max(next.preferredMin, Math.min(100, num("#mtc-pref-max", next.preferredMax)));
            next.keywordLimit = Math.max(0, Math.min(6, num("#mtc-keyword-limit", next.keywordLimit)));
            next.batchSize = Math.max(1, Math.min(20, num("#mtc-batch-size", next.batchSize)));
            next.longTermLimit = Math.max(50, Math.min(1000, num("#mtc-long-limit", next.longTermLimit)));
            next.writeKeywords = !!state.settings.writeKeywords;
            next.strictMode = !!state.settings.strictMode;
            next.autoApplyCompress = !!state.settings.autoApplyCompress;
            next.showCore = !!state.settings.showCore;
            next.showVectors = !!state.settings.showVectors;
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

          function render() {
            const s = stats();
            const disabled = state.busy ? "disabled" : "";
            const convOptions = state.conversations.map(c => {
              const id = c.id || c.conversationId || "";
              const name = c.name || c.title || c.handle || c.displayName || id || "未命名会话";
              const type = c.isGroup || c.type === "group" ? "群聊" : (c.source === "character" ? "角色" : "私聊");
              return `<option value="${escapeHtml(id)}" ${id === state.conversationId ? "selected" : ""}>${escapeHtml(name)}｜${type}</option>`;
            }).join("");

            const proposalCount = Array.from(state.proposals.values()).filter(p => p.action !== "KEEP").length;

            root.innerHTML = `
              <div class="mtc-top">
                <button id="mtc-back">返回</button>
                <div class="mtc-title">记忆低Token清理器</div>
              </div>

              <div class="mtc-card">
                <div class="mtc-row">
                  <select id="mtc-conversation">${convOptions || `<option value="">未读取会话</option>`}</select>
                  <button id="mtc-load-conv" ${disabled}>刷新会话</button>
                  <button id="mtc-load-memory" class="primary" ${disabled}>读取记忆</button>
                </div>
                <div class="mtc-row" style="margin-top:8px">
                  <input id="mtc-manual-conversation-id" placeholder="兼容模式：手动粘贴 conversationId" value="${escapeHtml(state.conversationId || "")}" style="flex:1; min-width:220px">
                  <button id="mtc-use-manual-conv" ${disabled}>使用这个ID</button>
                </div>
                <div class="mtc-muted" style="margin-top:8px">
                  Core Memory 只读不改。若某个 Roche 构建没有 conversation.list，插件会自动改用 character.list；仍失败时可手动填 conversationId。
                </div>
              </div>

              <div class="mtc-card">
                <div class="mtc-stats">
                  <div class="mtc-stat"><b>${state.facts.length}</b><span>事实记忆</span></div>
                  <div class="mtc-stat"><b>${state.vectors.length}</b><span>向量记忆</span></div>
                  <div class="mtc-stat"><b>${s.flagged}</b><span>疑似需处理</span></div>
                  <div class="mtc-stat"><b>${s.totalTokens}</b><span>事实估算token</span></div>
                </div>
              </div>

              <div class="mtc-card">
                <div class="mtc-row">
                  <button id="mtc-ai-review" class="primary" ${disabled}>AI审查疑似记忆</button>
                  <button id="mtc-quick-compress" ${disabled}>压缩过长/流水账</button>
                  <button id="mtc-apply" class="primary" ${disabled}>应用建议 ${proposalCount ? `(${proposalCount})` : ""}</button>
                  <button id="mtc-toggle-custom-instruction" class="success" ${disabled}>审查补充要求</button>
                  <button id="mtc-delete-selected" class="danger" ${disabled}>删除勾选</button>
                  <button id="mtc-scroll-top" ${disabled}>回到顶部</button>
                  <button id="mtc-scroll-bottom" ${disabled}>到底部</button>
                </div>
                <div id="mtc-custom-instruction-panel" class="mtc-custom-panel ${state.showCustomInstruction ? "" : "hidden"}">
                  <div style="font-weight:700; margin-bottom:8px">本次 AI 审查补充要求</div>
                  <textarea id="mtc-custom-instruction" placeholder="例：保留地点；注意时间顺序；只压缩不删除；保留未完成承诺。">${escapeHtml(state.customInstruction || "")}</textarea>
                  <div class="mtc-field-note">仅影响本次 AI 审查。</div>
                </div>
                <div class="mtc-muted" style="margin-top:8px">
                  建议：Roche“最新事实注入上限”设为 3～5；本插件负责把主事实记忆压短、去重、关键词化。
                </div>
              </div>

              <details class="mtc-card">
                <summary>设置</summary>
                <div class="mtc-settings-grid" style="margin-top:10px">
                  <label>单条最大中文字数</label><input id="mtc-max-chars" type="number" value="${state.settings.maxChars}">
                  <label>偏好最短字数</label><input id="mtc-pref-min" type="number" value="${state.settings.preferredMin}">
                  <label>偏好最长字数</label><input id="mtc-pref-max" type="number" value="${state.settings.preferredMax}">
                  <label>关键词数量上限</label><input id="mtc-keyword-limit" type="number" value="${state.settings.keywordLimit}">
                  <label>AI批量审查条数</label><input id="mtc-batch-size" type="number" value="${state.settings.batchSize}">
                  <label>读取长期记忆上限</label><input id="mtc-long-limit" type="number" value="${state.settings.longTermLimit}">
                </div>

                <details style="margin-top:12px">
                  <summary>高级开关</summary>

                  <div style="margin-top:8px">
                    ${renderSwitchRow("writeKeywords", "关键词写回主记忆", state.settings.writeKeywords)}
                    ${renderSwitchRow("strictMode", "严格低Token模式", state.settings.strictMode)}
                    ${renderSwitchRow("autoApplyCompress", "压缩建议可自动应用", state.settings.autoApplyCompress)}
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
                <div class="mtc-muted" style="margin-top:8px">如果 Roche 当前公开 API 不支持删除 vector，此按钮会显示失败数量，不会直接操作 IndexedDB。</div>
              </div>` : ""}

              <div class="mtc-card">
                <div class="mtc-row">
                  <button id="mtc-select-flagged" ${disabled}>勾选疑似</button>
                  <button id="mtc-clear-select" ${disabled}>取消勾选</button>
                  <span class="mtc-muted">已勾选 ${state.selected.size} 条</span>
                </div>
              </div>

              <div class="mtc-list">
                ${s.rows.map(r => renderFact(r)).join("") || `<div class="mtc-card mtc-muted">暂无事实记忆。请先读取会话记忆。</div>`}
              </div>

              <div class="mtc-card">
                <div class="mtc-log" id="mtc-log"></div>
              </div>
              <div class="mtc-bottom-spacer"></div>
            `;

            bindEvents();
          }

          function renderFact(r) {
            const p = state.proposals.get(r.id);
            const checked = state.selected.has(r.id) ? "checked" : "";
            const recClass = r.analysis.recommendation === "DELETE" ? "danger" : (r.analysis.recommendation === "COMPRESS" ? "warn" : "");
            const flags = r.analysis.flags.map(f => `<span class="mtc-badge warn">${escapeHtml(f)}</span>`).join("");
            const proposalHtml = p && p.action !== "KEEP" ? `
              <div class="mtc-proposal">
                <div class="mtc-badges">
                  <span class="mtc-badge ${p.action === "DELETE" ? "danger" : "warn"}">${escapeHtml(p.action)}</span>
                  ${p.keywords?.length ? `<span class="mtc-badge">${escapeHtml(p.keywords.join(" / "))}</span>` : ""}
                  ${p.reason ? `<span class="mtc-badge">${escapeHtml(p.reason)}</span>` : ""}
                </div>
                ${p.action === "COMPRESS" ? `<div class="mtc-text" style="margin-top:6px">${escapeHtml(finalMemoryText(p.newText, p.keywords, state.settings))}</div>` : ""}
              </div>
            ` : "";
            return `
              <div class="mtc-fact" data-id="${escapeHtml(r.id)}">
                <div class="mtc-fact-top">
                  <label class="mtc-row" style="gap:6px">
                    <input type="checkbox" class="mtc-check" data-id="${escapeHtml(r.id)}" ${checked}>
                    <span class="mtc-badge ${recClass}">${escapeHtml(r.analysis.recommendation)}</span>
                    <span class="mtc-badge">${r.analysis.len}字</span>
                    <span class="mtc-badge">~${r.analysis.tokenEstimate}tok</span>
                  </label>
                </div>
                <div class="mtc-badges">${flags}</div>
                <div class="mtc-text" style="margin-top:8px">${escapeHtml(r.text)}</div>
                ${proposalHtml}
              </div>
            `;
          }

          function bindEvents() {
            root.querySelector("#mtc-back")?.addEventListener("click", () => roche.ui.closeApp());
            root.querySelector("#mtc-load-conv")?.addEventListener("click", loadConversations);
            root.querySelector("#mtc-load-memory")?.addEventListener("click", loadMemory);
            root.querySelector("#mtc-use-manual-conv")?.addEventListener("click", () => {
              const manual = String(root.querySelector("#mtc-manual-conversation-id")?.value || "").trim();
              if (!manual) {
                roche.ui.toast("请先粘贴 conversationId。");
                return;
              }
              state.conversationId = manual;
              state.facts = [];
              state.vectors = [];
              state.core = null;
              state.proposals.clear();
              state.selected.clear();
              log("已切换到手动 conversationId。");
              render();
            });
            root.querySelector("#mtc-conversation")?.addEventListener("change", e => {
              state.conversationId = e.target.value;
              state.facts = [];
              state.vectors = [];
              state.core = null;
              state.proposals.clear();
              state.selected.clear();
              render();
            });
            root.querySelector("#mtc-custom-instruction")?.addEventListener("input", e => {
              state.customInstruction = e.target.value;
            });
            root.querySelectorAll(".mtc-switch-button").forEach(btn => {
              btn.addEventListener("click", () => {
                const key = btn.dataset.settingKey;
                if (!key || !(key in state.settings)) return;
                state.settings[key] = !state.settings[key];

                const value = !!state.settings[key];
                btn.classList.toggle("on", value);
                btn.setAttribute("aria-pressed", value ? "true" : "false");
                const pill = btn.querySelector(".mtc-switch-pill");
                if (pill) pill.textContent = value ? "开" : "关";
              });
            });
            root.querySelector("#mtc-ai-review")?.addEventListener("click", () => { state.reviewMode = "review"; reviewWithAi(); });
            root.querySelector("#mtc-quick-compress")?.addEventListener("click", quickCompressFlagged);
            root.querySelector("#mtc-apply")?.addEventListener("click", applyProposals);
            root.querySelector("#mtc-toggle-custom-instruction")?.addEventListener("click", () => {
              state.showCustomInstruction = !state.showCustomInstruction;
              const panel = root.querySelector("#mtc-custom-instruction-panel");
              if (panel) panel.classList.toggle("hidden", !state.showCustomInstruction);
              if (state.showCustomInstruction) {
                setTimeout(() => root.querySelector("#mtc-custom-instruction")?.focus?.(), 50);
              }
            });
            root.querySelector("#mtc-delete-selected")?.addEventListener("click", deleteSelected);
            root.querySelector("#mtc-scroll-top")?.addEventListener("click", () => root.scrollTo({ top: 0, behavior: "smooth" }));
            root.querySelector("#mtc-scroll-bottom")?.addEventListener("click", () => root.scrollTo({ top: root.scrollHeight, behavior: "smooth" }));
            root.querySelector("#mtc-save-settings")?.addEventListener("click", saveSettingsFromUi);
            root.querySelector("#mtc-restore-defaults")?.addEventListener("click", restoreDefaultSettings);
            root.querySelector("#mtc-delete-vectors")?.addEventListener("click", tryDeleteVectors);
            root.querySelector("#mtc-select-flagged")?.addEventListener("click", () => {
              currentFactsWithAnalysis().forEach(r => {
                if (r.analysis.flags.length || r.analysis.recommendation !== "KEEP") state.selected.add(r.id);
              });
              render();
            });
            root.querySelector("#mtc-clear-select")?.addEventListener("click", () => {
              state.selected.clear();
              render();
            });
            root.querySelectorAll(".mtc-check").forEach(cb => {
              cb.addEventListener("change", e => {
                const id = e.target.dataset.id;
                if (e.target.checked) state.selected.add(id);
                else state.selected.delete(id);
                render();
              });
            });
          }

          await loadConversations();
          if (state.conversationId) await loadMemory();
          render();

          container.__memoryTokenCleanerUnmount = () => {
            style.remove();
            container.style.overflow = previousContainerOverflow;
            container.style.height = previousContainerHeight;
            container.style.minHeight = previousContainerMinHeight;
            container.style.position = previousContainerPosition;
            container.style.touchAction = previousContainerTouchAction;
            container.style.webkitOverflowScrolling = previousContainerWebkitOverflowScrolling;
          };
        },
        async unmount(container, roche) {
          try {
            container.__memoryTokenCleanerUnmount?.();
          } catch (_) {}
          container.replaceChildren();
        }
      }
    ]
  });
})();
