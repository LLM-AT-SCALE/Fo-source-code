// Parser for <antArtifact> tags emitted by Claude models
// Pure functions — no React dependencies

import type { Artifact } from '@/shared/lib/artifacts'
import type { RenderStrategy } from '@/shared/lib/file-classifier'

// --- Types ---

interface ParsedTag {
  identifier: string
  type: string
  title: string
  content: string
  isStreaming: boolean // true if tag is not yet closed
}

interface ArtifactStrategy {
  artifactType: 'html' | 'code'
  renderStrategy: RenderStrategy
  language?: string
  sandpackTemplate?: 'react' | 'react-ts'
  fileExtension: string
  mimeType: string
}

export interface ExtractResult {
  cleanedText: string
  artifacts: Artifact[]
  hasStreamingArtifact: boolean
}

// --- Attribute parsing ---

function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /(\w+)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(attrString)) !== null) {
    attrs[match[1]] = match[2]
  }
  return attrs
}

// --- Type mapping ---

function mapArtifactTypeToStrategy(tagType: string): ArtifactStrategy {
  switch (tagType) {
    case 'application/vnd.ant.react':
    case 'application/react':
      return {
        artifactType: 'code',
        renderStrategy: 'sandpack',
        language: 'javascript',
        sandpackTemplate: 'react',
        fileExtension: '.jsx',
        mimeType: 'text/javascript',
      }
    case 'text/markdown':
      return {
        artifactType: 'code',
        renderStrategy: 'markdown-render',
        language: 'markdown',
        fileExtension: '.md',
        mimeType: 'text/markdown',
      }
    case 'text/mermaid':
      return {
        artifactType: 'code',
        renderStrategy: 'mermaid-diagram',
        language: 'mermaid',
        fileExtension: '.mermaid',
        mimeType: 'text/plain',
      }
    case 'image/svg+xml':
      return {
        artifactType: 'html',
        renderStrategy: 'iframe-html',
        language: 'xml',
        fileExtension: '.svg',
        mimeType: 'image/svg+xml',
      }
    case 'text/html':
    default:
      return {
        artifactType: 'html',
        renderStrategy: 'iframe-html',
        language: 'html',
        fileExtension: '.html',
        mimeType: 'text/html',
      }
  }
}

// --- Tag → Artifact ---

function tagToArtifact(tag: ParsedTag): Artifact {
  const strategy = mapArtifactTypeToStrategy(tag.type)
  return {
    id: `tag-artifact-${tag.identifier}`,
    type: strategy.artifactType,
    title: tag.title || tag.identifier,
    content: tag.content,
    language: strategy.language,
    source: 'tag',
    antArtifactId: tag.identifier,
    renderStrategy: strategy.renderStrategy,
    sandpackTemplate: strategy.sandpackTemplate,
  }
}

// --- Regex-based extraction ---

// Accept both </antArtifact> and </artifact> as closing tags (models sometimes shorten it)
const COMPLETE_TAG_RE = /<antArtifact\s+([^>]*?)>([\s\S]*?)<\/(?:antArtifact|artifact)>/g
const PARTIAL_TAG_RE = /<antArtifact\s+([^>]*?)>([\s\S]*)$/

// Placeholder inserted into cleaned text for each artifact
const PLACEHOLDER_PREFIX = '**\u{1F4CE} '
const PLACEHOLDER_SUFFIX = '**'

export function extractTagArtifacts(text: string): ExtractResult {
  // Fast path: skip regex for messages without artifact tags
  if (!text.includes('<antArtifact')) {
    return { cleanedText: text, artifacts: [], hasStreamingArtifact: false }
  }

  const artifacts: Artifact[] = []
  let cleanedText = text
  let hasStreamingArtifact = false

  // 1. Extract complete tags
  let completeMatch: RegExpExecArray | null
  const completeRe = new RegExp(COMPLETE_TAG_RE.source, 'g')
  while ((completeMatch = completeRe.exec(text)) !== null) {
    const attrs = parseAttributes(completeMatch[1])
    const tag: ParsedTag = {
      identifier: attrs.identifier || `artifact-${artifacts.length}`,
      type: attrs.type || 'text/html',
      title: attrs.title || 'Artifact',
      content: completeMatch[2],
      isStreaming: false,
    }
    artifacts.push(tagToArtifact(tag))
    const placeholder = `${PLACEHOLDER_PREFIX}${tag.title}${PLACEHOLDER_SUFFIX}`
    cleanedText = cleanedText.replace(completeMatch[0], placeholder)
  }

  // 2. Check for a partial (streaming) tag at end of text
  const partialMatch = cleanedText.match(PARTIAL_TAG_RE)
  if (partialMatch) {
    const attrs = parseAttributes(partialMatch[1])
    const tag: ParsedTag = {
      identifier: attrs.identifier || `artifact-${artifacts.length}`,
      type: attrs.type || 'text/html',
      title: attrs.title || 'Artifact',
      content: partialMatch[2],
      isStreaming: true,
    }
    artifacts.push(tagToArtifact(tag))
    hasStreamingArtifact = true
    const placeholder = `${PLACEHOLDER_PREFIX}${tag.title}${PLACEHOLDER_SUFFIX}`
    cleanedText = cleanedText.replace(partialMatch[0], placeholder)
  }

  return { cleanedText, artifacts, hasStreamingArtifact }
}

// --- Segment-based extraction (for inline rendering) ---

type ArtifactMessageSegment =
  | { type: 'text'; content: string }
  | { type: 'artifact'; artifact: Artifact; isStreaming: boolean }

export interface SegmentResult {
  segments: ArtifactMessageSegment[]
  hasStreamingArtifact: boolean
}

/**
 * Split message text into alternating text / artifact segments.
 * Used by the chat UI to render ArtifactTile components inline.
 */
export function segmentMessageText(text: string): SegmentResult {
  if (!text.includes('<antArtifact')) {
    return { segments: [{ type: 'text', content: text }], hasStreamingArtifact: false }
  }

  const segments: ArtifactMessageSegment[] = []
  let hasStreaming = false
  let lastIndex = 0
  let artifactCount = 0

  // 1. Find complete tags
  const completeRe = new RegExp(COMPLETE_TAG_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = completeRe.exec(text)) !== null) {
    // Text before this tag
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index)
      if (before.trim()) segments.push({ type: 'text', content: before })
    }
    const attrs = parseAttributes(match[1])
    const artifact = tagToArtifact({
      identifier: attrs.identifier || `artifact-${artifactCount++}`,
      type: attrs.type || 'text/html',
      title: attrs.title || 'Artifact',
      content: match[2],
      isStreaming: false,
    })
    segments.push({ type: 'artifact', artifact, isStreaming: false })
    lastIndex = match.index + match[0].length
  }

  // 2. Remaining text after last complete tag
  const remaining = text.slice(lastIndex)

  // 3. Check for a streaming (partial) tag in the remaining text
  const partialMatch = remaining.match(PARTIAL_TAG_RE)
  if (partialMatch) {
    const beforePartial = remaining.slice(0, remaining.indexOf(partialMatch[0]))
    if (beforePartial.trim()) segments.push({ type: 'text', content: beforePartial })

    const attrs = parseAttributes(partialMatch[1])
    const artifact = tagToArtifact({
      identifier: attrs.identifier || `artifact-${artifactCount++}`,
      type: attrs.type || 'text/html',
      title: attrs.title || 'Artifact',
      content: partialMatch[2],
      isStreaming: true,
    })
    segments.push({ type: 'artifact', artifact, isStreaming: true })
    hasStreaming = true
  } else if (remaining.trim()) {
    segments.push({ type: 'text', content: remaining })
  }

  return { segments, hasStreamingArtifact: hasStreaming }
}
