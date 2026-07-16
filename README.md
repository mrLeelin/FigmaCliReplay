# LKS Figma MCP Relay

## 鏋舵瀯瀹氫綅

Figma 鎻掍欢涓嶈兘鍦ㄦ彃浠舵矙绠遍噷鐩戝惉 MCP 绔彛锛屾墍浠ユ湰椤圭洰浣跨敤鏈湴 Node Gateway 浣滀负 AI 鍙繛鎺ョ殑 MCP 鍏ュ彛锛?
```text
AI / MCP Host
  -> http://127.0.0.1:32130/mcp
  -> Node Gateway (TypeScript + official MCP SDK Streamable HTTP)
  -> WebSocket preferred / polling fallback
  -> Figma Plugin UI
  -> Figma Plugin API
```

Node/TypeScript Gateway 鏄粯璁?MCP 鍏ュ彛銆侾ython 鍙繚鐣欎负 legacy 涓氬姟鍚庣锛岀敤浜?Prefab 瀵煎叆銆佷節瀹垏鍥剧瓑鏃у崗璁兘鍔涖€?
## 鍚屼簨棣栨浣跨敤

1. 瀹夎 Node.js 18+锛屾帹鑽?Node.js 22 LTS銆?2. 鍦?Figma Desktop 瀵煎叆寮€鍙戞彃浠讹細

```text
Plugins > Development > Import plugin from manifest...
<relay-root>/manifest.json
```

3. 鍙屽嚮鍚姩涓€閿叆鍙ｏ細

```bat
"<relay-root>\鍚姩MCP.bat"
```

杩欎釜鍏ュ彛浼氳嚜鍔ㄦ鏌?Node.js銆佸畨瑁呬緷璧栥€佹瀯寤?Gateway銆佸鐢ㄥ凡鍚姩鐨勬湰鍦版湇鍔★紝骞舵樉绀?Figma 鎻掍欢鍜?AI MCP 鍦板潃銆?
闇€瑕佹墦寮€璇︾粏鏃ュ織绐楀彛鏃剁敤锛?
```bat
"<relay-root>\start_mcp.bat"
```

闇€瑕佸悓鏃舵墦寮€ Figma Desktop 鏃剁敤锛?
```bat
"<relay-root>\打开Figma并启动MCP.bat"
```

4. 棣栨鎺ュ叆 AI 瀹㈡埛绔椂锛屾寜闇€鍐欏叆 MCP 閰嶇疆銆侰odex 浣跨敤锛?
```powershell
PowerShell -ExecutionPolicy Bypass -File "<relay-root>\scripts\start_mcp_oneclick.ps1" -SetupClient codex
```

Claude Code 浣跨敤锛?
```powershell
PowerShell -ExecutionPolicy Bypass -File "<relay-root>\scripts\start_mcp_oneclick.ps1" -SetupClient claude
```

涔熷彲浠ュ悓鏃堕厤缃袱鑰咃細

```powershell
PowerShell -ExecutionPolicy Bypass -File "<relay-root>\scripts\start_mcp_oneclick.ps1" -SetupClient all
```

5. 闇€瑕佹帓鏌ユ椂杩愯璇婃柇鍜?smoke锛?
```powershell
PowerShell -ExecutionPolicy Bypass -File "<relay-root>\scripts\doctor_mcp.ps1" -Client codex
PowerShell -ExecutionPolicy Bypass -File "<relay-root>\scripts\smoke_mcp.ps1"
```

## 姣忓ぉ鍚姩娴佺▼

1. 鍙屽嚮 `<relay-root>\鍚姩MCP.bat`銆?2. 鎵撳紑 Figma 鏂囦欢銆?3. 杩愯寮€鍙戞彃浠?`LKS Figma MCP Relay`锛屼繚鎸佹彃浠?UI 闈㈡澘鎵撳紑銆?4. 鍦?Codex/AI 閲屼娇鐢?`figmaMcpRelay` MCP tools銆?
## 榛樿绔彛

```text
AI MCP endpoint:     http://127.0.0.1:32130/mcp
Plugin relay URL:    http://localhost:32130
WebSocket endpoint:  ws://localhost:32130/figma
Legacy Python relay: http://127.0.0.1:32131
```

Figma manifest 鍙厑璁?`localhost` dev domains銆傛彃浠?UI 浼氭妸 `127.0.0.1` 鑷姩瑙勮寖鎴?`localhost`锛屼笉瑕佹妸 `127.0.0.1` 鍔犲洖 `devAllowedDomains`銆?
## 鐩綍缁撴瀯

```text
code/                     Figma 鎻掍欢 main 浠ｇ爜鐗囨锛宻cripts/build.py 浼氭嫾鎴?code.js
scripts/                  鏋勫缓銆佸惎鍔ㄣ€佽瘖鏂€丮CP 閰嶇疆鍜?smoke 鑴氭湰
prompts/                  鎻掍欢 UI 鍐呯疆 AI 鎻愮ず璇嶆ā鏉?server/                   legacy Python 鍚庣锛屼粎鏃ц兘鍔涙寜闇€浣跨敤
src/                      Node/TypeScript MCP Gateway 婧愮爜
code.js                   Figma manifest 浣跨敤鐨?main 鐢熸垚鐗?ui.html                   Figma 鎻掍欢 UI
dist/                     TypeScript 鏋勫缓杈撳嚭锛岃嚜鍔ㄧ敓鎴愶紝涓嶆彁浜?node_modules/             npm 渚濊禆锛岃嚜鍔ㄥ畨瑁咃紝涓嶆彁浜?.local/                   鏈満 token / 鍙€変究鎼?Node锛屼笉鎻愪氦
.logs/                    鏈満杩愯鏃ュ織锛屼笉鎻愪氦
.tmp/                     涓存椂璧勬簮鐩綍锛屼笉鎻愪氦
```

鏍圭洰褰曚繚鐣?`鍚姩MCP.bat`銆乣start_mcp_oneclick.bat`銆乣start_mcp.bat`銆乣stop_mcp.bat` 绛夊父鐢ㄥ叆鍙ｏ紝閬垮厤鍚屼簨鍚姩鏃惰繕瑕佽繘瀛愮洰褰曟壘鑴氭湰銆?
## 浜屾湡鏀归€犵偣

- `/mcp` 浣跨敤瀹樻柟 `@modelcontextprotocol/sdk` 鐨?Streamable HTTP transport锛屼笉鍐嶆妸鎵嬪啓 JSON-RPC 瀛愰泦浼鎴愭爣鍑嗕紶杈撱€?- MCP session 浣跨敤 SDK 鐨?`Mcp-Session-Id` 鏈哄埗锛涙爣鍑?MCP client 浼氬湪 initialize 鍚庤嚜鍔ㄦ惡甯?session銆?- Figma 鎻掍欢 WebSocket 鏀寔澶?session registry銆傚彧鏈変竴涓彃浠剁獥鍙ｅ湪绾挎椂鍙互鐪佺暐鐩爣锛涘涓獥鍙ｅ湪绾挎椂搴斾紶 `target.sessionId` 鎴?`target.fileKey`锛屽惁鍒?Gateway 浼氭嫆缁濈寽娴嬨€?- WebSocket ACK 鍚庢湁鎵ц lease锛屾彃浠?UI 鍏抽棴鎴栧崱浣忔椂浼?requeue 鍒?polling fallback锛屼笉鍐嶇瓑 1 灏忔椂 TTL銆?- `/assets` 榛樿鍙厑璁镐笓鐢ㄤ复鏃剁洰褰曪紝涓嶅厑璁歌鍙栨暣涓彃浠剁洰褰曪紝骞舵樉寮忔帓闄?`.local/`銆?- HTTP 鍜?WebSocket 浼氭牎楠屾湰鍦?Host/Origin锛岄檷浣庢湰鍦?MCP 绔彛琚法绔欑綉椤垫互鐢ㄧ殑椋庨櫓銆?- `scripts/setup_mcp_config.ps1` 鍜?`scripts/doctor_mcp.ps1` 浼氭鏌ヨ繍琛屼腑鐨?Gateway 鏄惁鏉ヨ嚜褰撳墠鎻掍欢鐩綍锛岄伩鍏嶅悓浜嬫満鍣ㄤ笂杩炲埌鍙︿竴涓?checkout銆?
## 插件内 AI 执行

在“AI 提示词”页选择 Codex CLI 或 Claude Code，然后选择 Figma 节点并点击“AI 自动整理节点”。插件会自动切换到“AI 执行”页：

- 实时追加当前任务的新输出；
- 执行期间可以停止任务；
- 当前回合完成并取得 CLI 会话 ID 后，可以输入补充要求继续同一会话；
- 关闭插件面板或 Figma 会话断开时，Relay 会停止仍在运行的关联 AI 进程。

AI 执行不再打开 PowerShell 或独立 WPF 窗口。完整落盘日志位于插件运行目录的 `.tmp/ai-runs/<runId>/execution.log`。

## MCP tools

- `figma_health`
- `figma_query_selection`
- `figma_query_plugin_status`
- `figma_query_pages`
- `figma_query_node_children`
- `figma_query_components`
- `figma_resize_node`
- `figma_delete_node`
- `figma_submit_job`
- `figma_wait_result`
- `figma_prefab_import_start`
- `figma_prefab_import_status`

褰撳涓?Figma 鎻掍欢闈㈡澘鍚屾椂鎵撳紑鏃讹紝寤鸿杩欐牱鎸囧畾鐩爣锛?
```json
{
  "target": {
    "fileKey": "your-figma-file-key"
  }
}
```

鎴栵細

```json
{
  "target": {
    "sessionId": "figma-relay-session-..."
  }
}
```

`figma_health` 浼氳繑鍥炲綋鍓嶅湪绾?session 鍒楄〃銆?
## 閰嶇疆鑴氭湰

MCP 閰嶇疆鍐欏叆涓嶄粠鎻掍欢 UI 鐩存帴鎵ц锛岃浣跨敤鏈湴鑴氭湰锛?
```powershell
# 鏌ョ湅閰嶇疆鐘舵€?powershell -ExecutionPolicy Bypass -File "<relay-root>\scripts\setup_mcp_config.ps1" -Client codex -Action status

# 鍐欏叆閰嶇疆
powershell -ExecutionPolicy Bypass -File "<relay-root>\scripts\setup_mcp_config.ps1" -Client codex -Action write

# 鎵撳紑閰嶇疆鏂囦欢
powershell -ExecutionPolicy Bypass -File "<relay-root>\scripts\setup_mcp_config.ps1" -Client codex -Action open

# 鍒犻櫎 figmaMcpRelay 閰嶇疆椤?powershell -ExecutionPolicy Bypass -File "<relay-root>\scripts\setup_mcp_config.ps1" -Client codex -Action delete
```

鑴氭湰閫氳繃 `<relay-root>/.local/admin-token.txt` 璋冪敤鏈湴 Gateway 鐨勫彈淇濇姢閰嶇疆绔偣銆俙.local/` 宸插姞鍏?`.gitignore`锛屼笉瑕佹彁浜ゃ€?
## 瀹夊叏杈圭晫

- 榛樿鍙粦瀹?`127.0.0.1`锛屽澶栨樉绀虹粰鎻掍欢鐨勫湴鍧€浣跨敤 `localhost`銆?- `/mcp/config/write/delete/open` 闇€瑕佹湰鍦?admin token銆?- `/assets/{requestId}/{assetId}` 鍙厑璁歌鍙?Gateway 鍏佽鏍圭洰褰曞唴鐨勬枃浠讹紝涓?`.local/` 姘歌繙绂佹銆?- 榛樿鍏佽鏍圭洰褰曞寘鎷彃浠?`.tmp`銆佷粨搴?`.tmp`銆佺郴缁熶复鏃剁洰褰曚笅鐨?`figma-mcp-relay`銆?- 濡傞渶缁欏洟闃熷伐鍏烽澶栧紑鏀捐祫婧愮洰褰曪紝鍚姩 Gateway 鏃舵坊鍔?`--asset-root <path>`銆?- `POST /jobs` 浼氭嫆缁濇湭瀹屾垚鐨勯噸澶?`requestId`銆?
## Legacy Python 鍚庣

Node Gateway 榛樿鐩戝惉 `32130`銆傝皟鐢?legacy 鍔熻兘鏃讹紝Gateway 浼氭寜闇€鍚姩鍐呴儴 Python relay锛岄粯璁ゅ唴閮ㄧ鍙?`32131`锛屽澶栦粛鍙毚闇?`32130`銆?
鐩存帴璋冭瘯 Python relay锛?
```powershell
powershell -ExecutionPolicy Bypass -File "<relay-root>\scripts\start_mcp_companion.ps1" -Mode relay
```

## 甯歌闂

### 鎻掍欢鏄剧ず鈥滄湭閾炬帴鈥?
鎸夐『搴忔鏌ワ細

1. Gateway 鏄惁鍚姩锛?
```powershell
Invoke-RestMethod http://127.0.0.1:32130/health
```

2. 鎻掍欢 URL 鏄惁鏄?`http://localhost:32130`锛屼笉鏄?`http://127.0.0.1:32130`銆?3. Figma 鎻掍欢 UI 闈㈡澘鏄惁淇濇寔鎵撳紑銆?4. 杩愯锛?
```powershell
powershell -ExecutionPolicy Bypass -File "<relay-root>\scripts\doctor_mcp.ps1" -Client codex
```

### Figma 鎶?devAllowedDomains 鏃犳晥

涓嶈鍦?manifest 閲屽啓 `http://127.0.0.1:32130`銆侳igma 寮€鍙戞彃浠剁綉缁滅瓥鐣ヤ娇鐢?`localhost`锛?
```text
http://localhost:32130
ws://localhost:32130
```

### Python 鍦板潃鎴栫幆澧冮毦閰?
鍩虹 MCP銆乄ebSocket銆乸olling 涓嶄緷璧?Python銆侾ython 鍙湪璋冪敤 legacy 鑳藉姏鏃堕渶瑕侊紝渚嬪 `/prefab-to-figma/import`銆乣/crop-jiugong`銆?
## 寮€鍙戝懡浠?
```powershell
Set-Location "<relay-root>"
npm install
npm run typecheck
npm run build
npm run smoke
npm start
```

寮€鍙戞ā寮忥細

```powershell
npm run dev -- --transport auto
```
