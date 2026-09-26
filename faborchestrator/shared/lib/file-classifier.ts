// File classification utility for mapping filenames to rendering strategies

export type RenderStrategy =
  | 'sandpack'
  | 'iframe-html'
  | 'syntax-highlight'
  | 'image-preview'
  | 'pdf-preview'
  | 'docx-preview'
  | 'xlsx-preview'
  | 'pptx-preview'
  | 'binary-download'
  | 'markdown-render'
  | 'mermaid-diagram'

export interface FileClassification {
  strategy: RenderStrategy
  language?: string
  sandpackTemplate?: 'react' | 'react-ts' | 'vanilla' | 'vanilla-ts'
  artifactType: 'html' | 'code'
}

const SANDPACK_EXTENSIONS: Record<string, { language: string; template: 'react' | 'react-ts' }> = {
  '.jsx': { language: 'javascript', template: 'react' },
  '.tsx': { language: 'typescript', template: 'react-ts' },
}

const HTML_EXTENSIONS = new Set(['.html', '.htm'])

const SYNTAX_EXTENSIONS: Record<string, string> = {
  '.py': 'python',
  '.js': 'javascript',
  '.ts': 'typescript',
  '.css': 'css',
  '.json': 'json',
  '.txt': 'plaintext',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.sh': 'bash',
  '.bash': 'bash',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.r': 'r',
  '.lua': 'lua',
  '.toml': 'toml',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.env': 'plaintext',
  '.log': 'plaintext',
  '.csv': 'plaintext',
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'])

const PDF_EXTENSIONS = new Set(['.pdf'])
const DOCX_EXTENSIONS = new Set(['.docx'])
const XLSX_EXTENSIONS = new Set(['.xlsx', '.xls'])
const PPTX_EXTENSIONS = new Set(['.pptx'])

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return ''
  return filename.substring(dot).toLowerCase()
}

export function classifyFile(filename: string, mimeType?: string): FileClassification {
  const ext = getExtension(filename)

  // Check MIME type hints for ambiguous cases
  if (mimeType?.startsWith('image/')) {
    return { strategy: 'image-preview', artifactType: 'code' }
  }

  // Sandpack (live React preview)
  if (ext in SANDPACK_EXTENSIONS) {
    const info = SANDPACK_EXTENSIONS[ext]
    return {
      strategy: 'sandpack',
      language: info.language,
      sandpackTemplate: info.template,
      artifactType: 'code',
    }
  }

  // HTML iframe preview
  if (HTML_EXTENSIONS.has(ext)) {
    return { strategy: 'iframe-html', language: 'html', artifactType: 'html' }
  }

  // Markdown rendered preview
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') {
    return { strategy: 'markdown-render', language: 'markdown', artifactType: 'code' }
  }

  // Syntax-highlighted code view
  if (ext in SYNTAX_EXTENSIONS) {
    return {
      strategy: 'syntax-highlight',
      language: SYNTAX_EXTENSIONS[ext],
      artifactType: 'code',
    }
  }

  // Image preview
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { strategy: 'image-preview', artifactType: 'code' }
  }

  // Document previews
  if (PDF_EXTENSIONS.has(ext)) {
    return { strategy: 'pdf-preview', artifactType: 'code' }
  }
  if (DOCX_EXTENSIONS.has(ext)) {
    return { strategy: 'docx-preview', artifactType: 'code' }
  }
  if (XLSX_EXTENSIONS.has(ext)) {
    return { strategy: 'xlsx-preview', artifactType: 'code' }
  }
  if (PPTX_EXTENSIONS.has(ext)) {
    return { strategy: 'pptx-preview', artifactType: 'code' }
  }

  // MIME-type fallbacks for documents
  if (mimeType === 'application/pdf') {
    return { strategy: 'pdf-preview', artifactType: 'code' }
  }

  // Check MIME type fallbacks for text
  if (mimeType?.startsWith('text/')) {
    return { strategy: 'syntax-highlight', language: 'plaintext', artifactType: 'code' }
  }

  // Everything else: binary download
  return { strategy: 'binary-download', artifactType: 'code' }
}

export function isPreviewableFile(_filename: string, _mimeType?: string): boolean {
  // All files are previewable — binary files show download UI within the artifact panel
  return true
}

export function getFileExtensionLabel(filename: string): string {
  const ext = getExtension(filename)
  return ext ? ext.substring(1).toUpperCase() : 'FILE'
}
