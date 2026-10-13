import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Download, FolderOpen, Loader2, Mountain, Search } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PanelSection } from '@/components/layout/panel-section'
import { RegionSelector } from '@/features/region/region-selector'
import { getSettings, saveSettings } from '@/features/settings/settings-api'
import { useSelectionStore, type MapBounds } from '@/store/selection-store'
import { useAppStore } from '@/store/app-store'
import { isTauriRuntime } from '@/lib/tauri'
import { analyzeIonTerrain, createIonTerrainTask } from './tiles3d-api'
import type { TerrainIonRequest, TerrainIonSummary } from '@/types/api'

const ZOOM_LEVELS = Array.from({ length: 17 }, (_, i) => i)
const DEFAULT_LEVELS = ZOOM_LEVELS.filter((z) => z <= 12)

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GiB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + ' MiB'
  return (bytes / 1024).toFixed(1) + ' KiB'
}

function textFromBounds(b: MapBounds | null): Record<keyof MapBounds, string> {
  return {
    north: b?.north?.toString() ?? '',
    south: b?.south?.toString() ?? '',
    west: b?.west?.toString() ?? '',
    east: b?.east?.toString() ?? '',
  }
}

function parseBounds(text: Record<keyof MapBounds, string>): MapBounds | null {
  if (Object.values(text).some((s) => !s.trim())) return null
  const north = Number(text.north)
  const south = Number(text.south)
  const west = Number(text.west)
  const east = Number(text.east)
  if (![north, south, west, east].every(Number.isFinite) ||
    north > 90 || south < -90 || west < -180 || east > 180 ||
    north <= south || east <= west) return null
  return { north, south, west, east }
}

/** GeographicTilingScheme (2x1 at z0), before checking layer.json availability. */
function geometricTileCount(bounds: MapBounds, levels: number[]): number {
  let total = 0
  for (const z of levels) {
    const columns = 2 ** (z + 1)
    const rows = 2 ** z
    const x0 = Math.max(0, Math.floor((bounds.west + 180) / 360 * columns))
    const x1 = Math.min(columns - 1, Math.max(0, Math.floor((bounds.east + 180) / 360 * columns - 1e-10)))
    const y0 = Math.max(0, Math.floor((bounds.south + 90) / 180 * rows))
    const y1 = Math.min(rows - 1, Math.max(0, Math.floor((bounds.north + 90) / 180 * rows - 1e-10)))
    total += (x1 - x0 + 1) * (y1 - y0 + 1)
  }
  return total
}

export function TerrainIonPanel() {
  const qc = useQueryClient()
  const mapBounds = useSelectionStore((state) => state.bounds)
  const setBoundsFromInputs = useSelectionStore((state) => state.setBoundsFromInputs)
  const [boundsText, setBoundsText] = useState(() => textFromBounds(mapBounds))
  const [assetId, setAssetId] = useState('1')
  const [token, setToken] = useState('')
  const [levels, setLevels] = useState<number[]>(DEFAULT_LEVELS)
  const [saveDir, setSaveDir] = useState('')
  const [taskName, setTaskName] = useState('')
  const [licenseConfirmed, setLicenseConfirmed] = useState(false)
  const [analysis, setAnalysis] = useState<{ key: string; data: TerrainIonSummary } | null>(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    enabled: isTauriRuntime(),
  })

  useEffect(() => {
    const configuredToken = settings.data?.cesium_ion_token
    if (configuredToken && !token) setToken(configuredToken)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data?.cesium_ion_token])

  // Map rectangle, imported GeoJSON and saved region all flow into these inputs.
  useEffect(() => { setBoundsText(textFromBounds(mapBounds)) }, [
    mapBounds?.north, mapBounds?.south, mapBounds?.west, mapBounds?.east,
  ])

  const bounds = useMemo(() => parseBounds(boundsText), [boundsText])
  const sortedLevels = useMemo(() => [...levels].sort((a, b) => a - b), [levels])
  // Includes all parameters that determine the estimate so stale estimates cannot be downloaded.
  const queryKey = useMemo(() => JSON.stringify([
    assetId, token, bounds?.north, bounds?.south, bounds?.west, bounds?.east,
    sortedLevels, settings.data?.proxy_enabled, settings.data?.proxy_url,
  ]), [assetId, token, bounds, sortedLevels, settings.data?.proxy_enabled, settings.data?.proxy_url])
  const summary = analysis?.key === queryKey ? analysis.data : null
  const roughTiles = bounds && sortedLevels.length ? geometricTileCount(bounds, sortedLevels) : 0

  const applyBounds = (): boolean => {
    if (!bounds) {
      toast.error('请输入有效经纬度（经度 -180～180，纬度 -90～90，北>南、东>西）')
      return false
    }
    setBoundsFromInputs(bounds)
    return true
  }

  const makeRequest = (savePath: string, rights: boolean): TerrainIonRequest => {
    if (!bounds) throw new Error('请在地图框选区域，或输入完整的东、西、南、北经纬度')
    const id = Number(assetId)
    if (!Number.isSafeInteger(id) || id <= 0 || !token.trim()) {
      throw new Error('请填写有效的 ion Asset ID 和 Access Token')
    }
    if (!sortedLevels.length) throw new Error('请至少选择一个地形层级')
    return {
      asset_id: id,
      access_token: token.trim(),
      bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
      min_level: sortedLevels[0],
      max_level: sortedLevels[sortedLevels.length - 1],
      zoom_levels: sortedLevels,
      save_path: savePath,
      concurrency: 8,
      proxy: settings.data?.proxy_enabled ? settings.data?.proxy_url ?? null : null,
      confirm_offline_rights: rights,
    }
  }

  const onAnalyze = async () => {
    setLoading(true)
    setAnalysis(null)
    try {
      const key = queryKey
      const request = makeRequest(saveDir.trim() || '.', false)
      // Synchronize the interactive map with a manually-entered rectangle.
      setBoundsFromInputs(bounds!)
      const result = await analyzeIonTerrain(request)
      setAnalysis({ key, data: result })
      toast.success('地形解析和容量估算完成')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  const onDownload = async () => {
    if (!summary) {
      toast.error('区域或层级已变化，请重新解析和估算')
      return
    }
    if (!licenseConfirmed) {
      toast.error('请先确认该资产具有离线下载授权')
      return
    }
    setDownloading(true)
    try {
      let root = saveDir.trim()
      if (!root) {
        const selected = await openDialog({
          directory: true,
          title: '选择 Quantized Mesh 地形输出目录',
        })
        if (!selected) return
        root = String(selected)
        setSaveDir(root)
      }
      const sub = 'terrain_' + assetId + '_' + stamp()
      const sep = root.includes('\\') ? '\\' : '/'
      const savePath = root.replace(/[\\/]$/, '') + sep + sub
      const result = await createIonTerrainTask(
        makeRequest(savePath, true),
        taskName.trim() || sub,
      )
      toast.success('已创建地形下载任务：' + result.tile_count + ' 个瓦片')
      useAppStore.getState().setTab('history')
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloading(false)
    }
  }

  const persistToken = async () => {
    if (!settings.data || settings.data.cesium_ion_token === token.trim()) return
    try {
      await saveSettings({ ...settings.data, cesium_ion_token: token.trim() || null })
      qc.invalidateQueries({ queryKey: ['settings'] })
    } catch {
      // Input remains usable in this session even if persistence fails.
    }
  }

  const toggleLevel = (z: number) => {
    setLevels((current) => current.includes(z)
      ? current.filter((value) => value !== z)
      : [...current, z].sort((a, b) => a - b))
  }
  const setRange = (from: number, to: number) => {
    setLevels(ZOOM_LEVELS.filter((z) => z >= from && z <= to))
  }

  return (
    <div className="space-y-4">
      <RegionSelector />
      <PanelSection
        icon={Mountain}
        title="Cesium ion Terrain（Quantized Mesh）"
        description="与 GeoTIFF 下载使用同一个区域选择器；支持手填经纬度、单独勾选层级和预估容量。"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>下载范围（WGS84 经纬度）</Label>
            <div className="grid grid-cols-2 gap-2">
              {([
                ['north', '北纬 / 北边界'],
                ['south', '南纬 / 南边界'],
                ['west', '西经 / 西边界'],
                ['east', '东经 / 东边界'],
              ] as const).map(([key, label]) => (
                <div key={key} className="space-y-1">
                  <Label className="text-xs" htmlFor={'terrain-bounds-' + key}>{label}</Label>
                  <Input
                    id={'terrain-bounds-' + key}
                    type="number"
                    step="0.000001"
                    value={boundsText[key]}
                    onChange={(event) => setBoundsText((old) => ({ ...old, [key]: event.target.value }))}
                    className="h-8 font-mono text-xs"
                    placeholder="十进制度"
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className={'text-xs ' + (bounds ? 'text-muted-foreground' : 'text-amber-600')}>
                {bounds ? '也可在地图框选或导入行政区，输入值会同步。' : '请输入完整且有效的经纬度范围。'}
              </p>
              <Button type="button" size="sm" variant="outline" onClick={() => { void applyBounds() }}
                disabled={!bounds}>应用到地图</Button>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Terrain Asset ID</Label>
            <Input type="number" min="1" value={assetId} onChange={(event) => setAssetId(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Cesium ion Access Token</Label>
            <Input type="password" value={token} onChange={(event) => setToken(event.target.value)}
              onBlur={() => { void persistToken() }} />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>下载层级（多选）</Label>
              <span className="text-xs text-muted-foreground">
                {sortedLevels.length} 级
                {sortedLevels.length ? ' · z' + sortedLevels[0] + '～z' + sortedLevels[sortedLevels.length - 1] : ''}
              </span>
            </div>
            <div className="grid grid-cols-9 gap-1">
              {ZOOM_LEVELS.map((z) => (
                <button key={z} type="button" aria-pressed={levels.includes(z)} onClick={() => toggleLevel(z)}
                  className={'h-8 rounded border text-xs transition ' + (levels.includes(z)
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background hover:bg-muted')}>
                  {z}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {([
                [0, 8], [8, 12], [10, 14], [12, 16], [0, 16],
              ] as const).map(([from, to]) => (
                <button key={from + '-' + to} type="button" onClick={() => setRange(from, to)}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted">
                  z{from}～{to}
                </button>
              ))}
              <button type="button" onClick={() => setLevels([])}
                className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted">清空</button>
            </div>
            <p className="text-xs text-muted-foreground">
              地形层级与 GeoTIFF 影像层级含义不同；如果跳过低级父瓦片，离线加载可能不完整。
            </p>
          </div>

          <div className="space-y-2 rounded-md border p-3" aria-live="polite">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">下载估算</span>
              <span className="text-xs text-muted-foreground">
                {summary ? '已解析源 layer.json' : '区域几何预估 · 未解析源数据'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-muted-foreground">预计瓦片数</div>
                <div className="text-lg font-semibold">
                  {summary ? summary.estimated_tiles.toLocaleString() : roughTiles.toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">预计下载 / 磁盘大小</div>
                <div className="text-lg font-semibold">
                  {summary ? formatBytes(summary.estimated_bytes) : '待解析'}
                </div>
              </div>
              {summary && (
                <>
                  <div>
                    <div className="text-xs text-muted-foreground">平均单瓦片体积</div>
                    <div className="text-sm font-medium">{formatBytes(summary.average_tile_bytes)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">下载任务缓冲内存（粗估）</div>
                    <div className="text-sm font-medium">{formatBytes(summary.estimated_task_buffer_bytes)}</div>
                  </div>
                </>
              )}
            </div>
            {summary ? (
              <>
                <p className="text-xs text-muted-foreground">
                  估算依据：{summary.estimate_method === 'content-length-sample'
                    ? '抽样瓦片的 HTTP Content-Length，实际体积因地形复杂度和缺块变化。'
                    : '源站无法提供 Content-Length，按 64 KiB/瓦片粗估，误差可能较大。'}
                  下载流量和磁盘体积均为预测值；缓冲内存不含程序基础内存。
                </p>
                <div className="flex flex-wrap gap-1">
                  {summary.level_tiles.map((entry) => (
                    <span key={entry.level} className="rounded bg-muted px-2 py-1 text-xs">
                      z{entry.level}: {entry.tiles.toLocaleString()} 张
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {summary.format} · {summary.projection} · {summary.scheme}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                当前数量按 GeographicTilingScheme 几何范围计算，尚未扣除 layer.json 中不可用瓦片；
                点击「解析并估算」后获取更准确的瓦片数量和体积估算。
              </p>
            )}
            {roughTiles > 50_000 && (
              <p className="text-xs text-amber-600">选区按几何计算已超过 50,000 张，建议缩小范围或降低层级。</p>
            )}
          </div>

          <div className="space-y-1">
            <Label>任务名称（可选）</Label>
            <Input value={taskName} onChange={(event) => setTaskName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>保存目录</Label>
            <div className="flex gap-2">
              <Input className="font-mono text-xs" value={saveDir} onChange={(event) => setSaveDir(event.target.value)} />
              <Button variant="outline" size="icon" type="button" title="选择目录" onClick={async () => {
                const selected = await openDialog({ directory: true })
                if (selected) setSaveDir(String(selected))
              }}>
                <FolderOpen className="size-4" />
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            按选区外接矩形下载，最高 16 级、最多 50,000 张瓦片。
            输出 layer.json 与 z/x/y.terrain（TMS）。
            Cesium World Terrain 的在线 Token 不代表拥有离线版权许可。
          </p>
          <label className="flex items-start gap-2 text-xs leading-5">
            <input type="checkbox" checked={licenseConfirmed}
              onChange={(event) => setLicenseConfirmed(event.target.checked)} className="mt-1" />
            <span>我确认对当前资产拥有合法的离线复制和存储权利。</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={loading || !bounds || !sortedLevels.length}
              onClick={() => { void onAnalyze() }}>
              {loading ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Search className="mr-1 size-4" />}
              解析并估算瓦片 / 容量
            </Button>
            <Button type="button" size="sm" disabled={!summary || downloading || !licenseConfirmed}
              onClick={() => { void onDownload() }}>
              {downloading ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Download className="mr-1 size-4" />}
              下载 Terrain
            </Button>
          </div>
        </div>
      </PanelSection>
    </div>
  )
}
