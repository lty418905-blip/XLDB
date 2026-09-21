# XLDB Windows x64 安装

这份说明面向收到 XLDB ZIP 的 Agent 或 Windows 用户。安装脚本只在解压目录及指定的私有目录中写文件，不安装全局 npm 包，不安装 Python，也不要求填写模型 API。

## 解压并选择模式

把 ZIP 解压到最终安装目录后再运行 setup。目录可以包含空格或中文；不要在临时解压目录安装后再移动。

```powershell
$zip = 'D:\Downloads\xldb.zip'
$target = 'D:\XLDB-installed\当前版本'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath $target
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$target\tools\setup.ps1" -Mode Agent
```

`Agent` 模式安装并实际运行一次无模型的 CLI 小检查。上述执行策略仅用于本次安装进程，不修改系统策略。它不会启动 HTTP 服务，也不会索取或保存聊天模型 API。Agent 数据默认留在安装根的 `.local/agent/`。

**安装成功后，Agent 必须主动引导一次检索配置选择：**说明本地 BM25 可直接使用，embedding 提供语义向量检索，reranker 对候选重新排序，询问用户现在配置两项、只配置其中一项，还是暂时跳过。按 [Agent 检索配置引导](docs/AGENT.md#检索配置引导) 执行；已有明确选择或有效配置时复用，不反复询问。用户跳过不影响安装成功；未配置不能声称已启用向量检索。这里配置的是检索服务，文本推理继续使用宿主独立子代理。

主 ZIP 的首次 Tavern 路径是运行 `START-XLDB.cmd`。它调用 `setup.ps1 -Mode Tavern -OpenTavern`，由本机安装脚本生成一次性 `PairingCode`，启动核心后再把临时配对信息交给已加载的酒馆转接 JS。下面的显式参数形式用于宿主自动化或诊断；`PairingCode` 是 64 位十六进制临时秘密，不要写入日志或聊天记录。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$target\tools\setup.ps1" `
  -Mode Tavern `
  -PrivateDirectory 'D:\XLDB-installed-private' `
  -Port 4318 `
  -PairingCode $pairingCode `
  -TavernOrigin 'http://127.0.0.1:8000'
```

`OpenTavern` 会生成随机配对码、启动核心并打开 `http://localhost:8000`；配对信息只放在浏览器 fragment 中，转接 JS 读取并立即清除 fragment 后完成一次性配对。可用 `-TavernOrigin` 指定酒馆地址。没有 `OpenTavern` 时，脚本不会打开浏览器或其它可见窗口。

未显式指定 `PrivateDirectory` 时，默认使用安装根同级的 `<安装目录名>-private`。例如安装根是 `D:\XLDB`，默认私有目录是 `D:\XLDB-private`。已有配置、数据库和 token 不会被覆盖；升级到新版本目录也不会自动迁移或切换旧数据，宿主必须显式传入要继续使用的私有目录。

Tavern 模式只监听 `127.0.0.1`。`TavernOrigin` 会自动加入允许列表。需要额外来源时可传 `-AllowedOrigins 'http://127.0.0.1:8000','http://localhost:8000'`。启动脚本把一次性配对记录以无 BOM UTF-8 原子写入私有目录，配对记录十分钟过期；脚本输出和 receipt 不包含配对码、其哈希或本地 token。

## Node.js 与本地依赖

脚本复用已存在的 Windows x64 Node.js `24.x`，最低版本为 `24.18.1`。没有兼容版本时，它只从 `nodejs.org` 下载固定的 `node-v24.18.1-win-x64.zip`，并按同目录官方 `SHASUMS256.txt` 核对 SHA-256 后解压到 `<安装根>/.local/node/`。

npm 只安装固定的 LanceDB `0.39.0`、Windows x64 原生包、TypeScript `5.9.3` 和对应 Node 类型。npm cache、下载临时文件与运行依赖都位于 `<安装根>/.local/`。成功 receipt 与实际运行检查都仍有效时，重复 setup 会跳过 npm，不会每次联网重装。

npm 单次网络请求最多等待 30 秒并重试一次，失败保留本地缓存和错误日志，排除网络问题后重跑 setup 即可。初次下载仍需要能访问官方 Node 与 npm 服务；缓存恢复不能作为冷网络安装通过的证据。

## 再次启动与停止

```powershell
& "$target\tools\start.ps1" -PrivateDirectory 'D:\XLDB-installed-private' -Port 4318
& "$target\tools\stop.ps1"
```

`start.ps1` 只复用 receipt 能证明属于同一安装根、相同端口和相同目录的健康进程。未知进程占用端口时会失败，不会把它当成 XLDB。`stop.ps1` 会再次核对 PID、Node 路径和核心入口；证据不匹配时不会终止进程。真实启动使用隐藏窗口，日志位于 `<安装根>/.local/logs/server/`。

## Agent Skill 边界

ZIP 内的 `.agents/skills/xldb-agent/SKILL.md` 是项目级宿主说明。能发现项目 Skill、并支持 fresh-context 原生子代理的 Agent 可按它调度 XLDB 后台模型任务；不同 Agent 宿主如何发现项目 Skill 由宿主决定，setup 不会修改全局 Codex 配置。

安装完成只证明固定依赖、LanceDB 原生模块及 Agent CLI 的无模型路径可运行。它不证明当前宿主能创建隔离的原生子代理，也不代表真实模型质量、真实 SillyTavern 配对或长期体验已经通过。没有 fresh-context 子代理能力的宿主必须报告不支持，不能把本地 CLI 小检查当成真实 Agent 能力验收。
