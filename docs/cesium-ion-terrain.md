# Cesium ion Quantized Mesh Terrain（实验功能）

本分支为 GeoDownloader 添加 **Cesium Terrain** 下载模式，与原有 **3D Tiles** 模式分开。

## 使用方式

1. 打开「3D Tiles」页面，切换顶部的 **Cesium Terrain**。
2. 在地图中绘制要下载的 **矩形范围**（多边形选区会按外接矩形处理）。
3. 填写 **Terrain Asset ID / Access Token**，设置 0–16 级层级区间。
4. 点击「解析 layer.json / 估算瓦片」。超出 50,000 张瓦片会被拒绝。
5. **仅在你确实拥有离线复制和存储权利时**，勾选授权确认并下载。
6. 在「下载任务」中查看进度、暂停或取消。

输出示例：

~~~text
terrain_1234_20261013100000/
  layer.json
  0/0/0.terrain
  0/1/0.terrain
  1/...
~~~

- 保持 Quantized Mesh 原始二进制，不是 DEM GeoTIFF。
- 使用 EPSG:4326 GeographicTilingScheme，目录按 **TMS (Y 从南到北)** 编号。
- 生成的 layer.json 会将 tiles URL 改为相对路径，并按成功保存的瓦片重建 available。
- 对缺失的远端瓦片（HTTP 404）使用稀疏区域处理；其它 HTTP/磁盘错误终止并保留已下载文件。
- 下载同一个输出路径时会跳过已存在的瓦片，便于手工从相同目录补漏。
- 支持取消、暂停以及最多 32 个并发请求。
- **不支持** parentUrl 叠加地形、非 Quantized Mesh、非 EPSG:4326 或超过 16 级的数据。
- 需要 HTTP 服务提供 layer.json 和 .terrain 文件；当前 Cesium for Unreal 并不保证能够将原始 layer.json 直接作为 3D Tileset URL 加载。如果目标是 UE5 脱机部署，仍需适配 Cesium 的地形管线或转换为受支持的离线 3D Tiles。

### 许可提醒

普通 Cesium ion Token 只是 API 访问凭证，不等于数据离线授权。特别是 Cesium World Terrain（Asset ID 1）不能因为可以在线访问就默认允许批量导出，请先检查资产条款或取得相应许可。本工具不绕过任何认证机制。

### 和 3D Tiles 模式的区别

| 数据 | 对应描述文件 | 下载入口 |
|---|---|---|
| Quantized Mesh Terrain | layer.json | Cesium Terrain |
| 3D Tiles 三维模型 | tileset.json | 3D Tiles |
| XYZ / Web Mercator 影像 | z/x/y.jpg 或 png | 影像下载 |

将 TERRAIN Asset ID 填入 3D Tiles 模式时，现在会给出明确的类型错误，而不是错误请求 tileset.json。

### 开发验证

在仓库根目录运行：

~~~powershell
npm ci --prefix frontend
npm run build --prefix frontend
cargo test --manifest-path src-tauri/Cargo.toml terrain_ion
cargo check --manifest-path src-tauri/Cargo.toml
~~~

以上是需要执行的检查命令；本分支提交本身不代表已经过端到端在线验证。
