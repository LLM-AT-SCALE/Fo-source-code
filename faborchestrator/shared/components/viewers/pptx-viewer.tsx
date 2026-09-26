"use client"

import { useState, useEffect, useRef } from "react"
import { AlertCircle, Download } from "lucide-react"
import { Button } from "@/shared/components/ui/button"

interface PptxViewerProps {
  arrayBuffer: ArrayBuffer
  isDarkMode: boolean
  filename?: string
  onDownload?: () => void
}

// --- OOXML types ---

interface TextRun {
  text: string
  fontSize?: number     // points
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string        // #RRGGBB
}

interface SlideParagraph {
  alignment?: "left" | "center" | "right" | "justify"
  runs: TextRun[]
  level?: number        // indentation level (0-based)
  isBullet?: boolean
}

interface SlideShape {
  type: "shape" | "image" | "group"
  x: number             // pixels
  y: number
  width: number
  height: number
  fill?: string         // #RRGGBB
  fillOpacity?: number  // 0-1
  paragraphs: SlideParagraph[]
  imageUrl?: string
  borderColor?: string
  borderWidth?: number
  rotation?: number     // degrees
  cornerRadius?: number // pixels
  verticalAlign?: "top" | "middle" | "bottom"
  children?: SlideShape[]
}

interface ParsedSlide {
  number: number
  background?: string
  backgroundImage?: string
  shapes: SlideShape[]
}

// --- Constants ---

const EMU_PER_PIXEL = 9525         // 914400 EMU/inch / 96 px/inch

// Scheme color → fallback hex mapping (common PowerPoint theme colors)
const SCHEME_COLOR_FALLBACKS: Record<string, string> = {
  dk1: "#000000", dk2: "#44546A", lt1: "#FFFFFF", lt2: "#E7E6E6",
  accent1: "#4472C4", accent2: "#ED7D31", accent3: "#A5A5A5",
  accent4: "#FFC000", accent5: "#5B9BD5", accent6: "#70AD47",
  hlink: "#0563C1", folHlink: "#954F72",
  tx1: "#000000", tx2: "#44546A", bg1: "#FFFFFF", bg2: "#E7E6E6",
}

// --- XML Parsing Helpers ---

function emuToPx(emu: string | number | null): number {
  if (emu == null) return 0
  return Math.round(Number(emu) / EMU_PER_PIXEL)
}

function parseColor(xml: string): string | null {
  // Look for <a:srgbClr val="RRGGBB"/>
  const srgb = xml.match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/)
  if (srgb) return `#${srgb[1]}`

  // Look for <a:schemeClr val="dk1"/>
  const scheme = xml.match(/<a:schemeClr\s+val="([^"]+)"/)
  if (scheme && SCHEME_COLOR_FALLBACKS[scheme[1]]) {
    return SCHEME_COLOR_FALLBACKS[scheme[1]]
  }

  return null
}

function parseSolidFill(xml: string): string | null {
  const fillMatch = xml.match(/<a:solidFill>([\s\S]*?)<\/a:solidFill>/)
  if (!fillMatch) return null
  return parseColor(fillMatch[1])
}

function parseTransform(spXml: string): { x: number; y: number; w: number; h: number; rot: number } | null {
  const xfrm = spXml.match(/<a:xfrm[^>]*>([\s\S]*?)<\/a:xfrm>/)
  if (!xfrm) return null
  const xfrmTag = spXml.match(/<a:xfrm[^>]*>/)
  const rotStr = xfrmTag?.[0].match(/rot="([^"]+)"/)
  const offXml = xfrm[1]
  // Flexible attribute matching: x and y can appear in any order
  const offXMatch = offXml.match(/<a:off[^>]*\bx="(-?\d+)"/)
  const offYMatch = offXml.match(/<a:off[^>]*\by="(-?\d+)"/)
  const extCxMatch = offXml.match(/<a:ext[^>]*\bcx="(\d+)"/)
  const extCyMatch = offXml.match(/<a:ext[^>]*\bcy="(\d+)"/)
  if (!offXMatch || !offYMatch || !extCxMatch || !extCyMatch) return null
  return {
    x: emuToPx(offXMatch[1]),
    y: emuToPx(offYMatch[1]),
    w: emuToPx(extCxMatch[1]),
    h: emuToPx(extCyMatch[1]),
    rot: rotStr ? Number(rotStr[1]) / 60000 : 0, // EMU rotation to degrees
  }
}

function parseParagraphs(txBodyXml: string): SlideParagraph[] {
  const paragraphs: SlideParagraph[] = []
  const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g
  let pMatch
  while ((pMatch = pRegex.exec(txBodyXml)) !== null) {
    const pXml = pMatch[1]

    // Paragraph properties
    const pPrMatch = pXml.match(/<a:pPr([^>]*)(?:\/>|>([\s\S]*?)<\/a:pPr>)/)
    let alignment: SlideParagraph["alignment"]
    let level = 0
    let isBullet = false
    if (pPrMatch) {
      const algnMatch = pPrMatch[1].match(/algn="([^"]+)"/)
      if (algnMatch) {
        const map: Record<string, SlideParagraph["alignment"]> = {
          l: "left", ctr: "center", r: "right", just: "justify",
        }
        alignment = map[algnMatch[1]]
      }
      const lvlMatch = pPrMatch[1].match(/lvl="(\d+)"/)
      if (lvlMatch) level = parseInt(lvlMatch[1])
      // Check for bullet
      const pPrContent = (pPrMatch[2] || "") + pPrMatch[1]
      if (/<a:buChar/.test(pPrContent) || /<a:buAutoNum/.test(pPrContent) || /<a:buFont/.test(pPrContent)) {
        isBullet = true
      }
    }

    // Text runs
    const runs: TextRun[] = []
    const rRegex = /<a:r>([\s\S]*?)<\/a:r>/g
    let rMatch
    while ((rMatch = rRegex.exec(pXml)) !== null) {
      const rXml = rMatch[1]
      const textMatch = rXml.match(/<a:t>([\s\S]*?)<\/a:t>/)
      if (!textMatch) continue
      const text = textMatch[1]

      const run: TextRun = { text }

      // Run properties
      const rPrMatch = rXml.match(/<a:rPr([^>]*)(?:\/>|>([\s\S]*?)<\/a:rPr>)/)
      if (rPrMatch) {
        const attrs = rPrMatch[1]
        const rPrContent = rPrMatch[2] || ""

        const szMatch = attrs.match(/sz="(\d+)"/)
        if (szMatch) run.fontSize = parseInt(szMatch[1]) / 100 // hundredths of a point → points

        if (/\bb="1"/.test(attrs)) run.bold = true
        if (/\bi="1"/.test(attrs)) run.italic = true
        if (/\bu="sng"/.test(attrs)) run.underline = true

        // Font family
        const latinMatch = rPrContent.match(/<a:latin[^>]+typeface="([^"]+)"/) ||
          rXml.match(/<a:latin[^>]+typeface="([^"]+)"/)
        if (latinMatch) run.fontFamily = latinMatch[1]

        // Text color (in rPr child or solidFill)
        const color = parseSolidFill(rPrContent) || parseSolidFill(rPrMatch[0])
        if (color) run.color = color
      }

      runs.push(run)
    }

    // Also handle <a:fld> (field) elements like slide numbers, dates
    const fldRegex = /<a:fld[^>]*>([\s\S]*?)<\/a:fld>/g
    let fldMatch
    while ((fldMatch = fldRegex.exec(pXml)) !== null) {
      const fldXml = fldMatch[1]
      const textMatch = fldXml.match(/<a:t>([\s\S]*?)<\/a:t>/)
      if (textMatch) {
        runs.push({ text: textMatch[1] })
      }
    }

    if (runs.length > 0 || paragraphs.length > 0) {
      paragraphs.push({ alignment, runs, level, isBullet })
    }
  }
  return paragraphs
}

function parseShapeProperties(spPrXml: string): {
  fill?: string
  borderColor?: string
  borderWidth?: number
  cornerRadius?: number
} {
  const result: ReturnType<typeof parseShapeProperties> = {}

  // Fill
  const fill = parseSolidFill(spPrXml)
  if (fill) result.fill = fill

  // Border / outline
  const lnMatch = spPrXml.match(/<a:ln([^>]*)>([\s\S]*?)<\/a:ln>/)
  if (lnMatch) {
    const wMatch = lnMatch[1].match(/w="(\d+)"/)
    if (wMatch) result.borderWidth = emuToPx(wMatch[1]) || 1
    const lineColor = parseSolidFill(lnMatch[2])
    if (lineColor) result.borderColor = lineColor
  }

  // Corner radius
  const prstGeom = spPrXml.match(/<a:prstGeom[^>]*prst="roundRect"/)
  if (prstGeom) result.cornerRadius = 8

  return result
}

interface RelationshipMap {
  [rId: string]: string  // rId → target path
}

function parseRelationships(relsXml: string): RelationshipMap {
  const map: RelationshipMap = {}
  const regex = /<Relationship\s+Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g
  let m
  while ((m = regex.exec(relsXml)) !== null) {
    map[m[1]] = m[2]
  }
  return map
}

async function parseShape(
  spXml: string,
  _rels: RelationshipMap,
  _loadImage: (path: string) => Promise<string | null>
): Promise<SlideShape | null> {
  const transform = parseTransform(spXml)
  if (!transform) return null

  const shape: SlideShape = {
    type: "shape",
    x: transform.x,
    y: transform.y,
    width: transform.w,
    height: transform.h,
    paragraphs: [],
    rotation: transform.rot,
  }

  // Shape properties
  const spPrMatch = spXml.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/) ||
    spXml.match(/<p:spPr[^>]*>([\s\S]*?)<\/p:spPr>/)
  if (spPrMatch) {
    const props = parseShapeProperties(spPrMatch[1])
    Object.assign(shape, props)
  }

  // Vertical alignment
  const bodyPrMatch = spXml.match(/<a:bodyPr([^>]*)/)
  if (bodyPrMatch) {
    const anchor = bodyPrMatch[1].match(/anchor="([^"]+)"/)
    if (anchor) {
      const map: Record<string, SlideShape["verticalAlign"]> = {
        t: "top", ctr: "middle", b: "bottom",
      }
      shape.verticalAlign = map[anchor[1]]
    }
  }

  // Text body
  const txBodyMatch = spXml.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/)
  if (txBodyMatch) {
    shape.paragraphs = parseParagraphs(txBodyMatch[1])
  }

  return shape
}

async function parsePicture(
  picXml: string,
  rels: RelationshipMap,
  loadImage: (path: string) => Promise<string | null>
): Promise<SlideShape | null> {
  const transform = parseTransform(picXml)
  if (!transform) return null

  // Get image reference
  const blipMatch = picXml.match(/<a:blip[^>]*r:embed="([^"]+)"/)
  let imageUrl: string | null = null
  if (blipMatch) {
    const rId = blipMatch[1]
    const target = rels[rId]
    if (target) {
      const imgPath = target.startsWith("../") ? "ppt/" + target.slice(3) : "ppt/slides/" + target
      imageUrl = await loadImage(imgPath)
    }
  }

  return {
    type: "image",
    x: transform.x,
    y: transform.y,
    width: transform.w,
    height: transform.h,
    paragraphs: [],
    imageUrl: imageUrl || undefined,
  }
}

async function parseSlideXml(
  slideXml: string,
  slideNumber: number,
  rels: RelationshipMap,
  loadImage: (path: string) => Promise<string | null>
): Promise<ParsedSlide> {
  const slide: ParsedSlide = {
    number: slideNumber,
    shapes: [],
  }

  // Background
  const bgMatch = slideXml.match(/<p:bg>([\s\S]*?)<\/p:bg>/)
  if (bgMatch) {
    const bgFill = parseSolidFill(bgMatch[1])
    if (bgFill) slide.background = bgFill

    // Background image
    const bgBlip = bgMatch[1].match(/<a:blip[^>]*r:embed="([^"]+)"/)
    if (bgBlip) {
      const target = rels[bgBlip[1]]
      if (target) {
        const imgPath = target.startsWith("../") ? "ppt/" + target.slice(3) : "ppt/slides/" + target
        const url = await loadImage(imgPath)
        if (url) slide.backgroundImage = url
      }
    }
  }

  // Extract group shapes first, then parse top-level shapes from cleaned XML
  const groupBlocks: string[] = []
  const grpRegex = /<p:grpSp\b[^>]*>[\s\S]*?<\/p:grpSp>/g
  let grpMatch
  while ((grpMatch = grpRegex.exec(slideXml)) !== null) {
    groupBlocks.push(grpMatch[0])
  }

  // Remove groups from slide XML so top-level regex doesn't match inner shapes
  let topLevelXml = slideXml
  for (const block of groupBlocks) {
    topLevelXml = topLevelXml.replace(block, "")
  }

  // Parse top-level shapes <p:sp>
  const spRegex = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g
  let spMatch
  while ((spMatch = spRegex.exec(topLevelXml)) !== null) {
    const shape = await parseShape(spMatch[0], rels, loadImage)
    if (shape) slide.shapes.push(shape)
  }

  // Parse top-level pictures <p:pic>
  const picRegex = /<p:pic\b[^>]*>([\s\S]*?)<\/p:pic>/g
  let picMatch
  while ((picMatch = picRegex.exec(topLevelXml)) !== null) {
    const pic = await parsePicture(picMatch[0], rels, loadImage)
    if (pic) slide.shapes.push(pic)
  }

  // Parse shapes inside groups (flatten into slide)
  for (const grpXml of groupBlocks) {
    const innerSpRegex = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g
    let innerMatch
    while ((innerMatch = innerSpRegex.exec(grpXml)) !== null) {
      const shape = await parseShape(innerMatch[0], rels, loadImage)
      if (shape) slide.shapes.push(shape)
    }
    const innerPicRegex = /<p:pic\b[^>]*>([\s\S]*?)<\/p:pic>/g
    let innerPicMatch
    while ((innerPicMatch = innerPicRegex.exec(grpXml)) !== null) {
      const pic = await parsePicture(innerPicMatch[0], rels, loadImage)
      if (pic) slide.shapes.push(pic)
    }
  }

  return slide
}

// --- Rendering ---

function SlideRenderer({
  slide,
  slideWidth,
  slideHeight,
}: {
  slide: ParsedSlide
  slideWidth: number
  slideHeight: number
}) {
  const aspectRatio = slideWidth / slideHeight
  const containerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    function measure() {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth
        if (w > 0) setScale(w / slideWidth)
      }
    }
    measure()
    const obs = new ResizeObserver(measure)
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [slideWidth])

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-lg shadow-md border border-border"
      style={{
        aspectRatio,
        background: slide.backgroundImage
          ? `url(${slide.backgroundImage}) center/cover no-repeat`
          : slide.background || "#FFFFFF",
      }}
    >
      {/* Slide number badge */}
      <div className="absolute top-2 left-2 z-20 bg-black/50 text-white text-[10px] px-1.5 py-0.5 rounded font-medium">
        {slide.number}
      </div>

      {/* Shapes layer */}
      <div
        style={{
          width: slideWidth,
          height: slideHeight,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "absolute",
          top: 0,
          left: 0,
        }}
      >
        {slide.shapes.map((shape, idx) => (
          <ShapeRenderer key={idx} shape={shape} />
        ))}
      </div>
    </div>
  )
}

function ShapeRenderer({ shape }: { shape: SlideShape }) {
  const style: React.CSSProperties = {
    position: "absolute",
    left: shape.x,
    top: shape.y,
    width: shape.width,
    height: shape.height,
    overflow: "hidden",
  }

  if (shape.fill) {
    style.backgroundColor = shape.fill
    if (shape.fillOpacity != null) style.opacity = shape.fillOpacity
  }

  if (shape.borderColor) {
    style.border = `${shape.borderWidth || 1}px solid ${shape.borderColor}`
  }

  if (shape.rotation) {
    style.transform = `rotate(${shape.rotation}deg)`
  }

  if (shape.cornerRadius) {
    style.borderRadius = shape.cornerRadius
  }

  if (shape.verticalAlign === "middle") {
    style.display = "flex"
    style.flexDirection = "column"
    style.justifyContent = "center"
  } else if (shape.verticalAlign === "bottom") {
    style.display = "flex"
    style.flexDirection = "column"
    style.justifyContent = "flex-end"
  }

  // Image shape
  if (shape.type === "image" && shape.imageUrl) {
    return (
      <div style={style}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={shape.imageUrl}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </div>
    )
  }

  // Text shape
  return (
    <div style={style}>
      <div style={{ padding: "4px 8px", width: "100%", height: "100%", boxSizing: "border-box" }}>
        {shape.paragraphs.map((para, pIdx) => (
          <ParagraphRenderer key={pIdx} paragraph={para} />
        ))}
      </div>
    </div>
  )
}

function ParagraphRenderer({ paragraph }: { paragraph: SlideParagraph }) {
  if (paragraph.runs.length === 0) {
    return <div style={{ minHeight: "0.5em" }} />
  }

  const pStyle: React.CSSProperties = {
    margin: 0,
    padding: 0,
    textAlign: paragraph.alignment || "left",
    paddingLeft: paragraph.level ? paragraph.level * 20 : undefined,
    lineHeight: 1.3,
  }

  return (
    <p style={pStyle}>
      {paragraph.isBullet && (
        <span style={{ marginRight: 6 }}>&bull;</span>
      )}
      {paragraph.runs.map((run, rIdx) => (
        <RunRenderer key={rIdx} run={run} />
      ))}
    </p>
  )
}

function RunRenderer({ run }: { run: TextRun }) {
  const style: React.CSSProperties = {}

  if (run.fontSize) style.fontSize = `${run.fontSize}pt`
  if (run.fontFamily) style.fontFamily = `"${run.fontFamily}", sans-serif`
  if (run.bold) style.fontWeight = "bold"
  if (run.italic) style.fontStyle = "italic"
  if (run.underline) style.textDecoration = "underline"
  if (run.color) style.color = run.color

  return <span style={style}>{run.text}</span>
}

// --- Main Component ---

export function PptxViewer({ arrayBuffer, isDarkMode: _isDarkMode, filename, onDownload }: PptxViewerProps) {
  const [slides, setSlides] = useState<ParsedSlide[]>([])
  const [slideWidth, setSlideWidth] = useState(960)  // px
  const [slideHeight, setSlideHeight] = useState(720) // px
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const blobUrlsRef = useRef<string[]>([])

  // Cleanup blob URLs on unmount
  useEffect(() => {
    const blobUrls = blobUrlsRef.current
    return () => {
      blobUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function parse() {
      try {
        setLoading(true)
        setError(null)
        const JSZip = (await import("jszip")).default
        const zip = await JSZip.loadAsync(arrayBuffer)

        // Image loader with caching
        const imageCache = new Map<string, string | null>()
        async function loadImage(path: string): Promise<string | null> {
          if (imageCache.has(path)) return imageCache.get(path)!
          const file = zip.file(path)
          if (!file) { imageCache.set(path, null); return null }
          try {
            const blob = await file.async("blob")
            const url = URL.createObjectURL(blob)
            blobUrlsRef.current.push(url)
            imageCache.set(path, url)
            return url
          } catch {
            imageCache.set(path, null)
            return null
          }
        }

        // Read presentation dimensions
        const presFile = zip.file("ppt/presentation.xml")
        if (presFile) {
          const presXml = await presFile.async("text")
          const cxMatch = presXml.match(/<p:sldSz[^>]*\bcx="(\d+)"/)
          const cyMatch = presXml.match(/<p:sldSz[^>]*\bcy="(\d+)"/)
          if (cxMatch && cyMatch) {
            setSlideWidth(emuToPx(cxMatch[1]))
            setSlideHeight(emuToPx(cyMatch[1]))
          }
        }

        // Find and sort slide files
        const slideFiles = Object.keys(zip.files)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((a, b) => {
            const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0")
            const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0")
            return numA - numB
          })

        // Parse each slide
        const parsed: ParsedSlide[] = []
        for (let i = 0; i < slideFiles.length; i++) {
          const slidePath = slideFiles[i]
          const slideXml = await zip.files[slidePath].async("text")

          // Load slide relationships
          const relsPath = slidePath.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels"
          const relsFile = zip.file(relsPath)
          const rels: RelationshipMap = relsFile
            ? parseRelationships(await relsFile.async("text"))
            : {}

          const slide = await parseSlideXml(slideXml, i + 1, rels, loadImage)
          parsed.push(slide)
        }

        if (!cancelled) {
          setSlides(parsed)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to parse presentation")
          setLoading(false)
        }
      }
    }

    parse()
    return () => { cancelled = true }
  }, [arrayBuffer])

  if (loading) {
    return (
      <div className="h-full p-6 space-y-4">
        <div className="aspect-video w-full rounded-lg bg-muted animate-pulse" />
        <div className="flex justify-center gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-12 w-20 rounded bg-muted animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertCircle className="h-10 w-10 text-destructive" />
          <div>
            <h3 className="font-medium text-sm">Failed to parse presentation</h3>
            <p className="text-xs text-muted-foreground mt-1">{error}</p>
          </div>
          {onDownload && (
            <Button variant="default" size="sm" onClick={onDownload}>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download {filename || "file"}
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full w-full overflow-auto">
      <div className="p-6 space-y-6">
        {slides.map((slide) => (
          <SlideRenderer
            key={slide.number}
            slide={slide}
            slideWidth={slideWidth}
            slideHeight={slideHeight}
          />
        ))}
        {slides.length === 0 && (
          <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
            No slides found in this presentation.
          </div>
        )}
      </div>
    </div>
  )
}
