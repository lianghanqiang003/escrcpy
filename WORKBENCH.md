# 多屏工作台定制版

本分支基于 viarotel-org/escrcpy 的公开源码，由 lianghanqiang003 维护。原作者及 Apache-2.0 许可证保持不变。官方发行版包含未在公开仓库提供的扩展模块；本分支在公开基础版上独立实现工作台，不包含这些扩展源码。

## 使用

启动应用后进入「工作台」。已通过 USB 或无线 ADB 连接的手机自动出现，每五秒更新一次设备列表。相同手机的 USB、IP 和 mDNS 入口按硬件序列号去重。点击每张卡片右上角可以放大画面，其他手机仍保持视频连接。

默认仅查看画面。打开「允许操作手机」后，可以点击、按住拖动、长按，以及使用卡片下方的返回、主页、最近任务按钮。「同步操作所有手机」会把选中主控手机的操作同步到所有在线手机，使用各自画面的相对坐标。手机处于不同页面时，请先关闭同步操作、分别调整。触控板双指滚动不映射为手机滚动，请按住拖动，避免一次手势触发多次滑动。

支持 540p / 720p / 1080p（按屏幕长边），帧率上限为 24 / 24 / 30 fps。Android 静止画面可能不产生新帧，面板显示的是实际收到的帧率。使用本机 WebCodecs 解码真实 H.264 视频流；音频与剪贴板同步均关闭，画面不上传到外部服务。

切换到其他页签会停止工作台视频会话，回来后自动重连。退出应用只清理本工作台创建的会话和 ADB 转发，不重启 ADB 服务。手机本身的锁屏、应用安全验证和受保护画面仍由手机系统管理。

## 开发与构建

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm test:workbench
pnpm lint
pnpm --filter escrcpy... build
pnpm --filter escrcpy exec electron-builder --config=./electron-builder.config.js --mac --arm64 --dir --publish=never
```

应用输出在 `desktop/dist-release/mac-arm64/Escrcpy.app`。依赖仓库内匹配版本的 scrcpy 客户端和服务端，不使用系统 PATH 下不同版本的 server。视频解析器按照 scrcpy 4.x 会话/媒体数据格式实现；升级内置 scrcpy 时应一起验证协议。

更新源及手动下载地址指向本仓库，避免官方更新覆盖定制功能。安装替换前，请保留原版应用及 `~/Library/Application Support/escrcpy` 的备份。本项目不签署开发者证书，供本机使用的构建可以做本地 ad-hoc 签名。
