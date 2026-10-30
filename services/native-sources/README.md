# LibreTV 站源适配服务

将红果、韩小圈、鬼片转换为 LibreTV 支持的采集接口，并在服务器上把选中的分集转换为浏览器可播放的 HLS。只有用户开始播放时才启动单集处理，不预先下载整部剧。

`core/` 是本工作区已修复至 0.2.66 的 guoapp 原生核心快照，原项目：https://github.com/zhoufuweigg/guoapp 。红果新版协议参考 https://github.com/zhoufuweigg/guoapp/pull/14 及 https://github.com/qq294716498/HongguoTV-Phone-TV-NoAds ，原始来源说明见 `SOURCE.md`。此目录中的来源代码保留其原作者权利，不因 LibreTV 根目录许可证而重新声明许可。

服务只应监听本机地址，经 Cloudflare Tunnel 发布；请求使用服务端令牌认证。Pages 保存 `NATIVE_SOURCE_ORIGIN` 和 Secret `NATIVE_SOURCE_TOKEN`。禁止把令牌、服务器密码或运行数据提交到仓库。

所需环境：Go 1.24.1+、FFmpeg、FFprobe。构建：

```
go build -trimpath -ldflags="-s -w -X duanjuapp/native/core.buildAllSources=true" -o native-sources ./cmd/server
```

环境变量：`SOURCE_TOKEN`（至少 32 字符）、`PUBLIC_SITE_URL`、`LISTEN_ADDR`（默认 `127.0.0.1:3987`）、`DATA_DIR`、`FFMPEG_PATH`、`MAX_ACTIVE_JOBS`（默认 1）、`CACHE_MAX_MB`（默认 2048）。

转换使用流复制，尽量避免视频重新编码。播放列表随准备进度增长，视频准备完成后支持完整时长与拖动；未准备好的远端位置可能需要等待。缓存空闲 20 分钟后回收，服务具有并发与磁盘上限。站源自身的登录或授权限制不会被解除。
