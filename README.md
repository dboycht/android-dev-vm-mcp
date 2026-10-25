# android-dev-vm-mcp

在电脑上开一台**开发版安卓虚拟机（headless 模拟器）**，通过 **MCP（Model Context Protocol）** 让 AI 直接调试、测试安卓应用：截屏、读 UI 树、点按输入、装包、看日志，一个工具集全包。

与现有同类项目（[mobile-mcp](https://github.com/mobile-next/mobile-mcp)、[CursorTouch/Android-MCP](https://github.com/CursorTouch/Android-MCP) 等）的差别：**它们只控制"已经装好 SDK、跑着模拟器"的设备；本项目把"从零搭环境"也做进了工具链**——一条命令把 Android SDK（约 2.5 GB）下载到**项目文件夹内**，自动建好开发用 AVD，headless 启动，全程不污染系统目录，删掉项目文件夹即完全卸载。

## 环境要求

- Windows 10/11（x86_64），已开启 **Windows 虚拟机监控程序平台**（服务 `vmcompute` 存在且在跑；没有就管理员终端执行 `DISM /Online /Enable-Feature /All /FeatureName:HypervisorPlatform` 后重启）
- Node.js ≥ 22
- Java 17+（`java -version` 可用即可，供 sdkmanager 使用）

## 快速开始

```bash
npm install
node cli.mjs setup      # 一次性：下载 SDK + 建 AVD（约 2.5 GB；8 路并行下载，实测系统镜像 1.5GB ≈ 2 分钟）
node cli.mjs boot       # 启动 headless 模拟器，等到 boot_completed 才返回（首次冷启动约 2 分钟）
node cli.mjs status     # 查看环境状态
```

把 MCP server 挂到任意 MCP 客户端（ZCode / Claude Desktop / Cursor 等），`args` 换成你本项目的实际路径：

```json
{
  "mcpServers": {
    "android-dev-vm": {
      "command": "node",
      "args": ["<项目文件夹绝对路径>\\src\\server.mjs"]
    }
  }
}
```

之后 AI 就可以直接调用下面 25 个 `android_*` 工具。

## 工具一览（25 个）

| 分类 | 工具 | 作用 |
| --- | --- | --- |
| 环境 | `android_env_status` | SDK / AVD / 加速 / 模拟器状态 + 下一步建议 |
| | `android_env_setup` | 一键下载 SDK + 建 AVD（幂等，跳过已完成步骤） |
| | `android_emulator_boot` | 启动 headless 模拟器并等 boot_completed（可 `wipe` / `noSnapshot`） |
| | `android_emulator_shutdown` | 关机（先优雅后强杀） |
| 设备 | `android_device_list` / `android_device_info` | 设备列表；型号/系统版本/分辨率 |
| | `android_shell` | 设备上跑任意 shell 命令（万能兜底） |
| | `android_push` / `android_pull` | 电脑 ↔ 设备传文件 |
| | `android_screenshot` | 截屏：返回 MCP 图像内容 + 存到 `data/screenshots/` |
| 输入 | `android_tap` / `android_swipe` | 坐标点按 / 滑动（swipe 拉长时长=长按） |
| | `android_text` / `android_key` | 输入文本 / 发按键（back、home、enter、dpad…） |
| UI | `android_ui_dump` | uiautomator 层级树：text/resource-id/bounds/`#index` |
| | `android_ui_tap` | 按 `#index` 或 text/resourceId/contentDesc 直接点控件，无需算坐标 |
| 应用 | `android_app_list` / `android_app_install` / `android_app_uninstall` | 包管理 |
| | `android_app_launch` / `android_app_stop` / `android_app_clear` | 启动 / 强停 / 清数据 |
| 调试 | `android_logcat` / `android_logcat_clear` | 读日志（可按 tag/priority 过滤）/ 清日志 |
| | `android_settings` | system/secure/global 设置读写删（做测试环境固定） |

启动后模拟器会自动关动画、屏幕常亮，保证 UI 自动化稳定。

## 典型 AI 工作流

```
android_env_status          # 确认就绪（没就绪会给出下一步）
android_emulator_boot       # 开机（幂等，已开就直接返回）
android_app_install         # 装上被测 APK（或 push + 测试）
android_logcat_clear        # 清日志
android_app_launch          # 启动应用
android_ui_dump             # 看 UI 树 → android_ui_tap 点按钮
android_screenshot          # 看实际画面
android_logcat              # 查报错
```

## 目录结构

```
sdk/            Android SDK（自包含，gitignore，删文件夹=卸载）
avd/            AVD 虚拟机磁盘（gitignore）
data/           运行数据：模拟器日志、pid、截屏、拉取的文件（gitignore）
src/            MCP server 与核心库（纯 ESM JS，零构建）
cli.mjs         人工入口；src/server.mjs 为 MCP stdio 入口
scripts/        selftest（协议冒烟 / 真机集成两种模式）
```

## 常见问题

- **下载慢/失败**：SDK 从 `dl.google.com` 下载；若卡住可开加速器后再跑 `node cli.mjs setup`（幂等，会续上缺的组件）。
- **模拟器极慢或起不来**：八成是没开 Windows 虚拟机监控程序平台，`android_env_status` 会提示修法。
- **端口被占**：默认控制台端口 5554；被占时设环境变量 `AIVM_PORT` 换端口。
- **自定义镜像/机型**：环境变量 `AIVM_SYSTEM_IMAGE`（默认 `system-images;android-35;google_apis;x86_64`，google_apis 可 root）、`AIVM_DEVICE_PROFILE`（默认 `pixel_7`）、`AIVM_GPU`（默认 `swiftshader_indirect`，有独显可试 `host`）。

## 许可

MIT。调研参考了 mobile-mcp、Android-MCP 等项目的工具设计思路（仅思路，未复制代码）。
