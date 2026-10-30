# 核心代码来源

- 基础项目：`zhoufuweigg/guoapp`，`0e60928514c31a96ade9b31866948f15da5ca2a6`。
- 本地修复：Android 播放、HLS 中转分类与完整清单、韩小圈错误页缓存刷新、青空登录错误提示，以及红果 0.2.66 取流适配。
- 红果纯 Go 签名及新版接口：`limbia/guoapp`，`79a8abba20ebb3641c6fdd54a2d168cb0710b7ce`，上游 PR #14。该实现标注的参考来源包括 hongguo-web / pure-sign.js、jackotom/hongguo-drama、woshishiq1/drpys、N3urda/hongguoTV。
- 红果 HTTP/1.1 兼容参考：`qq294716498/HongguoTV-Phone-TV-NoAds` 的 `native/core/network_hongguo_playback.go`。
- `core/web_gateway.go`、`cmd/server` 与网站接入代码为本次 LibreTV 集成新增。

快照仅包含 Go 源码与模块锁文件，不包含 APK、账户配置、签名私钥、图片、视频或运行数据。
