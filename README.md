# Bili Music

**方便听 B 站歌曲的小玩意。**

把 B 站当成音乐库来用：搜歌名、歌手或 Live，把合集 / 多 P 拆成单曲；建歌单、看歌词、无缝切歌。登录后还能按你的兴趣推荐。也支持 MusicFree 兼容音源插件，并通过 GitHub Releases 自动更新。

|  |  |
|--|--|
| 仓库 | [github.com/RYANLI137/bili-music](https://github.com/RYANLI137/bili-music) |
| 下载 | [Releases](https://github.com/RYANLI137/bili-music/releases) |
| 平台 | Windows 桌面（Electron） |

## 功能概览

- 搜索 B 站视频，合集 / 多 P 拆成单曲播放
- 歌单、收藏、最近播放、待播清单
- 歌词（网易云搜索 API + [LRCLIB](https://lrclib.net/)）
- 双轨 Web Audio 交叉淡化、版本无缝（SEAM）、跨曲无缝（MixEngine）
- 可选 Veloura 分析引擎（打包内置运行时）
- MusicFree 兼容音源插件（协议对齐，自研宿主）
- 下载音频 / 原视频小窗、全局快捷键、任务栏缩略图按钮
- GitHub Releases + `electron-updater` 自动更新

## 开发

```powershell
npm install
npm run prepare:veloura   # 首次需要，准备 Veloura / FFmpeg 运行时
npm start
```

打包安装包：

```powershell
npm run dist
```

发布到 GitHub Releases（需 `GH_TOKEN`）：

```powershell
# PowerShell
$env:GH_TOKEN="你的token"
npm run release

# 或 cmd
set GH_TOKEN=你的token
npm run release
```

## 目录结构（简）

| 路径 | 说明 |
|------|------|
| `main.js` / `preload.js` | Electron 主进程与预加载 |
| `renderer/` | 界面与播放器逻辑 |
| `src/` | B 站 API、歌词、下载、音源插件、更新等 |
| `vendor/` | Veloura 桥接与运行时 |
| `native/mixengine/` | MixEngine 可选 C++ 头文件（安装包默认用 JS） |

## 引用与致谢

本项目为自研实现。下列项目 / 服务提供了**协议、思路或运行时依赖**；除注明的第三方包外，**未直接复制其源码**。本地实现文件均附仓库内链接，便于对照。

### 音源插件协议（MusicFree）

对齐公开插件协议，自研宿主；可加载社区 `.js` 插件（请自行鉴别安全性，勿用于商业用途）。MusicFree 桌面版为 AGPL-3.0，请遵守其协议约定。

| 用途 | 上游 | 本仓库实现 |
|------|------|------------|
| 插件协议文档 | [musicfree.catcat.work/plugin/protocol.html](https://musicfree.catcat.work/plugin/protocol.html) | [`src/sources.js`](src/sources.js) |
| 桌面版架构参考 | [maotoumao/MusicFreeDesktop](https://github.com/maotoumao/MusicFreeDesktop) | 同上；设置 UI 见 [`renderer/app.js`](renderer/app.js)（音源页） |
| 安卓版 / 协议说明 | [maotoumao/MusicFree](https://github.com/maotoumao/MusicFree) | 同上 |

### 混音 / 无缝切歌思路

| 用途 | 上游 | 本仓库实现 |
|------|------|------------|
| AutoDJ 静音检测、过渡适配度等 | [mixxxdj/mixxx](https://github.com/mixxxdj/mixxx)（`AnalyzerSilence` / AutoDJ 相关） | [`renderer/mixengine.js`](renderer/mixengine.js)、[`native/mixengine/`](native/mixengine/README.md) |
| 版本对齐与精确交接（SEAM 管线思路） | 自研实现（chroma / DTW / equal-power） | [`renderer/seam.js`](renderer/seam.js)，调用见 [`renderer/app.js`](renderer/app.js) |
| equal-power 交叉淡化、包络衔接等 | 参考 LiveSort / Automix 类产品行为（非抄源码） | [`renderer/app.js`](renderer/app.js)（交叉淡化 / 无缝相关函数） |

> Mixxx 为 GPL。本仓库中的 MixEngine 为行为级重实现，**请勿**把 Mixxx GPL 源码直接并入本树。详见 [`native/mixengine/README.md`](native/mixengine/README.md)。

### 音频分析运行时（Veloura + FFmpeg）

| 用途 | 上游 | 本仓库实现 |
|------|------|------------|
| AutoMix / SLM 分析 | [veloura-audio (PyPI)](https://pypi.org/project/veloura-audio/) | [`src/veloura.js`](src/veloura.js)、[`vendor/bridge/veloura_bridge.py`](vendor/bridge/veloura_bridge.py) |
| 嵌入式运行时准备 | embeddable CPython + [imageio-ffmpeg](https://pypi.org/project/imageio-ffmpeg/) | [`scripts/prepare-veloura.ps1`](scripts/prepare-veloura.ps1)、[`vendor/README.md`](vendor/README.md) |

### 歌词与内容 API

| 用途 | 上游 | 本仓库实现 |
|------|------|------------|
| B 站公开 Web API（搜索、播放地址、登录 Cookie 等） | [www.bilibili.com](https://www.bilibili.com) / `api.bilibili.com` | [`src/bili.js`](src/bili.js) |
| 歌词候选（网易云搜索接口） | music.163.com API | [`src/lyrics.js`](src/lyrics.js) |
| 歌词库 | [lrclib.net](https://lrclib.net/) | [`src/lyrics.js`](src/lyrics.js) |

### 桌面框架与自动更新

| 用途 | 上游 | 本仓库实现 |
|------|------|------------|
| 桌面壳 | [electron/electron](https://github.com/electron/electron) | `main.js`、`preload.js`、`package.json` |
| 打包 | [electron-userland/electron-builder](https://github.com/electron-userland/electron-builder) | `package.json` → `build` |
| 从 GitHub Releases 更新 | [electron-userland/electron-updater](https://github.com/electron-userland/electron-updater) | [`src/updater.js`](src/updater.js) |
| 滚动日志思路 | [megahertz/electron-log](https://github.com/megahertz/electron-log) / winston 类 size-rotate | [`src/logger.js`](src/logger.js)（自研简易实现） |

### 其它

| 用途 | 说明 |
|------|------|
| 示例音源试听 URL | [SoundHelix 示例 MP3](https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3)（仅演示插件，见 [`src/sources.js`](src/sources.js) 内示例） |

## 声明

- 本软件仅作个人学习与合法使用；请遵守 B 站及各音源平台服务条款与版权规定。
- 第三方音源插件由用户自行安装与承担风险；本项目不内置商业音源。
- 引用项目各有其开源协议（如 MusicFree AGPL、Mixxx GPL），二次分发时请自行合规审查。

## License

若仓库根目录暂未放置 `LICENSE` 文件，以作者后续声明为准。引入的第三方依赖与插件协议按其各自条款执行。
