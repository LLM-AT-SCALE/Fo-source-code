/**
 * Shared file utility functions used across components.
 * Consolidates formatFileSize, getFileTypeLabel, and inferMimeType
 * to avoid duplication.
 */

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function getFileTypeLabel(filename: string): string {
  const ext = filename.split(".").pop()?.toUpperCase()
  if (!ext) return "File"
  const typeMap: Record<string, string> = {
    PPTX: "Presentation - PPTX",
    PPT: "Presentation - PPT",
    DOCX: "Document - DOCX",
    DOC: "Document - DOC",
    PDF: "Document - PDF",
    XLSX: "Spreadsheet - XLSX",
    XLS: "Spreadsheet - XLS",
    CSV: "Spreadsheet - CSV",
    PNG: "Image - PNG",
    JPG: "Image - JPG",
    JPEG: "Image - JPEG",
    GIF: "Image - GIF",
    SVG: "Image - SVG",
    TXT: "Text - TXT",
    JSON: "Data - JSON",
    HTML: "Web Page - HTML",
    ZIP: "Archive - ZIP",
  }
  return typeMap[ext] || `File - ${ext}`
}

export function inferMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const mimeMap: Record<string, string> = {
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
    html: 'text/html',
    zip: 'application/zip',
  }
  return mimeMap[ext || ''] || 'application/octet-stream'
}
