# 本地数据布局

默认根目录为 `~/.nl-mi-health/health-data`。

| 路径 | 内容 |
|---|---|
| `health.sqlite3` | 最新记录索引、每个同步流的 watermark、稳定 `phone_id` |
| `raw/sport.jsonl` | 运动摘要的追加式原始变更日志 |
| `raw/fitness.jsonl` | 日常健康记录的追加式原始变更日志 |
| `raw/activity_detail.jsonl` | 已解析的运动详情变更日志 |
| `fds/*.bin` | 云端仍可下载的运动采样、报告、GPS 与恢复率二进制缓存 |

SQLite 的 `records` 表按 `(source, record_id)` 保留最新版本。JSONL 只在记录首次出现或内容变化时追加，适合审计和重新处理。

数据源：

- `sport`：运动摘要。
- `fitness`：日常健康数据。准确类型来自记录的 `key` 字段。
- `activity_detail`：运动详情及解析后的采样、轨迹等。

常见 `fitness` 类型包括心率、压力、血氧、PAI、静息心率、训练负荷等；以 `health-types` 在当前账号中实际列出的类型为准。小米云端不返回的记录、已删除对象或过期 FDS 文件不在可同步范围内。

授权文件位于 `~/.nl-mi-health/auth/auth.json`，应保持仅当前用户可读写，不应复制进项目、日志或对话。
