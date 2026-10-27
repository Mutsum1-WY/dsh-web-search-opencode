# dsh-web-search-opencode

把 DeepSeek Harness 的网页搜索接到 **OpenCode Go** 订阅上的第三方 DSH 插件（组合包）。v1.1.0 起在 **10 个实测可用的 OpenCode Go 模型、3 种协议**之间自动兜底：内置 `web_search` 改由 OpenCode Go 执行，`web_fetch` 仍走内置 HTTP 抓取。适用于 DSH 0.2.x（验证于 0.2.1-rc.3 / profile `desktop`），许可 MIT。

## 这是什么
- 向 `ctx.web` 注册搜索提供方 **`opencode-go`**：每次搜索按候选链依次尝试模型，返回第一条真正带来源的结果（`WebSearchResult`：url / title / snippet / publishedAt，按 URL 去重）。
- 支持三种协议：**Anthropic Messages**（`{baseURL}/messages`，服务端工具 `web_search_20250305`）、**OpenAI Responses**（`{responsesBaseURL}/responses`，内置 `web_search` 工具）、**Google Gemini**（`{geminiBaseURL}/models/<id>:generateContent`，`google_search` + grounding）。协议归属在 `index.js` 里固定，配置只写模型 id。
- 组合包 patch 把内置 `web` 行的 `searchProvider` 指向 `opencode-go`（`fetchProvider` 保持 `http`），模型侧无需任何改动。

## 为什么必须独立插件
内置 `@deepseek-ai/dsh-web-search-deepseek`（`deepseek-official`）的请求头写死，没有自定义 header 的配置项；而 OpenCode Go 网关要求每个请求带稳定的 `x-opencode-session`，否则返回 `400 MissingSessionID`。所以只把内置搜索的 baseURL 改到 OpenCode 网关也不行——缺会话头照样被拒。只有独立实现提供方才能加这个头（本插件首次生成会话 ID 后持久化复用）。本包不 import 任何 `@deepseek-ai/*` 包、只用 Node 内置模块，DSH 升级时不需要改 peer 依赖。

## 支持的模型与协议

2026-10-26 实测能真正返回搜索来源的 10 个模型（表中顺序即默认候选链顺序；耗时/来源数来自单次实测，会随网络浮动）：

| 模型 | 协议 | 实测 |
| --- | --- | --- |
| `minimax-m3.1-flash` | Anthropic Messages | 2.8s / 10 条（默认主模型） |
| `minimax-m3` | Anthropic Messages | 3.3s / 10 条 |
| `claude-haiku-5-5` | Anthropic Messages | 6.5s / 9 条 |
| `deepseek-v4-pro` | Anthropic Messages | 10.2s / 10 条 |
| `minimax-m2.5` | Anthropic Messages | 11.9s / 10 条 |
| `minimax-m2.7` | Anthropic Messages | 18.7s / 9 条 |
| `kimi-k3` | Anthropic Messages | 25s / 11 条 |
| `kimi-k3.1-pro` | Anthropic Messages | 27s / 11 条 |
| `grok-4.7` | OpenAI Responses | 约 11s / 6 次搜索 |
| `gemini-4-argon` | Google Gemini | 约 27s；来源为 vertexaisearch 重定向链接 |

- 订阅不含某个模型时，该模型会报错并被自动跳过，链上其他模型照常兜底。
- `gemini-4-argon` 返回的来源 URL 是 `vertexaisearch` 重定向链接，点开才跳到真实页面，标题通常是域名——这是 Google grounding 的返回形态，不是抓取错误。
- 未纳入实测：`gpt-6-luna` / `gpt-5.6-luna` / `muse-spark-1.2` / `muse-spark-1.3` 在本地区域返回 403；`beam-free` 地区受限；`qwen3.x`、`deepseek-v4.1-flash` 不支持搜索（见下）。

### 为什么不默认用 deepseek-v4.1-flash

OpenCode Go 网关会把 `web_search` 工具静默丢掉：Anthropic Messages 和 OpenAI Responses 两种协议都试过，HTTP 200 但响应只有 thinking + text，没有任何搜索结果；`qwen3.x` 同样。所以默认主模型改用实测最快且能出结果的 `minimax-m3.1-flash`。想要 DeepSeek 模型可以用 `deepseek-v4-pro`（10.2s / 10 条），在配置里换 `model` 即可，兜底链会保留其余模型。

## 兜底机制
- 默认候选链 = `[model, ...其余 9 个按实测速度排序]`，共 10 个；配置 `models` 可给一条**完整自定义链（覆盖默认链，不是追加）**。
- 逐个尝试：HTTP 错误、协议不支持、HTTP 200 但没解析到来源，都算失败并自动换下一个；返回第一个有来源的结果。
- 全部失败才抛错，错误形如 `OpenCode web search failed for every candidate model (<模型列表>): <模型>: <原因> | ...`，逐个列出失败原因（单条与总长度有截断）。
- `fallback: false` 只试第一个：第一个直接报错时抛原始错误；若第一个 200 但无结果，抛上面那种聚合错误。
- `timeoutMs` 是整次搜索（含所有兜底尝试）的总预算：每次尝试使用剩余时间，剩余不足 500ms 时后续模型以 `no time left in timeoutMs` 跳过。agent 里外层还有工具超时 `tool-web.searchTimeoutMs`（base 层默认 60000），先到者生效。

## 包结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | 清单：`dsh.bundle.patch` 声明组合包 patch；`exports` 暴露入口/locale/icon；`files` 决定发布内容 |
| `cordis.patch.yml` | 组合包层：`insert` 宿主行 `web-search-opencode`，并覆盖内置 `web` 行 |
| `index.js` | 宿主半：注册 `opencode-go`；三种协议的请求与结果映射；候选链兜底；凭据与会话 ID |
| `locale/zh.json` / `locale/en.json` | 插件页显示用的标题与描述（`meta.title` / `meta.description`） |
| `icon.svg` | 插件页组合包卡片与详情图标 |
| `test/provider-smoke.mjs` | 不经过 DSH 的真实搜索自检（会依次验证默认链、OpenAI Responses、Gemini 协议） |
| `LICENSE` | MIT |

`test/` 不在 `package.json` 的 `files` 列表里：npm/压缩包安装的副本不含自检脚本，本地 `link:` 安装可直接用源码目录里的文件。

## 安装

前置：DSH 桌面端在运行（Web GUI 默认 <http://127.0.0.1:2350>）；本包零运行时依赖。

**方式一：Web 插件页（推荐）**

1. 左侧栏打开 **插件** 页。
2. 点 **添加插件** 右边的箭头 → **安装第三方插件**。
3. 输入本插件的 GitHub 仓库地址（`https://github.com/Mutsum1-WY/dsh-web-search-opencode`），或本地插件源码目录的绝对路径。
4. 点 **安装**。Host 先检查包名/版本/简介并确认含组合包 patch，再由 pnpm 以 `link:` 依赖装进 profile；**安装默认启用**。
5. 完成后 **已安装插件** 里出现 **OpenCode 网页搜索** 卡片；打开可见行 `web-search-opencode`、它覆盖的 `web` 行，以及「来源信息」（显示安装来源与版本，如 `github:<owner>/<repo>` 或 `link:<本地插件目录>`、版本 `1.1.0`）。
6. 若安装完成时提示需要重启（首次安装可能返回 `restart-required`，原因是 profile 解析目录变化，属 DSH 侧行为），关闭并重新打开 DSH 桌面端即可，重启后组合包才真正加载。

**方式二：CLI（等价写法）**

```powershell
dsh plugin --profile desktop add "<本地插件目录>"
```

`dsh plugin` 是 pnpm 转发器：在 profile 目录执行 `pnpm add`，成功后把声明了 `dsh.bundle` 的依赖自动追加进 profile `package.json` 的 `dsh.profile.bundles`。`--profile` 是启动器参数，必须写在 pnpm 参数之前；需要 `pnpm` 在 PATH 上。CLI 装完若插件页没变化，重启 DSH。

> 不要手工改 profile 的 `cordis.patch.yml` 去 `insert` 本插件行或改 `web.searchProvider`——那是旧挂载方式，现在由组合包层负责。profile patch 只用于后置配置覆盖。

## 开关（重要）

用 **组合包开关**（插件页 → 已安装插件 → 打开组合包 → 开关）：

- **关闭**：组合包从 `dsh.profile.bundles` 取消选择，它带来的整层 patch（insert + `web` 覆盖）一起消失；`web` 回落到 base 层配置 `searchProvider: deepseek-official`（内置 DeepSeek 搜索）、`fetchProvider: http`。依赖保留，不算卸载。
- **开启**：整层重新生效，`web_search` 重新由 OpenCode Go 执行。重新开启会把组合包追加到 `dsh.profile.bundles` 末尾；若同时使用其他覆盖 `web` 的组合包，注意先后优先级。

⚠️ **不要只关行 `web-search-opencode`**（组合包详情页里的行开关）。那样组合包仍启用、`web.searchProvider` 仍指向 `opencode-go`，但提供方没注册 → 每次 `web_search` 报 `WEB_PROVIDER_CONFIGURED_MISSING`（configured provider not registered）。行开关只用于调试。

⚠️ 装好后不要到 **设置 → 内置插件 → 网页搜索**（插件页官方分组的同一张配置卡）里点保存：它会把 `web` 的 volatile 字段写回 profile 的 `cordis.patch.yml`，形成比组合包更高的一层覆盖，把搜索切回 DeepSeek。要改搜索提供方，直接编辑 profile 的 `cordis.patch.yml`，或用插件页的组合包开关；误保存过就删掉其中的 `web` 覆盖条目。

旧版的 `config.enabled` 字段已移除，在行 config 里写它不会生效——开关只有上面两种。

## 配置字段

组合包层没有给本行写 config，默认值全部来自 `index.js`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `model` | `minimax-m3.1-flash` | 主模型（默认候选链的第一个） |
| `models` | 未设置 | 候选链数组，元素为模型 id 字符串或 `{ id, protocol }`；**覆盖**默认链，不是追加 |
| `fallback` | `true` | 模型失败时是否继续试下一个；`false` 只试第一个 |
| `baseURL` | `https://opencode.ai/inference/go/anthropic/v1` | Anthropic Messages 基址，插件拼 `/messages` |
| `responsesBaseURL` | `https://opencode.ai/inference/go/openai/v1` | OpenAI Responses 基址，插件拼 `/responses` |
| `geminiBaseURL` | `https://opencode.ai/inference/go/google/v1beta` | Google Gemini 基址，插件拼 `/models/<id>:generateContent` |
| `prompt` | `Perform a web search for the query: {query}` | 发给模型的提示词；必须含 `{query}` 占位，否则回退默认 |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | 凭据引用名，每次搜索经 DSH 凭据服务解析 |
| `apiKey` | 未设置 | 字面密钥；不推荐，优先用凭据服务 |
| `apiVersion` | `2023-06-01` | 仅 Anthropic 协议使用的 `anthropic-version` 头 |
| `maxTokens` | `4096` | 仅 Anthropic 协议的单次输出上限 |
| `maxUses` | `3` | 仅 Anthropic 协议的 `web_search` 最大调用次数 |
| `timeoutMs` | `120000` | **整次搜索（含所有兜底尝试）**的总预算，不是单模型上限 |
| `sessionId` | 自动生成并持久化 | `x-opencode-session` 的值；一般不用管 |

- `models` 里的表外模型 id 默认按 Anthropic 协议尝试；要指定协议用 `{ id: 'grok-4.7', protocol: 'responses' }`，`protocol` 取 `anthropic` / `responses` / `gemini`。
- `maxTokens` / `maxUses` / `apiVersion` 只对 Anthropic 协议生效，Responses / Gemini 请求体不带这些参数。
- `sessionId` 持久化在 `$DSH_HOME/opencode-web-search/session-id`（默认 `%USERPROFILE%\.dsh\opencode-web-search\session-id`）：首次生成 `dsh-websearch-<uuid>` 后复用，重启不丢；删掉它会在下次搜索时重新生成。
- 候选链为空不会发生；但 `maxTokens`/`maxUses`/`timeoutMs` 非正整数，或候选涉及的协议 baseURL 不可解析时，提供方 `available()` 为 false，搜索报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`。

覆盖默认值：在 **profile** 的 `cordis.patch.yml`（在所有组合包层之后应用）里按 id 覆盖本行 config：

```yaml
- id: web-search-opencode
  name: dsh-web-search-opencode
  config:
    model: deepseek-v4-pro
    models:
      - deepseek-v4-pro
      - minimax-m3.1-flash
```

patch 是整行 `config` 替换、不是深合并；没写的字段由 `index.js` 默认值补齐（不是从组合包层继承）。保存后 HMR 热应用，下一次搜索即生效，不需重装；没有 HMR 的 profile 需重启，改坏了删掉该覆盖条目即回默认。只想换主模型、保留 10 个兜底时只写 `model: deepseek-v4-pro` 即可（`models` 是完整链，写了就会覆盖默认）。

## 凭据与错误信息

插件每次搜索重新解析凭据：先问 DSH 凭据服务 `ctx.credentials.resolve(apiKeyEnv)`（凭据文件优先，其次启动环境、`.env`），取不到再读进程环境变量 `process.env[apiKeyEnv]`。保存 `OPENCODE_GO_API_KEY` 任选其一：① 在 DSH 设置里给使用该变量名的模型提供商保存密钥（本 profile 的 `llm-pi-ai` 里 `opencode-go` 也用它，同一把 key 两处复用）；② 直接编辑 `%USERPROFILE%\.dsh\.credentials.yaml` 的 `refs.OPENCODE_GO_API_KEY`，DSH 自动热重载；③ 启动 DSH 前设置环境变量（启动后再 export 无效）。

已保存的凭据值优先于启动环境变量；换 key 后下一次搜索即生效，不需重启。

常见错误原文：

- `OpenCode search has no API key for "OPENCODE_GO_API_KEY"; ...`（code `WEB_PROVIDER_CREDENTIAL_MISSING`）——凭据服务和环境都没有这个变量。
- `OpenCode API error (HTTP 401) for model <id>: ...`——key 无效/过期；若只是个别模型 401/403，通常是订阅不含该模型，会被兜底跳过。
- `OpenCode search credential resolution failed: ...`——凭据服务侧报错（文件格式、权限），看 DSH 日志。
- `OpenCode returned no web_search_tool_result blocks; this model did not run the web_search tool`——该模型没执行搜索（`deepseek-v4.1-flash` / `qwen3.x` 的典型表现），自动换下一个。
- `OpenCode Responses search returned no web search sources` / `OpenCode Gemini search returned no grounding metadata (web search did not run)` / `... no web grounding sources`——对应协议没搜到结果。
- `OpenCode search request failed for model <id>: ...`——网络/代理/DNS/超时；`OpenCode search aborted` 是调用方取消。

## 自检

不经过 DSH，直接真实跑一次搜索：

```powershell
cd <本地插件目录>
node test/provider-smoke.mjs "DeepSeek Harness 第三方插件"
```

脚本 `import` 本包的 `apply()` 并用 fake ctx 注册；断言恰好注册一个 id 为 `opencode-go` 的提供方、`available()` 为 true，再真实调用搜索，会依次验证默认候选链、OpenAI Responses 协议与 Gemini 协议，打印提供方 id、耗时、sources 数量与前 3 条 title/url，任一步失败以非 0 退出。用 DSH 自带的 node（v24+）即可。密钥来源先是 `OPENCODE_GO_API_KEY` 环境变量、再是 `%USERPROFILE%\.dsh\.credentials.yaml`，输出不含密钥原文；脚本会把 `DSH_HOME` 重定向到 `test/.tmp-home`，不污染真实会话文件。

2026-10-26 实测输出示例（退出码 0，整轮约 87~115s）：

```text
[PASS] constants            DEFAULT_MODEL=minimax-m3.1-flash chain=10
[PASS] default              model=minimax-m3.1-flash protocol=anthropic sources=23 15630ms
[PASS] responses            model=grok-4.7 protocol=responses sources=25 19932ms
[PASS] gemini               model=gemini-4-argon protocol=gemini sources=7 27060ms
[PASS] fallback             deepseek-v4.1-flash(200,no results) -> minimax-m3.1-flash sources=25 24205ms
[PASS] cancel               code=WEB_ABORTED
```

## 更新、卸载与发布

- **更新**：如果是 `link:` 安装，改插件源码目录里的代码后重启 DSH 即加载新代码；也可在插件页移除再装一次。组合包详情页「来源信息」显示当前来源与版本（本包 1.1.0）。
- **卸载**：插件页 → 已安装插件 → 打开组合包 → 卸载（会要求确认）。卸载会取消选择、卸载运行时贡献并 `pnpm remove`，之后搜索回内置 DeepSeek。不要手工删 `node_modules` 或 patch 行，容易留下「已选但未装」的坏状态。
- **发布成可分享插件（可选）**：① 去掉 `package.json` 的 `"private": true`（`npm publish` 需要；`npm pack` 本身可用）；② `npm pack` 生成 tarball 供安装对话框选择，或推 GitHub 用 `github:user/repo` / `git+https://...` 安装，或发布到 npm 后填包名（先确认包名可用或改用 scope）；③ 发布内容由 `files` 决定，已含入口/patch/locale/icon/README/LICENSE，不含 `test/`；④ 使用者需要自己的 `OPENCODE_GO_API_KEY`，且所用模型要在其 Go 订阅里可用（不支持会被自动跳过）。

## 排障

| 现象 / 错误原文 | 原因 | 处理 |
| --- | --- | --- |
| `400 MissingSessionID` | 请求缺 `x-opencode-session`：走了别的出口（如内置 DeepSeek 搜索的 baseURL 被指向 OpenCode 网关），或持久化的会话 ID 被改坏 | 确认没有后置 patch 把 `web.searchProvider` 改回 `deepseek-official`；删除 `session-id` 文件（下次搜索会重新生成，必要时重启 DSH）；不要只关行，用组合包开关 |
| `401` / `authentication_error` | key 无效、过期或无该模型权限 | 重存 `OPENCODE_GO_API_KEY`，见「凭据」；个别模型 403 会被兜底跳过 |
| `WEB_PROVIDER_CONFIGURED_MISSING` / configured provider not registered | 只关了行，或本插件没装/没启用 | 用组合包开关整包切换；到已安装插件确认已启用 |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | 候选链为空（不会发生）、`maxTokens`/`maxUses`/`timeoutMs` 非正整数，或候选协议对应的 baseURL 不可解析 | 检查覆盖的 config 类型与三个 baseURL（是否正确 URL）；删掉覆盖条目回默认 |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | 没有密钥，或 `apiKeyEnv` 被覆盖成别的名字 | 见「凭据」；检查覆盖值是否拼错 |
| `OpenCode web search failed for every candidate model (...)` | 所有候选都失败；冒号后按 `<模型>: <原因>` 逐个列出原因 | 按原因处理：401→key；`no ... blocks/sources/grounding`→该模型不支持搜索；403→区域/订阅限制；换 `model`/`models` 或调大 `timeoutMs` |
| `no time left in timeoutMs` | `timeoutMs` 总预算耗尽，后面的模型没来得及试 | 调大 `timeoutMs`，或缩短 `models` 链、或设 `fallback: false` 只试主力模型 |
| gemini 来源是 `vertexaisearch` 重定向链接、标题是域名 | Google grounding 的正常返回形态 | 正常现象，点开会跳到真实页面；需要干净 URL 时对来源自行再抓取 |
| `deepseek-v4.1-flash` / `qwen3.x` 返回 200 但无来源 | 网关静默丢弃 `web_search` 工具，塞进链里会浪费一次尝试 | 默认链不含它们；别只用它们，保留其它兜底模型或用 `deepseek-v4-pro` |
| 其他 `400` / `invalid_request_error` / 重定向 | 模型名不被订阅支持、baseURL 多写了操作路径、网关重定向 | 用默认模型与默认 baseURL（Anthropic 写到 `/v1`、Responses 写到 `/v1`、Gemini 写到 `/v1beta`，具体端点插件自己拼） |
| 搜索明显变慢 | 兜底会依次尝试失败/无来源的模型，耗时累加 | 缩短 `models` 链、调大 `timeoutMs`；注意外层 `tool-web.searchTimeoutMs`（默认 60s）会整体取消 |
| 关掉组合包后搜索报 401 | 已回落到内置 DeepSeek 搜索，它需要有效的 `DEEPSEEK_API_KEY`/账号 | 配好 DeepSeek 凭据，或重新开启本组合包 |
| 插件页看不到卡片 / 不生效 | 组合包未启用、安装被拒，或只改了文件没重启 | 看组合包详情页诊断；重新安装/启用；link 安装的代码改动重启 DSH |

## 来源与许可

- 本项目自研（2026-10-26，v1.1.0 加入多模型/多协议兜底，替代 v1.0 的单模型 Anthropic 实现）；协议形状参考内置 `dsh-web-search-deepseek` 的 Anthropic Messages + 原生 `web_search` 做法，但代码独立、不 import 任何 `@deepseek-ai/*` 包。
- 模型表里的可用性、协议归属与耗时为 2026-10-26 实测结论，不是 OpenCode Go 的长期承诺；上游变则重测。
- 许可：MIT，见 `LICENSE`。
- 旧方案（本地代理 / patch 手工挂载）已归档，与本包不要混用。
- 关闭本包后搜索回内置 `deepseek-official`；它缺少有效 DeepSeek 凭据时会报 `WEB_PROVIDER_CREDENTIAL_MISSING`（key 无效时也可能直接看到上游 `401`，两者是同一类问题的不同表现）。

## 维护者说明

- `test/` 刻意不进 `package.json` 的 `files`：发布包保持精简；本地 `link:` 安装不受 `files` 影响，自检脚本照常可用。
- 当前清单未声明 `repository` / `author`：本包目前作为独立第三方插件使用；若要发布到 npm 或 GitHub，再补这两个字段即可。
- **不要**加 `engines.dsh` 或任何 `@deepseek-ai/*` 的 peerDependencies：会触发 DSH 版本兼容检查，版本范围不匹配时插件管理器会直接拒绝安装；本包零依赖正是为了避开这一点。
- 模型可用性、协议归属与耗时为 2026-10-26 实测结论；OpenCode Go 的模型清单或端点变化后直接改 `SEARCH_MODELS` 重装即可（`test/provider-smoke.mjs` 会跑真实搜索验证）。
