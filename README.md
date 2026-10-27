# dsh-route-clone（路由克隆 / Route Clone）

在 DSH 里给同一个模型提供商配两把（或多把）API Key：把某个预设 provider 的**路由配置**（端点、协议、模型清单、容量与兼容开关）复制成一个独立命名、独立凭据的路由组，再用 `/model` 或输入框的模型菜单在两者之间切换。

这里复制的是 DSH 的 provider **路由**，不是 pi-ai 目录里的 provider 预设。pi-ai 目录按 provider id 索引，新 id 不会成为目录成员，因此界面上仍会把克隆标成 `Custom`——这是它“声明出来的路由”这一事实的标记，不是配置失败。

## 安装

从 GitHub 安装到某个 profile（把 `web` 换成你的 profile 名）：

```sh
dsh plugin --profile web add https://github.com/kabarryo/dsh-route-clone.git
```

本地开发也可以直接链接目录：

```sh
dsh plugin --profile web add /path/to/dsh-route-clone
```

没有构建步骤。Host 半的源码改动需要重启宿主（桌面 App 或 web 实例）才会加载；客户端刷新页面即可。

## 它做什么

DSH 用 `provider/model` 寻址模型，每个 `provider` 是一条路由，路由通过 `apiKeyEnv` 指向一份凭据。同一上游两把 key = 两条（或多条）指向同一上游的路由，各带自己的凭据引用：

- 原路由：`opencode-go` → `OPENCODE_GO_API_KEY`
- 克隆路由：`opencode-go-2` → `OPENCODE_GO_2_API_KEY`

一条手工路由只能有一种协议，而 `opencode-go` 的目录里同时有 `openai-completions`、`openai-responses`、`anthropic-messages` 三种模型。插件按你勾选的模型**按协议拆成多条路由**：主协议沿用克隆 id，其余加后缀（如 `opencode-go-2-anthropic`），整组共用同一个凭据引用，所以只需填一次 key。

## 使用

1. 安装本插件到当前 profile 并启用。
2. 打开 **设置 → 模型**，滚动到列表底部，看到 **路由克隆** 面板。
3. 选择来源预设（初始显示“请选择供应商预设”，不预选）；选定后面板才读出该预设的目录模型，默认全部不勾选，按需选择，可搜索。
4. 名称会按“来源名-副本N”自动生成（同一来源的已有副本自动增长），可手动改，点 **创建克隆**。
5. 页面出现一条或多条提供商行（如 `opencode-go-2`、`opencode-go-2-anthropic`）。在任意一条的 **API 密钥** 里粘贴 key——同组引用相同，填一次即可。
6. 在输入框的模型菜单或 `/model` 里选择对应分组切换。

面板里可以随时删除克隆组：删除会移除该组全部路由定义，但**不会**删除已经存进凭据库的 Key。

## 实现要点

- **Host 半**（`index.js`）：读取本插件自己的配置
  ```yaml
  clones:
    opencode-go-2:
      source: opencode-go
      displayName: OpenCode Go（备用）
      models: [deepseek-v4.1-flash, minimax-m3]
  ```
  从已安装的 pi-ai 目录取出所选模型的协议、端点、容量、推理等级与 `compat`，按协议分组，生成完整的 `llm-pi-ai` 路由并写入设置文档。`models` 为空时沿用旧行为：来源路由已配置模型就按那份清单，否则复制整个目录。
- **Client 半**（`client.js`）：在 `settings.models.footer` 席位渲染面板；模型清单来自 `llm.discoverModels`（目录路由直接由目录回答，不发网络请求），写配置走 `settings` Remote，不引入额外 RPC。
- **OpenCode 会话头**：`opencode.ai` 的网关从 2026-09 起要求 `x-opencode-session` 头。目录路由由 pi-ai 的 provider 包装自动附加，手工声明的克隆不会，因此插件在 Host 侧给发往 `opencode.ai` 的请求补上该头（值复用请求自带的会话 id）。不涉及其他提供商。

## 限制

- 只能克隆 pi-ai 目录里的提供商；`openai-completions`、`openai-responses`、`anthropic-messages` 之外的协议（Bedrock SigV4、Vertex ADC 等）无法用 api-key 路由表达，会被跳过并记日志。
- 克隆是所选模型的一份**快照**：之后原提供商新增模型不会自动同步；重新创建即可。
- 目录 provider 工厂本身不会被复制：provider 级 auth 方式、动态请求头等目录私有行为不在配置里。`opencode-go` 的会话头已由插件补上；其他带私有包装的 provider（如 GitHub Copilot）不保证等价。
- 插件重启/重载时不会覆盖已经存在的克隆路由，以免抹掉你在模型页做过的修改；只有配置发生变化时才重新生成。

## 排错

克隆创建后没有出现新的提供商行时，看 `~/.dsh/logs/route-clone.log`。插件把每次 reconcile、每条路由的生成结果和写入失败原因追加在那里。

一个曾经的坑：设置页的写入在 `hmr.runExclusive()` 事务里执行，`loader/volatile-update` 也是从事务中间发出的；在监听器里同步写另一个 namespace 会触发 "HMR transactions cannot be nested"。插件因此把写入放到启动时创建的中断泵里执行，监听器只留一个待办标记。

## 开发

- 本插件没有构建步骤，`index.js` 与 `client.js` 都是纯 ESM。宿主侧**不写死** bare import：本地以链接方式安装时，Node 会按插件的真实路径解析依赖，因此 schemastery 与 pi-ai 目录在运行时从 profile 的 `node_modules` 定位。
- 安装后可通过 `plugin_manager` / 设置页插件列表确认；浏览器半若未出现，先确认 `@deepseek-ai/dsh-client-ui-settings-models` 已启用（面板依赖它声明的 `settings.models.footer` 席位）。

## License

MIT
