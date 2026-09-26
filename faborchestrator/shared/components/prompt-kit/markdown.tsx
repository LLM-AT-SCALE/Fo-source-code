import * as React from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import { cn } from "@/shared/lib/utils"
import { CodeBlock, CodeBlockCode } from "@/shared/components/prompt-kit/code-block"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table"

// Import KaTeX CSS for math rendering
import "katex/dist/katex.min.css"

export type MarkdownProps = {
  children: string
  className?: string
  components?: Partial<Components>
} & React.HTMLAttributes<HTMLDivElement>

function extractLanguage(className?: string): string {
  if (!className) return "plaintext"
  const match = className.match(/language-([\w-]+)/)
  return match ? match[1] : "plaintext"
}

const DEFAULT_COMPONENTS: Partial<Components> = {
  table: function TableComponent({ children, node: _node, ...props }) {
    return (
      <div className="table-wrapper">
        <Table {...props}>{children}</Table>
      </div>
    )
  },
  thead: function TableHeadComponent({ children, node: _node, ...props }) {
    return <TableHeader {...props}>{children}</TableHeader>
  },
  tbody: function TableBodyComponent({ children, node: _node, ...props }) {
    return <TableBody {...props}>{children}</TableBody>
  },
  tr: function TableRowComponent({ children, node: _node, ...props }) {
    return <TableRow {...props}>{children}</TableRow>
  },
  th: function TableHeadCellComponent({ children, node: _node, ...props }) {
    return <TableHead {...props}>{children}</TableHead>
  },
  td: function TableCellComponent({ children, node: _node, ...props }) {
    return <TableCell {...props}>{children}</TableCell>
  },
  code: function CodeComponent({ className, children, node, ...props }) {
    const startLine = node?.position?.start?.line
    const endLine = node?.position?.end?.line
    const isInline = !startLine || !endLine || startLine === endLine

    if (isInline) {
      return (
        <code
          className={cn(
            "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]",
            className
          )}
          {...props}
        >
          {children}
        </code>
      )
    }

    const language = extractLanguage(className)
    const code = String(children ?? "")

    return (
      <CodeBlock>
        <CodeBlockCode code={code} language={language} />
      </CodeBlock>
    )
  },
  pre: function PreComponent({ children }) {
    return <>{children}</>
  },
}

// Stable plugin arrays — prevents ReactMarkdown from re-initializing parsers
const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [rehypeKatex]

const Markdown = React.forwardRef<HTMLDivElement, MarkdownProps>(
  ({ children, className, components, ...props }, ref) => {
    const mergedComponents = React.useMemo(
      () => ({ ...DEFAULT_COMPONENTS, ...components }),
      [components]
    )

    return (
      <div
        ref={ref}
        className={cn(
          "prose prose-sm max-w-none break-words dark:prose-invert prose-p:my-3 prose-ul:my-3 prose-ol:my-3 prose-li:my-1 prose-pre:my-4 prose-headings:mb-3 prose-headings:mt-5 prose-blockquote:my-3",
          className
        )}
        {...props}
      >
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={mergedComponents}
        >
          {children}
        </ReactMarkdown>
      </div>
    )
  }
)

Markdown.displayName = "Markdown"

export { Markdown }
