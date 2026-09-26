import { z } from 'zod';
import { classifyFile, type RenderStrategy } from '@/shared/lib/file-classifier';

// Artifact types
const ARTIFACT_TYPES = [
  'html',
  'code',
] as const;

// Artifact schema
export const ArtifactSchema = z.object({
  id: z.string(),
  type: z.enum(ARTIFACT_TYPES),
  title: z.string(),
  content: z.string(),
  language: z.string().optional(),
});

// Extended Artifact type with file fields
export type Artifact = z.infer<typeof ArtifactSchema> & {
  source?: 'file' | 'tag'
  fileId?: string
  filename?: string
  mimeType?: string
  sizeBytes?: number
  /**
   * Where to fetch the bytes from. Defaults to the Anthropic Files API
   * (`/api/files/<fileId>/download`). The Modeling Agent's generated .xlsx
   * files live in its own staging store, so they pass their own endpoint here.
   */
  downloadUrl?: string
  contentLoaded?: boolean
  renderStrategy?: RenderStrategy
  sandpackTemplate?: 'react' | 'react-ts' | 'vanilla' | 'vanilla-ts'
  antArtifactId?: string
};

// Create an artifact from a file download part
export function createFileArtifact(fileData: {
  fileId: string
  filename: string
  mimeType?: string
  sizeBytes?: number
  downloadUrl?: string
}): Artifact {
  const classification = classifyFile(fileData.filename, fileData.mimeType)
  return {
    id: `file-artifact-${fileData.fileId}`,
    type: classification.artifactType,
    title: fileData.filename,
    content: '', // content loaded lazily
    language: classification.language,
    source: 'file',
    fileId: fileData.fileId,
    filename: fileData.filename,
    mimeType: fileData.mimeType,
    sizeBytes: fileData.sizeBytes,
    downloadUrl: fileData.downloadUrl,
    contentLoaded: false,
    renderStrategy: classification.strategy,
    sandpackTemplate: classification.sandpackTemplate,
  }
}

// Get file extension for artifact type
export function getArtifactExtension(artifact: Artifact): string {
  if (artifact.source === 'tag') {
    switch (artifact.renderStrategy) {
      case 'sandpack': return '.jsx';
      case 'markdown-render': return '.md';
      case 'mermaid-diagram': return '.mermaid';
      case 'iframe-html':
        return artifact.language === 'xml' ? '.svg' : '.html';
      default: return '.html';
    }
  }
  switch (artifact.type) {
    case 'html':
      return '.html';
    case 'code':
      switch (artifact.language) {
        case 'typescript':
        case 'tsx':
          return '.tsx';
        case 'javascript':
        case 'jsx':
          return '.jsx';
        case 'python':
          return '.py';
        case 'go':
          return '.go';
        case 'rust':
          return '.rs';
        case 'java':
          return '.java';
        case 'c':
          return '.c';
        case 'cpp':
          return '.cpp';
        case 'csharp':
          return '.cs';
        case 'ruby':
          return '.rb';
        case 'php':
          return '.php';
        case 'swift':
          return '.swift';
        case 'kotlin':
          return '.kt';
        case 'sql':
          return '.sql';
        case 'shell':
        case 'bash':
          return '.sh';
        default:
          return '.js';
      }
    default:
      return '.html';
  }
}

// Get MIME type for artifact
export function getArtifactMimeType(artifact: Artifact): string {
  if (artifact.source === 'tag') {
    switch (artifact.renderStrategy) {
      case 'sandpack': return 'text/javascript';
      case 'markdown-render': return 'text/markdown';
      case 'mermaid-diagram': return 'text/plain';
      case 'iframe-html':
        return artifact.language === 'xml' ? 'image/svg+xml' : 'text/html';
      default: return 'text/html';
    }
  }
  switch (artifact.type) {
    case 'html':
      return 'text/html';
    case 'code':
    default:
      return 'text/plain';
  }
}
