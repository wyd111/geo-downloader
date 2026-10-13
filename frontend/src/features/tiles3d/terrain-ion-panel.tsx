import { useEffect, useState } from 'react'
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
import { useSelectionStore } from '@/store/selection-store'
import { useAppStore } from '@/store/app-store'
import { isTauriRuntime } from '@/lib/tauri'
import { analyzeIonTerrain, createIonTerrainTask } from './tiles3d-api'
import type { TerrainIonRequest, TerrainIonSummary } from '@/types/api'

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

export function TerrainIonPanel() {
  const qc = useQueryClient()
  const bounds = useSelectionStore((state) => state.bounds)
  const [assetId, setAssetId] = useState('1')
  const [token, setToken] = useState('')
  const [minLevel, setMinLevel] = useState('0')
  const [maxLevel, setMaxLevel] = useState('12')
  const [saveDir, setSaveDir] = useState('')
  const [taskName, setTaskName] = useState('')
  const [licenseConfirmed, setLicenseConfirmed] = useState(false)
  const [summary, setSummary] = useState<TerrainIonSummary | null>(null)
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

  const makeRequest = (savePath: string, rights: boolean): TerrainIonRequest => {
    if (!bounds) throw new Error('请先在地图中框选需要下载的区域')
    const id = Number(assetId)
    const min = Number(minLevel)
    const max = Number(maxLevel)
    if (!Number.isSafeInteger(id) || id <= 0 || !token.trim()) {
      throw new Error('请填写有效的 ion Asset ID 和 Access Token')
    }
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 16 || min > max) {
      throw new Error('层级范围必须满足 0 ≤ 最低层级 ≤ 最高层级 ≤ 16')
    }
    return {
      asset_id: id,
      access_token: token.trim(),
      bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
      min_level: min,
      max_level: max,
      save_path: savePath,
      concurrency: 8,
      proxy: settings.data?.proxy_enabled ? settings.data?.proxy_url ?? null : null,
      confirm_offline_rights: rights,
    }
  }

  const onAnalyze = async () => {
    setLoading(true)
    setSummary(null)
    try {
      const result = await analyzeIonTerrain(makeRequest(saveDir || '.', false))
      setSummary(result)
      toast.success('地形资产解析完成')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  const onDownload = async () => {
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
      // The active text input still contains the token for this session.
    }
  }

  return (
    <div className="space-y-4">
      <RegionSelector />
      <PanelSection
        icon={Mountain}
        title="Cesium ion Terrain（Quantized Mesh）"
        description="通过 ion Token 解析 layer.json，并按矩形选区下载离线地形瓦片；不适用于 3D Tiles 模型。"
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Terrain Asset ID</Label>
            <Input type="number" min="1" value={assetId} onChange={(event) => setAssetId(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Cesium ion Access Token</Label>
            <Input type="password" value={token} onChange={(event) => setToken(event.target.value)}
              onBlur={() => { void persistToken() }} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>最低层级</Label>
              <Input type="number" min="0" max="16" value={minLevel} onChange={(event) => setMinLevel(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>最高层级（≤16）</Label>
              <Input type="number" min="0" max="16" value={maxLevel} onChange={(event) => setMaxLevel(event.target.value)} />
            </div>
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
            当前版本按选区外接矩形下载，最高支持 16 级、每任务最多 50,000 张瓦片。
            输出 layer.json 与 z/x/y.terrain（TMS）。需要使用可离线授权的资产；
            Cesium World Terrain 在线 Token 不等于离线版权许可。
          </p>
          <label className="flex items-start gap-2 text-xs leading-5">
            <input type="checkbox" checked={licenseConfirmed}
              onChange={(event) => setLicenseConfirmed(event.target.checked)} className="mt-1" />
            <span>我确认对当前资产拥有合法的离线复制和存储权利。</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={loading || !bounds}
              onClick={() => { void onAnalyze() }}>
              {loading ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Search className="mr-1 size-4" />}
              解析 layer.json / 估算瓦片
            </Button>
            <Button type="button" size="sm" disabled={!summary || downloading || !licenseConfirmed}
              onClick={() => { void onDownload() }}>
              {downloading ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Download className="mr-1 size-4" />}
              下载 Terrain
            </Button>
          </div>
          {summary && (
            <div className="rounded-md border p-3 text-xs">
              <p>格式：{summary.format}</p>
              <p>坐标系：{summary.projection} · 源坐标编号：{summary.scheme}</p>
              <p>版本：{summary.version || '未提供'}</p>
              <p>预计瓦片：{summary.estimated_tiles.toLocaleString()}</p>
              <p className="mt-1 text-muted-foreground">修改层级或范围后请重新解析，再下载。</p>
            </div>
          )}
        </div>
      </PanelSection>
    </div>
  )
}
