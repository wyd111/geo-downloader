//! Cesium ion Quantized Mesh terrain export for assets with offline rights.
//! This is deliberately separate from the 3D Tiles (tileset.json) downloader.

use futures::{stream, StreamExt};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;
use crate::task::PauseControl;

const MAX_TILES: usize = 50_000;
const MAX_LEVEL: u8 = 16;

#[derive(Debug, Clone, Deserialize)]
pub struct TerrainRequest {
    pub asset_id: u64,
    pub access_token: String,
    /// [west, south, east, north] in WGS84 degrees. Bounding rectangle, not polygon.
    pub bounds: [f64; 4],
    pub min_level: u8,
    pub max_level: u8,
    pub save_path: String,
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    pub proxy: Option<String>,
    /// User attests that the asset's license permits offline copying.
    pub confirm_offline_rights: bool,
}

fn default_concurrency() -> usize { 8 }

#[derive(Debug, Clone, Serialize)]
pub struct TerrainSummary {
    pub version: String,
    pub format: String,
    pub projection: String,
    pub scheme: String,
    pub estimated_tiles: u32,
}

#[derive(Debug, Clone)]
pub struct TerrainProgress {
    pub completed: u32,
    pub total: u32,
    pub failed: u32,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct IonEndpoint {
    #[serde(rename = "type")]
    asset_type: String,
    url: Option<String>,
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    options: Option<IonOptions>,
}

#[derive(Debug, Deserialize)]
struct IonOptions { url: Option<String> }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Tile { z: u8, x: u32, y: u32 }

struct TerrainPlan {
    layer: Value,
    base_url: Url,
    bearer: Option<String>,
    template: String,
    tiles: Vec<Tile>,
}

pub struct TerrainIonClient { http: Client }

impl TerrainIonClient {
    pub fn new(proxy: Option<&str>) -> Result<Self, String> {
        let mut builder = Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .connect_timeout(std::time::Duration::from_secs(15))
            .danger_accept_invalid_certs(crate::config::allow_invalid_certs());
        if let Some(proxy) = proxy.filter(|value| !value.is_empty()) {
            builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| e.to_string())?);
        }
        Ok(Self { http: builder.build().map_err(|e| e.to_string())? })
    }

    async fn plan(&self, request: &TerrainRequest) -> Result<TerrainPlan, String> {
        validate_request(request)?;
        let endpoint_url = format!(
            "https://api.cesium.com/v1/assets/{}/endpoint", request.asset_id
        );
        let response = self.http.get(endpoint_url)
            .bearer_auth(&request.access_token)
            .send().await.map_err(|e| format!("Ion endpoint 请求失败: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("Ion endpoint 返回 HTTP {}", response.status()));
        }
        let endpoint: IonEndpoint = response.json().await
            .map_err(|e| format!("Ion endpoint 解析失败: {e}"))?;
        if !endpoint.asset_type.eq_ignore_ascii_case("TERRAIN") {
            return Err(format!(
                "资产类型为 {}，不是 TERRAIN；请使用对应的下载模式",
                endpoint.asset_type
            ));
        }
        let raw_url = endpoint.url.or_else(|| endpoint.options.and_then(|v| v.url))
            .ok_or("Ion endpoint 未提供地形 URL")?;
        let mut base_url = Url::parse(&raw_url)
            .map_err(|e| format!("无效的地形 URL: {e}"))?;
        if base_url.scheme() != "https" {
            return Err("Terrain endpoint 必须使用 HTTPS".into());
        }
        if !base_url.path().ends_with("layer.json") {
            let path = format!("{}/layer.json", base_url.path().trim_end_matches('/'));
            base_url.set_path(&path);
        }
        let mut layer_req = self.http.get(base_url.clone());
        if let Some(bearer) = &endpoint.access_token {
            layer_req = layer_req.bearer_auth(bearer);
        }
        let response = layer_req.send().await
            .map_err(|e| format!("读取 layer.json 失败: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("layer.json 请求返回 HTTP {}", response.status()));
        }
        let layer: Value = response.json().await
            .map_err(|e| format!("layer.json 格式无效: {e}"))?;
        let format = layer["format"].as_str().unwrap_or("");
        if !format.starts_with("quantized-mesh") {
            return Err(format!("不支持地形格式 {format}；仅支持 quantized-mesh"));
        }
        if layer["projection"].as_str().unwrap_or("EPSG:4326") != "EPSG:4326" {
            return Err("目前只支持 EPSG:4326 GeographicTilingScheme".into());
        }
        let scheme = layer["scheme"].as_str().unwrap_or("tms");
        if scheme != "tms" && scheme != "xyz" && scheme != "slippyMap" {
            return Err(format!("不支持的瓦片 Y 编号方式: {scheme}"));
        }
        if layer.get("parentUrl").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
            return Err("该资产依赖 parentUrl 父地形图层，当前离线导出尚不支持此结构".into());
        }
        let template = layer["tiles"].as_array()
            .and_then(|a| a.iter().filter_map(Value::as_str).next())
            .ok_or("layer.json 缺少 tiles URL 模板")?.to_string();
        let tiles = select_tiles(request, &layer)?;
        Ok(TerrainPlan { layer, base_url, bearer: endpoint.access_token, template, tiles })
    }

    pub async fn analyze(&self, request: &TerrainRequest) -> Result<TerrainSummary, String> {
        let plan = self.plan(request).await?;
        Ok(TerrainSummary {
            version: plan.layer["version"].as_str().unwrap_or("").to_string(),
            format: plan.layer["format"].as_str().unwrap_or("").to_string(),
            projection: plan.layer["projection"].as_str().unwrap_or("EPSG:4326").to_string(),
            scheme: plan.layer["scheme"].as_str().unwrap_or("tms").to_string(),
            estimated_tiles: plan.tiles.len() as u32,
        })
    }

    pub async fn download<F>(
        &self,
        request: &TerrainRequest,
        cancel: CancellationToken,
        pause: PauseControl,
        notify: F,
    ) -> Result<PathBuf, String>
    where F: Fn(TerrainProgress) + Send + Sync,
    {
        if !request.confirm_offline_rights {
            return Err("需要先确认你拥有此 Terrain 资产的离线下载和存储权限".into());
        }
        let plan = self.plan(request).await?;
        if plan.tiles.is_empty() {
            return Err("选区内没有可下载的 Terrain 瓦片".into());
        }
        let total = plan.tiles.len() as u32;
        let out = PathBuf::from(&request.save_path);
        tokio::fs::create_dir_all(&out).await.map_err(|e| e.to_string())?;
        let concurrency = request.concurrency.clamp(1, 32);
        let scheme = plan.layer["scheme"].as_str().unwrap_or("tms").to_string();
        let version = plan.layer["version"].as_str().unwrap_or("").to_string();
        let mut stream = stream::iter(plan.tiles.into_iter().map(|tile| {
            let base = plan.base_url.clone();
            let template = plan.template.clone();
            let bearer = plan.bearer.clone();
            let http = self.http.clone();
            let dest = out.join(tile.z.to_string()).join(tile.x.to_string())
                .join(format!("{}.terrain", tile.y));
            let cancel = cancel.clone();
            let pause = pause.clone();
            let version = version.clone();
            async move {
                if cancel.is_cancelled() { return Err("已取消".to_string()); }
                pause.wait_if_paused().await;
                if cancel.is_cancelled() { return Err("已取消".to_string()); }
                if dest.exists() { return Ok(Some(tile)); } // resumable
                let remote_y = if scheme == "tms" {
                    tile.y
                } else {
                    ((1u32 << tile.z) - 1) - tile.y
                };
                let relative = template
                    .replace("{z}", &tile.z.to_string())
                    .replace("{x}", &tile.x.to_string())
                    .replace("{y}", &remote_y.to_string())
                    .replace("{version}", &version);
                if relative.contains('{') || relative.contains('}') {
                    return Err("瓦片 URL 包含未支持的模板占位符".into());
                }
                let url = base.join(&relative).map_err(|e| format!("瓦片 URL 无效: {e}"))?;
                if url.scheme() != "https" {
                    return Err("瓦片 URL 必须使用 HTTPS".into());
                }
                let mut req = http.get(url).header(
                    "Accept", "application/vnd.quantized-mesh;extensions=octvertexnormals-watermask-metadata"
                );
                if let Some(token) = &bearer { req = req.bearer_auth(token); }
                let resp = req.send().await.map_err(|e| format!("瓦片网络失败: {e}"))?;
                if resp.status() == reqwest::StatusCode::NOT_FOUND {
                    return Ok(None); // sparse terrain: no tile here
                }
                if !resp.status().is_success() {
                    return Err(format!("瓦片 HTTP {}", resp.status()));
                }
                let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
                if bytes.is_empty() { return Err("服务器返回空地形瓦片".into()); }
                let parent = dest.parent().ok_or("无效的本地路径")?;
                tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
                tokio::fs::write(&dest, bytes).await.map_err(|e| e.to_string())?;
                Ok(Some(tile))
            }
        })).buffer_unordered(concurrency);

        let mut finished = 0u32;
        let mut failed = 0u32;
        let mut saved: Vec<Tile> = Vec::new();
        let mut first_error: Option<String> = None;
        while let Some(result) = stream.next().await {
            if cancel.is_cancelled() { return Err("已取消".into()); }
            finished += 1;
            match result {
                Ok(Some(tile)) => saved.push(tile),
                Ok(None) => {},
                Err(err) => {
                    failed += 1;
                    if first_error.is_none() { first_error = Some(err); }
                }
            }
            notify(TerrainProgress {
                completed: finished,
                total,
                failed,
                message: format!("Quantized Mesh: {finished}/{total} (失败 {failed})"),
            });
        }
        drop(stream);
        if failed > 0 {
            return Err(format!(
                "{} 个地形瓦片下载失败；可再次下载继续补齐。首次错误: {}",
                failed, first_error.unwrap_or_default()
            ));
        }
        if saved.is_empty() { return Err("选区内未获得任何地形瓦片".into()); }

        // Avoid leaking ion URLs/tokens in local metadata. Preserve legitimate
        // quantized-mesh metadata while making the tile URLs fully local.
        let mut offline = plan.layer;
        let object = offline.as_object_mut().ok_or("layer.json 根节点不是对象")?;
        object.insert("tiles".into(), json!(["{z}/{x}/{y}.terrain"]));
        object.insert("scheme".into(), json!("tms"));
        object.insert("available".into(), availability(&saved, request.max_level));
        object.insert("minzoom".into(), json!(request.min_level));
        object.insert("maxzoom".into(), json!(request.max_level));
        object.remove("metadataAvailability"); // no external availability metadata
        object.remove("parentUrl");
        let output = out.join("layer.json");
        let data = serde_json::to_vec_pretty(&offline).map_err(|e| e.to_string())?;
        tokio::fs::write(&output, data).await.map_err(|e| e.to_string())?;
        Ok(output)
    }
}

fn validate_request(r: &TerrainRequest) -> Result<(), String> {
    if r.asset_id == 0 || r.access_token.trim().is_empty() {
        return Err("请填写有效的 Cesium ion Asset ID 和 Access Token".into());
    }
    if r.min_level > r.max_level || r.max_level > MAX_LEVEL {
        return Err(format!("地形层级要求 0 <= min <= max <= {MAX_LEVEL}"));
    }
    let [w, s, e, n] = r.bounds;
    if !r.bounds.iter().all(|v| v.is_finite()) ||
        w < -180.0 || e > 180.0 || s < -90.0 || n > 90.0 ||
        w >= e || s >= n {
        return Err("请选择有效的 WGS84 矩形区域（暂不支持跨越 180° 经线）".into());
    }
    if r.save_path.trim().is_empty() {
        return Err("请选择保存目录".into());
    }
    Ok(())
}

/// GeographicTilingScheme: level zero is 2x1. Returns TMS Y (south-to-north).
fn tile_range(bounds: [f64; 4], z: u8) -> (u32, u32, u32, u32) {
    let [w, s, e, n] = bounds;
    let columns = (2u64 << z) as f64;
    let rows = (1u64 << z) as f64;
    let x0 = (((w + 180.0) / 360.0) * columns).floor().max(0.0) as u32;
    let x1 = ((((e + 180.0) / 360.0) * columns) - 1e-10)
        .floor().max(0.0).min(columns - 1.0) as u32;
    let y0 = (((s + 90.0) / 180.0) * rows).floor().max(0.0) as u32;
    let y1 = ((((n + 90.0) / 180.0) * rows) - 1e-10)
        .floor().max(0.0).min(rows - 1.0) as u32;
    (x0, x1, y0, y1)
}

fn in_available(layer: &Value, t: Tile) -> bool {
    let Some(levels) = layer["available"].as_array() else { return true; };
    let Some(rectangles) = levels.get(t.z as usize).and_then(Value::as_array) else {
        // Some terrain services publish only a prefix of availability levels.
        return true;
    };
    rectangles.iter().any(|rect| {
        let x0 = rect["startX"].as_u64().unwrap_or(u64::MAX);
        let y0 = rect["startY"].as_u64().unwrap_or(u64::MAX);
        let x1 = rect["endX"].as_u64().unwrap_or(0);
        let y1 = rect["endY"].as_u64().unwrap_or(0);
        (t.x as u64) >= x0 && (t.x as u64) <= x1 &&
        (t.y as u64) >= y0 && (t.y as u64) <= y1
    })
}

fn select_tiles(request: &TerrainRequest, layer: &Value) -> Result<Vec<Tile>, String> {
    let mut tiles = Vec::new();
    for z in request.min_level..=request.max_level {
        let (x0, x1, y0, y1) = tile_range(request.bounds, z);
        for x in x0..=x1 {
            for y in y0..=y1 {
                let tile = Tile { z, x, y };
                if in_available(layer, tile) {
                    tiles.push(tile);
                    if tiles.len() > MAX_TILES {
                        return Err(format!(
                            "选区超过 {} 个瓦片，请缩小范围或降低最高层级",
                            MAX_TILES
                        ));
                    }
                }
            }
        }
    }
    Ok(tiles)
}

/// Group adjacent tiles in the same row into compact availability rectangles.
fn availability(tiles: &[Tile], max_level: u8) -> Value {
    let mut rows: BTreeMap<(u8, u32), Vec<u32>> = BTreeMap::new();
    for t in tiles { rows.entry((t.z, t.y)).or_default().push(t.x); }
    let mut levels: Vec<Vec<Value>> = vec![Vec::new(); max_level as usize + 1];
    for ((z, y), mut xs) in rows {
        xs.sort_unstable();
        xs.dedup();
        let mut start = xs[0];
        let mut prev = start;
        for x in xs.into_iter().skip(1) {
            if x == prev + 1 { prev = x; continue; }
            levels[z as usize].push(json!({
                "startX": start, "endX": prev, "startY": y, "endY": y
            }));
            start = x;
            prev = x;
        }
        levels[z as usize].push(json!({
            "startX": start, "endX": prev, "startY": y, "endY": y
        }));
    }
    json!(levels)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn geographic_root_has_two_tiles() {
        assert_eq!(tile_range([-180.0, -90.0, 180.0, 90.0], 0), (0, 1, 0, 0));
    }
    #[test]
    fn geographic_y_is_south_origin() {
        assert_eq!(tile_range([116.0, 39.0, 117.0, 40.0], 1), (3, 3, 1, 1));
    }
    #[test]
    fn availability_filters_and_groups() {
        let layer = json!({"available": [[{"startX":1,"endX":1,"startY":0,"endY":0}]]});
        assert!(in_available(&layer, Tile { z:0, x:1, y:0 }));
        assert!(!in_available(&layer, Tile { z:0, x:0, y:0 }));
        let output = availability(&[
            Tile { z:1, x:4, y:1 }, Tile { z:1, x:5, y:1 }
        ], 1);
        assert_eq!(output[1][0]["endX"], 5);
    }
}
