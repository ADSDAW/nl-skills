# NL Skills

一组可按需加载的 AI Agent Skills，为常见任务提供清晰、可执行的工作流程。

[English](README.en.md)

## 当前 Skills

### [`nl-mi-health`](skills/nl-mi-health/)

面向小米运动健康（Mi Fitness）的个人健康数据助手。它可以在本人完成授权后同步数据、查看同步状态、生成健康周报，并回答关于睡眠、步数、心率和运动的自然语言问题。

使用说明：[`SKILL.md`](skills/nl-mi-health/SKILL.md)

## 安装

| 方式 | 适合场景 |
| --- | --- |
| 让 Agent 安装 | 你正在使用支持 Skills 的 Agent，想直接用自然语言完成安装。 |
| `skills` CLI | 希望用一条命令安装或选择特定 Skill。 |
| Clone 后复制 | 希望自行放入项目或 Agent 的 Skills 目录。 |

### 1. 让 Agent 安装

把下面这句话发送给你的 Agent：

> 帮我安装 [https://github.com/qlql489/nl-skills/tree/main/skills/nl-mi-health](https://github.com/qlql489/nl-skills/tree/main/skills/nl-mi-health) 这个 Skill。

若该 Agent 支持从 GitHub Skill 链接安装，它会下载并放入自身可发现的目录；否则可使用下面两种方式。

### 2. 使用 `skills` CLI

安装仓库中的所有 Skills：

```bash
npx skills add qlql489/nl-skills
```

只安装 `nl-mi-health`：

```bash
npx skills add qlql489/nl-skills --skill nl-mi-health
```

也可以先列出仓库中的 Skills，或指定目标 Agent：

```bash
npx skills add qlql489/nl-skills --list
npx skills add qlql489/nl-skills --skill nl-mi-health --agent codex
```

### 3. Clone 后复制

```bash
git clone https://github.com/qlql489/nl-skills.git
mkdir -p your-project/.agents/skills/nl-mi-health
cp -R nl-skills/skills/nl-mi-health/. your-project/.agents/skills/nl-mi-health/
```

常见项目级目录：

| Agent | 目录 |
| --- | --- |
| Claude Code | `.claude/skills/<skill-name>/` |
| Codex（`skills` CLI） | `.agents/skills/<skill-name>/` |
| Cursor / 通用 Agent | `.agents/skills/<skill-name>/` |

复制完成后，重新开启 Agent 会话或让它重新扫描项目即可发现该 Skill。

## 使用

安装后，在需求前加上 `/nl-mi-health`，例如：

- `/nl-mi-health 同步我的小米运动健康数据。`
- `/nl-mi-health 生成最近一周的健康周报。`
- `/nl-mi-health 我这几个月的睡眠怎么样？`
- `/nl-mi-health 本月每天走了多少步？`

首次使用时，Skill 会检查运行环境并安装随附依赖；若尚未完成授权，会打开可见浏览器，由你本人完成登录与安全确认。之后再提出同步或查询需求即可。
