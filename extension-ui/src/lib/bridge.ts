export type BridgeState = "off" | "idle" | "running"

export type FlowGenerateCapture = {
  videoModelKey?: string
  modelLabel?: string | null
  videoResolution?: string | null
  resolutionLabel?: string | null
  aspectRatio?: string | null
  durationS?: number | null
  count?: number
  capturedAt?: number
}

export type BridgeStatus = {
  connected: boolean
  agentConnected: boolean
  flowKeyPresent: boolean
  manualDisconnect?: boolean
  tokenAge: number | null
  metrics: {
    requestCount: number
    successCount: number
    failedCount: number
    lastError: string | null
  }
  state: BridgeState
  flowGenerate?: FlowGenerateCapture | null
}

export type RequestEntry = {
  id?: string
  type?: string
  method?: string
  time?: string
  timestamp?: string
  createdAt?: string
  status?: string | number
  state?: string
  error?: string
  url?: string
  httpStatus?: number
  payloadSummary?: string
  responseSummary?: string
  opNames?: string[]
}

const TYPE_LABELS: Record<string, string> = {
  GENERATE_IMAGE: "GEN IMAGE",
  REGENERATE_IMAGE: "REGEN IMAGE",
  EDIT_IMAGE: "EDIT IMAGE",
  GENERATE_CHARACTER_IMAGE: "GEN REF",
  REGENERATE_CHARACTER_IMAGE: "REGEN REF",
  EDIT_CHARACTER_IMAGE: "EDIT REF",
  GENERATE_VIDEO: "GEN VIDEO",
  GENERATE_VIDEO_REFS: "GEN VIDEO FROM REFS",
  UPSCALE_VIDEO: "UPSCALE VIDEO",
  IMAGE_GENERATION: "GEN IMAGE",
  VIDEO_GENERATION: "GEN VIDEO",
  GEN_IMG: "GEN IMAGE",
  GEN_VID: "GEN VIDEO",
  GEN_VID_REF: "GEN VIDEO FROM REFS",
  UPSCALE: "UPSCALE VIDEO",
  UPS_IMG: "UPSCALE IMAGE",
  POLL: "CHECK GEN VIDEO",
  CREDITS: "CHECK CREDIT",
  CREATE_PROJECT: "CREATE PROJECT",
  UPLOAD: "UPLOAD IMAGE",
  MEDIA: "READ MEDIA",
  TRACKING: "GOOGLE FLOW TRACK",
  URL_REFRESH: "URL REFRESH",
  TRPC: "TRPC",
  API: "API",
}

export function formatType(type?: string) {
  if (!type) return "—"
  return TYPE_LABELS[type] || type.slice(0, 12).toUpperCase()
}

export function formatTime(iso?: string) {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  } catch {
    return "—"
  }
}

export function jobStatus(entry: RequestEntry): "success" | "failed" | "processing" | "sent" {
  const status = entry.status ?? entry.state ?? "pending"
  if (status === "COMPLETED" || status === "success") return "success"
  if (status === "FAILED" || status === "failed" || (typeof status === "number" && status >= 400)) {
    return "failed"
  }
  if (status === "PROCESSING" || status === "processing") return "processing"
  return "sent"
}

export function sendMessage<T = unknown>(msg: { type: string }): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      reject(new Error("chrome.runtime unavailable"))
      return
    }
    chrome.runtime.sendMessage(msg, (data) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      resolve(data as T)
    })
  })
}

export async function fetchCredits(): Promise<string | null> {
  try {
    const res = await fetch("http://127.0.0.1:8100/api/flow/credits")
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    const remaining =
      data.credits ??
      data.remainingCredits ??
      data.creditCount ??
      (data.userCredits as Record<string, unknown> | undefined)?.remaining
    const paygate = String(data.userPaygateTier ?? data.tier ?? "")
    const sku = String(data.sku ?? "")
    const service = String(data.serviceTier ?? "")
    const blob = `${paygate} ${sku} ${service}`
    const free = /NOT_PAID|FREEMIUM|ENTRY/i.test(blob)
    const plus = /TIER1P5|G1_TIER1P5/i.test(blob)
    const tier = paygate.replace(/^PAYGATE_/, "")
    if (remaining == null && !tier && !sku) return null
    const bits = []
    if (free) bits.push("Free")
    else if (plus) bits.push("Plus")
    else if (tier) bits.push(tier.replaceAll("_", " "))
    if (remaining != null) bits.push(`${remaining} credits`)
    return bits.join(" · ")
  } catch {
    return null
  }
}
