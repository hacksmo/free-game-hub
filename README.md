# Free Game Hub (CARCADE)

Android 车机 / 手机横屏游戏中心：打开即玩，全部游戏支持手柄，全面中文化，离线可玩。

## 当前版本 V1.2

- **11 款游戏**，全部支持手柄（标准映射）+ 触摸 / 键盘
- 应用 UI 与游戏界面全面中文化
- 离线可玩：游戏包本地加载，零互联网请求
- 手柄友好：大厅焦点导航、游戏中**长按 B 退出**（防误触）、设置页**手柄按键诊断面板**
- 车机 WebView 优化：实心顶栏、去模糊、滚动流畅
- **车机无声修复**（比亚迪 DiLink 7.0）：原生媒体音频焦点 + WebAudio 无手势解锁 + 设置页**音频诊断面板**

## 下载与安装

到 [Releases](https://github.com/hacksmo/free-game-hub/releases) 下载 `FreeGameHub-V1.2-debug.apk`（约 88 MB）。

```bash
adb install -r FreeGameHub-V1.2-debug.apk
```

覆盖安装保留数据。包名 `net.hackmo.carcade`。

## 完整性校验

| 文件 | SHA-256 |
|---|---|
| FreeGameHub-V1.2-debug.apk | `495fd792b03d0d0251134147f7c211fb1877e84bbd8d0ed84009a25914150436` |

## 说明

- 本仓库为私有分发用途；APK 通过 Release 附件提供，游戏资源不进 git。
- 包内个别游戏原作者未声明许可证，商用 / 公开分发前请先取得授权。