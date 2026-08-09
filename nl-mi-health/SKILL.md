---
name: nl-mi-health
description: 同步、汇总和查询小米运动健康（Mi Fitness）云端数据。用户要首次全量同步、定时增量同步、查看同步状态、生成本周健康周报，或用自然语言查询近几天/几月/几年的睡眠、步数、心率和运动情况时使用；也用于通过可见浏览器重新授权。
---

# Mi Fitness 健康同步

使用随 Skill 提供的独立 Node.js 程序 `scripts/mi_fitness_health.mjs`。它内置小米账号授权捕获、请求签名、健康数据同步、SQLite 索引和报告功能，不导入、不执行也不要求安装 Mi-Fitness-Sync。默认把云端可访问的健康记录与运动摘要保存到 `~/.nl-mi-health/health-data`：原始变更写入 JSONL，最新记录写入 SQLite。

## 安装前提

- 用户电脑需要 **Node.js 22.13 或更高版本**，不需要 Python。
- 用户电脑需要 Google Chrome，供本人完成小米账号可见登录。
- 第一次使用，在 Skill 的 `scripts` 目录执行一次 `npm install`。唯一 npm 依赖是 Playwright；
```bash
cd <skill-dir>/scripts
npm install
```

`node:sqlite` 是 Node 内置模块；部分 Node 22 版本会显示 ExperimentalWarning，不影响本 CLI 使用。

## 安全边界

- 不要求用户粘贴密码、短信验证码、Cookie、`serviceToken`、`ssecurity` 或 `auth.json` 内容。
- 需要授权时，只运行可见的 `login`；让用户本人在 Chrome 页面完成密码、短信、验证码和安全确认。
- 不运行 `auth-status --json`，避免把授权字段输出到对话。
- 未经用户明确要求，不删除授权文件、SQLite 或 JSONL 数据。
- 把“完整数据”解释为当前账号、区域和小米云接口实际返回的健康记录与运动摘要；不要声称能恢复已删除或云端未返回的数据。

## 操作流程

脚本路径记为：

```bash
node <skill-dir>/scripts/mi_fitness_health.mjs
```

其中 `<skill-dir>` 是本 SKILL.md 所在目录。

### 1. 登录状态与自动登录

```bash
node <skill-dir>/scripts/mi_fitness_health.mjs auth-status
```

`sync`、`query`、`status`、`types`、`weekly-report` 和 `summary` 在执行前都会静默检查本地登录状态。若未登录，入口脚本会直接启动可见 Chrome 登录页，等待用户本人完成密码、短信、验证码和安全确认；成功写入授权后，自动继续原来的操作。不要要求用户复制 Cookie、令牌或验证码。

需要主动重新登录时，再运行：

```bash
node <skill-dir>/scripts/mi_fitness_health.mjs login
```

浏览器出现后暂停自动操作，等待用户完成页面登录。命令自行拦截登录响应、完成 STS 换票并保存最小必要授权。

### 2. 同步

默认同步所有云端可访问的健康记录和运动摘要：

```bash
node <skill-dir>/scripts/mi_fitness_health.mjs sync
```

首轮从 watermark 0 开始；后续复用 SQLite 中每个流的 watermark 增量更新。外部定时任务直接重复执行这个命令即可。

常用参数直接附在后面：

```bash
node <skill-dir>/scripts/mi_fitness_health.mjs sync
node <skill-dir>/scripts/mi_fitness_health.mjs sync --data-dir /path/to/data --page-size 20
node <skill-dir>/scripts/mi_fitness_health.mjs sync --country-code ID
```

未指定 `--country-code` 时，脚本会自动探测健康服务区域；只有自动探测不正确时，才显式传入国家代码。`--page-size` 默认 20，与小米健康接口的保守分页大小一致；不要盲目调大。

独立版以云端运动摘要和健康原始记录为同步边界；它不会下载或解析 FDS 二进制运动轨迹文件。不要把“完整数据”表述为包含小米接口未公开或未返回的二进制详情。

### 3. 周报与自然语言查询

所有汇总仅查询本地 SQLite，不会推送到第三方，也不会自动联网同步。默认以中国时间解释自然日期；除非用户明确要“先同步再看”，否则直接基于已同步数据回答，并说明数据最新时间与缺口。

生成最近 7 个完整自然日的周报：

```bash
node <skill-dir>/scripts/mi_fitness_health.mjs weekly-report
```

可指定结束时间或天数：

```bash
node <skill-dir>/scripts/mi_fitness_health.mjs weekly-report --end 2026-07-27 --days 7
```

对跨度较大的自然语言问题，使用 `summary` 聚合而非逐条 `query`。支持的指标为 `sleep`、`activity`、`steps`、`heart-rate` 和 `overview`；分组为 `day`、`week`、`month`、`year`。

```bash
# “查看最近几年的睡眠情况”
node <skill-dir>/scripts/mi_fitness_health.mjs summary --metric sleep --since 2022-01-01 --group-by year

# “最近几个月运动怎么样”
node <skill-dir>/scripts/mi_fitness_health.mjs summary --metric activity --since 2026-04-01 --group-by month

# “本月每天走了多少步”
node <skill-dir>/scripts/mi_fitness_health.mjs summary --metric steps --since 2026-07-01 --group-by day
```

把用户的相对时间转换为实际日期再执行。优先选择便于阅读的分组：几天用 `day`、几周用 `week`、几个月用 `month`、几年用 `year`。运动仅统计 `sport` 流，避免把同一运动的 `activity_detail` 重复计数。睡眠按云端返回的时长记录汇总，并将不少于 3 小时的记录显示为主睡眠，其余单列为短时睡眠；缺失数据要明确写作“无新数据”，不将其解释为健康结论。

### 4. 原始记录查询

先查看有哪些真实数据类型，不猜测账号中一定存在某类数据：

```bash
node <skill-dir>/scripts/mi_fitness_health.mjs types
```

再按准确类型查询：

```bash
node <skill-dir>/scripts/mi_fitness_health.mjs query --type huami_manual_heartrate_record --limit 20
node <skill-dir>/scripts/mi_fitness_health.mjs query --source sport --since 2026-07-01 --format json
```

时间支持 Unix 秒或 ISO-8601。需要程序消费时优先用 `--format json` 或 `--format jsonl`。

### 5. 状态

```bash
node <skill-dir>/scripts/mi_fitness_health.mjs status
```

汇报本地目录、记录数、时间范围、各数据流 watermark、上次同步时间和错误。若用户询问存储结构或数据含义，再读取 `references/data-layout.md`。

## 故障处理

- 缺少命令或 Playwright：确认 Node.js 版本至少为 22.13，然后在 `scripts` 目录运行 `npm install`。
- 浏览器无法启动：确认本机安装 Google Chrome；必要时传 `--browser-channel chromium`，但该通道还需要 Playwright 浏览器包。
- 授权 401：重新运行 `login`，不要让用户复制 Cookie。
- watermark 不推进：停止并报告接口响应异常，避免无限循环或擅自改写同步状态。
