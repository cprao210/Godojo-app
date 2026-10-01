// Company documents: indexing status, quality report, versions, visibility and the stored
// original (godojo-apis /intelligence/company-assets, contract in the backend's
// docs/document_rag_api.md). Uploading still goes through intelligenceApi.uploadCompanyAsset
// (main process, multipart).

import { apiFetch, getAuthHeaders, API_BASE, ApiError } from "@/lib/apiClient";

export type IndexStatus = "queued" | "processing" | "indexed" | "empty" | "failed" | "unknown";
export type DocumentVisibility = "tenant" | "admins" | "owner";

/** The ingestion quality report (`quality_json`) — only the fields the UI reads. */
export interface DocumentQuality {
  chunks?: number;
  pages_total?: number;
  pages_indexed?: number;
  pages_missing?: number[];
  format_path?: string;
  ocr?: boolean;
  issues?: string[];
  merged_cells_filled?: number;
  injection?: { chunk?: number; page?: number; text?: string }[];
  conflicts?: { asset_id?: string; label?: string; field?: string; this?: string; other?: string }[];
  ambiguous_tables?: number;
}

export interface DocumentStatus {
  asset_id: string;
  status: IndexStatus;
  step?: string | null;
  attempts?: number | null;
  chunks?: number | null;
  error?: string | null;
  version?: number | null;
  pipeline_version?: number | null;
  indexed_at?: string | null;
  visibility?: DocumentVisibility | null;
  is_current?: boolean | null;
  superseded_by?: string | null;
  pages_total?: number | null;
  pages_missing?: number[];
  quality?: DocumentQuality | null;
}

export interface DocumentVersion {
  version: number;
  filename?: string | null;
  mime?: string | null;
  bytes?: number | null;
  pipeline_version?: number | null;
  chunks?: number | null;
  duplicate_of?: string | null;
  created_at?: string | null;
}

const base = (assetId: string) => `/intelligence/company-assets/${encodeURIComponent(assetId)}`;

/** Human-readable warnings for a document's quality report (empty = nothing to flag). */
export function qualityWarnings(s: DocumentStatus | null | undefined): string[] {
  if (!s) return [];
  const q = s.quality || {};
  const out: string[] = [];
  const missing = s.pages_missing?.length ? s.pages_missing : q.pages_missing || [];
  if (s.status === "failed" && s.error) out.push(s.error);
  if (s.status === "empty") out.push("No searchable text was found in this file.");
  if (missing.length) out.push(`Page${missing.length > 1 ? "s" : ""} ${missing.slice(0, 8).join(", ")} produced no searchable text.`);
  if (q.issues?.includes("truncated")) out.push(`Only the first ${q.pages_indexed} of ${q.pages_total} pages were indexed.`);
  if (q.issues?.includes("no_text_layer") || q.ocr) out.push("Scanned file: text was read with OCR — verify figures.");
  if ((q.merged_cells_filled || 0) > 0) out.push("A table has merged cells — verify pricing answers against the page.");
  if ((q.ambiguous_tables || 0) > 0) out.push("Some tables couldn't be read reliably.");
  for (const inj of q.injection || []) {
    out.push(`Page ${inj.page ?? "?"} contains instruction-like text (treated as content, never followed).`);
  }
  for (const c of q.conflicts || []) {
    out.push(`Conflicts with "${c.label ?? "another document"}": ${c.field ?? "value"} is ${c.this ?? "?"} here, ${c.other ?? "?"} there.`);
  }
  if (s.is_current === false) out.push("Superseded by a newer version — used only for questions about the old one.");
  return out;
}

export const documentsApi = {
  status: (assetId: string): Promise<DocumentStatus> =>
    apiFetch<DocumentStatus>(`/intelligence/company-assets/upload/status/${encodeURIComponent(assetId)}`),

  versions: (assetId: string): Promise<DocumentVersion[]> =>
    apiFetch<DocumentVersion[]>(`${base(assetId)}/versions`),

  /** Re-index from the stored original with the current pipeline (202, queued). */
  reindex: (assetId: string): Promise<{ status: string; version: number }> =>
    apiFetch(`${base(assetId)}/reindex`, { method: "POST" }),

  /** Who can see it, or restore a superseded document (`is_current: true`). */
  update: (assetId: string, patch: { visibility?: DocumentVisibility; is_current?: boolean }): Promise<unknown> =>
    apiFetch(base(assetId), { method: "PATCH", body: JSON.stringify(patch) }),

  /** The stored original as bytes (latest, or a given version), for the in-app viewer. Raw fetch:
   *  apiFetch parses JSON. */
  file: async (assetId: string, version?: number): Promise<{ data: ArrayBuffer; mime: string; filename: string }> => {
    const qs = version != null ? `?version=${version}` : "";
    const res = await fetch(`${API_BASE}${base(assetId)}/file${qs}`, { headers: await getAuthHeaders() });
    if (!res.ok) {
      let message = res.status === 404 ? "No stored copy of this document (uploaded before originals were kept)." : `HTTP ${res.status}`;
      try {
        const body = await res.json();
        message = body?.error?.message || body?.detail || message;
      } catch { /* not JSON */ }
      throw new ApiError(res.status, "file_unavailable", message);
    }
    const disp = res.headers.get("content-disposition") || "";
    const filename = /filename="([^"]+)"/.exec(disp)?.[1] || "document";
    return { data: await res.arrayBuffer(), mime: res.headers.get("content-type") || "application/octet-stream", filename };
  },
};
