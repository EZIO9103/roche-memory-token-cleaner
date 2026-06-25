# 记忆低Token清理器 / memory-token-cleaner

这是一个 Roche 插件，用于清理、压缩并关键词化 Roche 的事实记忆，目标是减少 AI 请求时长期记忆注入造成的 token 浪费。

## 功能

- 选择会话
- 读取 Core / Facts / Vectors
- Core Memory 只读，不修改
- 本地标记过长、流水账、多事件、低价值事实记忆
- 调用 Roche 当前 AI 配置审查事实记忆
- 将事实记忆压缩为 30–50 中文字、最多 70 字的第三人称日记句
- 可将 2–3 个关键词写回主事实记忆，辅助 Roche 原生检索
- 支持删除低价值事实记忆
- 尝试通过公开 API 删除向量记忆
- 使用 roche.storage 保存插件设置

## 安装

1. 把 `manifest.json` 和 `plugin.js` 上传到 GitHub 仓库根目录。
2. 修改 `manifest.json` 里的 `entry`，改成你自己的 `plugin.js` Raw 链接。
3. 在 Roche 插件安装处填写 `manifest.json` 的 Raw 链接。

示例：

```txt
https://raw.githubusercontent.com/你的用户名/你的仓库/main/manifest.json
```

不要填写 GitHub 页面链接。

## 建议 Roche 设置

- 最新事实注入上限：3～5
- 短期消息数量：10～20
- 向量召回：0～3
- 生活轨迹：关闭
- Core Memory：保留关系现状、边界、伏笔，不写人设

## 风险

此插件会通过 Roche 公开 API 修改或删除 Roche 主事实记忆。删除的记忆不会因为卸载插件自动恢复。建议先导出备份。
