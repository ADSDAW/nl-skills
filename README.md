# NL Skills

面向中文用户的实用 AI Agent Skills 集合。每个 Skill 都是可按需加载的独立能力包：以 `SKILL.md` 说明何时使用与如何执行，必要时附带可验证的脚本和参考资料。

[English](README.en.md)

## 当前收录

| Skill | 适用场景 | 状态 |
| --- | --- | --- |
| [`nl-mi-health`](nl-mi-health/SKILL.md) | 同步、汇总、查询小米运动健康（Mi Fitness）云端可访问的健康记录与运动摘要；生成周报；重新进行可见网页登录授权。 | 可用 |

### `nl-mi-health`

小米运动健康数据的本地优先工具。它提供一个独立的 Node.js CLI，用于：

- 首次全量同步，以及基于 watermark 的后续增量同步；
- 将原始变更保存为 JSONL，并在本地 SQLite 中维护最新记录索引；
- 查询当前账号中真实存在的数据类型，以及指定时间范围的原始记录；
- 按天、周、月或年汇总睡眠、步数、心率与运动数据，或生成最近完整自然日的周报；
- 在可见 Chrome 窗口中由本人完成小米账号登录或重新授权。

它不会要求你提供密码、短信验证码、Cookie 或 Token，也不会把本地汇总数据推送到第三方。

## 快速开始

### 1. 安装 Skill

克隆仓库后，将所需 Skill 文件夹复制到你的 Agent 会扫描的目录。例如，Codex 项目级安装：

```bash
git clone https://github.com/qlql489/nl-skills.git
cp -R nl-skills/nl-mi-health your-project/.codex/skills/
```

常见目录还包括：

| Agent | 项目级目录 |
| --- | --- |
| Claude Code | `.claude/skills/<skill-name>/` |
| Codex | `.codex/skills/<skill-name>/` |
| Cursor / 通用 Agent | `.agents/skills/<skill-name>/` |

### 2. 安装运行依赖

`nl-mi-health` 需要 Node.js 22.13 或更高版本，以及 Google Chrome。首次使用时，在 Skill 自带脚本目录安装唯一的 npm 依赖：

```bash
cd your-project/.codex/skills/nl-mi-health/scripts
npm install
```

### 3. 让 Agent 使用它

安装后，直接用自然语言提出需求，例如：

- “同步我的小米运动健康数据。”
- “生成最近一周的健康周报。”
- “查看从 2022 年开始每年的睡眠情况。”
- “本月每天走了多少步？”

Agent 会根据 Skill 的安全流程完成本地检查、授权或查询。首次登录时，浏览器会打开小米登录页；请自行完成密码、验证码和安全确认。

## 常用命令

以下示例假设当前目录为 `nl-mi-health/scripts`：

```bash
# 检查本地授权状态（不会显示授权字段）
node mi_fitness_health.mjs auth-status

# 在可见 Chrome 中重新授权
node mi_fitness_health.mjs login

# 首次全量同步；之后同一命令执行增量同步
node mi_fitness_health.mjs sync

# 查看本地同步状态和数据范围
node mi_fitness_health.mjs status

# 列出当前账号实际包含的数据类型
node mi_fitness_health.mjs types

# 生成最近 7 个完整自然日的周报
node mi_fitness_health.mjs weekly-report

# 按年汇总睡眠数据
node mi_fitness_health.mjs summary --metric sleep --since 2022-01-01 --group-by year
```

完整参数与故障处理请查看 [`nl-mi-health/SKILL.md`](nl-mi-health/SKILL.md)。

## 数据与隐私

- 默认数据目录为 `~/.nl-mi-health/health-data`；授权状态单独保存在 `~/.nl-mi-health/auth/`。
- 健康记录与运动摘要默认只落在本机：原始变更为 JSONL，最新记录索引为 SQLite。
- “完整同步”仅指小米云接口对当前账号、区域实际返回的记录与摘要；不包含云端不返回、已删除或未公开的内容。
- 不要将 `auth.json`、Cookie、Token、SQLite 数据库或原始 JSONL 提交到仓库、上传到公开位置，或粘贴到对话中。

## 仓库结构

```text
nl-skills/
└── nl-mi-health/
    ├── SKILL.md                 # Agent 使用说明与安全边界
    ├── scripts/
    │   └── mi_fitness_health.mjs # 独立 Node.js CLI
    └── references/
        └── data-layout.md       # 本地数据布局说明
```

## 贡献

欢迎通过 Issue 或 Pull Request 提交 Bug 修复、新 Skill 或文档改进。新增 Skill 请保持目录自包含，提供清晰的 `SKILL.md` 触发说明，并避免把凭据、个人数据或机器特定路径写入仓库。
