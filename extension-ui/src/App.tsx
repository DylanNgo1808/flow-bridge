import { useCallback, useEffect, useState } from "react"
import { Check, ExternalLink, Loader2, RefreshCw, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  fetchCredits,
  formatTime,
  formatType,
  jobStatus,
  sendMessage,
  type BridgeStatus,
  type FlowGenerateCapture,
  type RequestEntry,
} from "@/lib/bridge"
import { cn } from "@/lib/utils"

const emptyStatus: BridgeStatus = {
  connected: false,
  agentConnected: false,
  flowKeyPresent: false,
  tokenAge: null,
  metrics: { requestCount: 0, successCount: 0, failedCount: 0, lastError: null },
  state: "off",
  flowGenerate: null,
}

function flowGenerateCopy(cap?: FlowGenerateCapture | null) {
  if (!cap?.modelLabel && !cap?.videoModelKey) return null
  const bits = [
    cap.modelLabel || cap.videoModelKey,
    cap.resolutionLabel,
    cap.durationS ? `${cap.durationS}s` : null,
    cap.count && cap.count > 1 ? `x${cap.count}` : null,
  ].filter(Boolean)
  return bits.join(" · ")
}

function tokenCopy(status: BridgeStatus) {
  if (!status.flowKeyPresent) return "no token"
  const ageMs = status.tokenAge || 0
  if (ageMs > 3_600_000) return "token expired — open Flow to refresh"
  const ageMin = Math.round(ageMs / 60_000)
  return `token synced ${ageMin}m`
}

function StatusBadge({ entry }: { entry: RequestEntry }) {
  const s = jobStatus(entry)
  if (s === "success") {
    return (
      <Badge variant="success">
        <Check />
        done
      </Badge>
    )
  }
  if (s === "failed") {
    return (
      <Badge variant="destructive">
        <X />
        fail
      </Badge>
    )
  }
  return (
    <Badge variant="warning">
      <Loader2 className="animate-spin" />
      {s === "processing" ? "gen…" : "sent"}
    </Badge>
  )
}

export default function App() {
  const [status, setStatus] = useState<BridgeStatus>(emptyStatus)
  const [log, setLog] = useState<RequestEntry[]>([])
  const [credits, setCredits] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<RequestEntry | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const data = await sendMessage<BridgeStatus>({ type: "STATUS" })
      if (data) setStatus({ ...emptyStatus, ...data, metrics: { ...emptyStatus.metrics, ...data.metrics } })
    } catch {
      /* side panel can open before the worker is ready */
    }
  }, [])

  const loadLog = useCallback(async () => {
    try {
      const data = await sendMessage<{ log: RequestEntry[] }>({ type: "REQUEST_LOG" })
      if (data?.log) setLog(data.log)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    void loadLog()
    void fetchCredits().then(setCredits)

    const onMessage = (msg: { type?: string; log?: RequestEntry[] }) => {
      if (msg.type === "STATUS_PUSH") void loadStatus()
      if (msg.type === "REQUEST_LOG_UPDATE" && msg.log) setLog(msg.log)
    }
    chrome.runtime?.onMessage.addListener(onMessage)
    const tick = window.setInterval(() => {
      void loadStatus()
      void loadLog()
    }, 4000)
    return () => {
      chrome.runtime?.onMessage.removeListener(onMessage)
      window.clearInterval(tick)
    }
  }, [loadLog, loadStatus])

  useEffect(() => {
    const ageMs = status.tokenAge || 0
    if (status.flowKeyPresent && status.agentConnected && ageMs > 3_300_000) {
      void sendMessage({ type: "REFRESH_TOKEN" }).catch(() => undefined)
    }
  }, [status.agentConnected, status.flowKeyPresent, status.tokenAge])

  const isOn = status.state !== "off"
  const connected = status.agentConnected
  const st = status.state || "off"
  const token = tokenCopy(status)
  const tokenTone =
    !status.flowKeyPresent ? "bad" : (status.tokenAge || 0) > 3_600_000 ? "warn" : "ok"

  async function toggleBridge(next: boolean) {
    await sendMessage({ type: next ? "RECONNECT" : "DISCONNECT" }).catch(() => undefined)
    window.setTimeout(() => void loadStatus(), 400)
  }

  async function openFlow() {
    await sendMessage({ type: "OPEN_FLOW_TAB" }).catch(() => undefined)
  }

  async function refreshToken() {
    setRefreshing(true)
    await sendMessage({ type: "REFRESH_TOKEN" }).catch(() => undefined)
    window.setTimeout(() => {
      void loadStatus()
      void fetchCredits().then(setCredits)
      setRefreshing(false)
    }, 800)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-x-hidden bg-background">
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            connected ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" : "bg-destructive"
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium tracking-tight">Flow Bridge</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {credits || "internal"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
            {isOn ? "On" : "Off"}
          </span>
          <Switch checked={isOn} onCheckedChange={toggleBridge} aria-label="Connect agent" />
        </div>
      </header>

      <div className="grid grid-cols-3 divide-x border-b">
        <Metric label="Total" value={status.metrics.requestCount} />
        <Metric label="Success" value={status.metrics.successCount} tone="ok" />
        <Metric label="Failed" value={status.metrics.failedCount} tone="bad" />
      </div>

      {flowGenerateCopy(status.flowGenerate) ? (
        <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px]">
          <span className="tracking-wide text-muted-foreground uppercase">Flow</span>
          <span className="truncate text-foreground">{flowGenerateCopy(status.flowGenerate)}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="tracking-wide uppercase">State</span>
        <Badge
          variant={st === "idle" ? "success" : st === "running" ? "warning" : "outline"}
          className="uppercase"
        >
          {st}
        </Badge>
        <span
          className={cn(
            "ml-auto truncate",
            tokenTone === "ok" && "text-emerald-400",
            tokenTone === "warn" && "text-amber-400",
            tokenTone === "bad" && "text-destructive"
          )}
        >
          {token}
        </span>
      </div>

      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-[10px] tracking-wide text-muted-foreground uppercase">Request log</span>
        <Badge variant="outline">{log.length}</Badge>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {log.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-muted-foreground">No requests yet</div>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.map((entry) => {
                const id = entry.id ? String(entry.id).slice(0, 8) : "—"
                const err = entry.error || ""
                return (
                  <TableRow
                    key={entry.id || `${entry.type}-${entry.time}`}
                    className="cursor-pointer"
                    onClick={() => setSelected(entry)}
                  >
                    <TableCell className="font-mono text-[11px] text-primary underline-offset-2 hover:underline">
                      {id}
                    </TableCell>
                    <TableCell className="font-medium tracking-wide text-primary">
                      {formatType(entry.type || entry.method)}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatTime(entry.time || entry.timestamp || entry.createdAt)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge entry={entry} />
                    </TableCell>
                    <TableCell
                      className={cn(
                        "max-w-[7rem] truncate",
                        err ? "text-destructive" : "text-muted-foreground"
                      )}
                      title={err || undefined}
                    >
                      {err ? err : "—"}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </ScrollArea>

      <div className="flex gap-2 border-t p-3">
        <Button className="flex-1" onClick={openFlow}>
          Open Flow Tab
          <ExternalLink data-icon="inline-end" />
        </Button>
        <Button variant="outline" className="flex-1" onClick={refreshToken} disabled={refreshing}>
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {refreshing ? "Opening…" : "Refresh Token"}
        </Button>
      </div>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Request {selected?.id ? String(selected.id).slice(0, 12) : ""}
            </DialogTitle>
            <DialogDescription>{formatType(selected?.type || selected?.method)}</DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="grid max-h-[50vh] gap-2 overflow-y-auto text-xs">
              {[
                ["ID", selected.id || "—"],
                ["Type", formatType(selected.type || selected.method)],
                ["Time", formatTime(selected.time || selected.timestamp || selected.createdAt)],
                ["Status", String(selected.status ?? selected.state ?? "pending")],
                ["HTTP", String(selected.httpStatus ?? "—")],
                ["URL", selected.url || "—"],
                ["Payload", selected.payloadSummary || "—"],
                ["Response", selected.responseSummary || "—"],
                ["Error", selected.error || "—"],
              ].map(([label, value]) => (
                <div key={label} className="grid gap-0.5">
                  <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</div>
                  <div
                    className={cn(
                      "rounded-md bg-secondary/60 px-2 py-1.5 break-all",
                      label === "Error" && value !== "—" && "text-destructive",
                      label === "Status" && (value === "success" || value === "COMPLETED") && "text-emerald-400"
                    )}
                  >
                    {value}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: "ok" | "bad"
}) {
  return (
    <div className="px-2 py-2.5 text-center">
      <div
        className={cn(
          "text-xl font-semibold tabular-nums",
          tone === "ok" && "text-emerald-400",
          tone === "bad" && value > 0 && "text-destructive"
        )}
      >
        {value}
      </div>
      <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</div>
    </div>
  )
}
