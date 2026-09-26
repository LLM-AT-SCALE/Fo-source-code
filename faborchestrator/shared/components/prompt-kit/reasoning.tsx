"use client"

import { cn } from "@/shared/lib/utils"
import { Button } from "@/shared/components/ui/button"
import { ChevronDownIcon } from "lucide-react"
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import { Markdown } from "./markdown"

type ReasoningContextType = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

const ReasoningContext = createContext<ReasoningContextType | undefined>(
  undefined
)

function useReasoningContext() {
  const context = useContext(ReasoningContext)
  if (!context) {
    throw new Error(
      "useReasoningContext must be used within a Reasoning provider"
    )
  }
  return context
}

export type ReasoningProps = {
  children: React.ReactNode
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  isStreaming?: boolean
}

function Reasoning({
  children,
  className,
  open,
  onOpenChange,
  // isStreaming kept for API compatibility but no longer auto-opens/closes
  isStreaming: _isStreaming,
}: ReasoningProps) {
  const [internalOpen, setInternalOpen] = useState(false)

  const isControlled = open !== undefined
  const isOpen = isControlled ? open : internalOpen

  const handleOpenChange = (newOpen: boolean) => {
    if (!isControlled) {
      setInternalOpen(newOpen)
    }
    onOpenChange?.(newOpen)
  }

  return (
    <ReasoningContext.Provider
      value={{
        isOpen,
        onOpenChange: handleOpenChange,
      }}
    >
      <div className={className}>{children}</div>
    </ReasoningContext.Provider>
  )
}

export type ReasoningTriggerProps = {
  children: React.ReactNode
  className?: string
} & React.HTMLAttributes<HTMLButtonElement>

function ReasoningTrigger({
  children,
  className,
  ...props
}: ReasoningTriggerProps) {
  const { isOpen, onOpenChange } = useReasoningContext()

  return (
    <Button
      variant="ghost"
      className={cn(
        "flex h-auto w-fit cursor-pointer items-center justify-start gap-2 rounded-none border-0 bg-transparent p-0 hover:bg-transparent active:scale-100 dark:hover:bg-transparent",
        className
      )}
      onClick={() => onOpenChange(!isOpen)}
      {...props}
    >
      <span className="text-primary">{children}</span>
      <div
        className={cn(
          "transition-transform duration-200 ease-out",
          isOpen ? "rotate-180" : "rotate-0"
        )}
      >
        <ChevronDownIcon className="size-4" />
      </div>
    </Button>
  )
}

export type ReasoningContentProps = {
  children: React.ReactNode
  className?: string
  markdown?: boolean
  contentClassName?: string
} & React.HTMLAttributes<HTMLDivElement>

function ReasoningContent({
  children,
  className,
  contentClassName,
  markdown = false,
  ...props
}: ReasoningContentProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [maxHeight, setMaxHeight] = useState<string>("0px")
  const { isOpen } = useReasoningContext()

  useEffect(() => {
    if (!contentRef.current || !innerRef.current) return

    const observer = new ResizeObserver(() => {
      if (innerRef.current && isOpen) {
        // Use rAF to batch DOM reads/writes and avoid layout thrashing
        requestAnimationFrame(() => {
          if (innerRef.current) {
            setMaxHeight(`${innerRef.current.scrollHeight}px`)
          }
        })
      }
    })

    observer.observe(innerRef.current)

    if (isOpen) {
      setMaxHeight(`${innerRef.current.scrollHeight}px`)
    } else {
      setMaxHeight("0px")
    }

    return () => observer.disconnect()
  }, [isOpen])

  const content = markdown ? (
    <Markdown>{children as string}</Markdown>
  ) : (
    children
  )

  return (
    <div
      ref={contentRef}
      className={cn(
        "overflow-hidden transition-[max-height,opacity] duration-200 ease-out",
        isOpen ? "opacity-100" : "opacity-0",
        className
      )}
      style={{ maxHeight, willChange: isOpen ? "max-height, opacity" : "auto" }}
      {...props}
    >
      <div
        ref={innerRef}
        className={cn(
          "text-muted-foreground prose prose-sm dark:prose-invert",
          contentClassName
        )}
      >
        {content}
      </div>
    </div>
  )
}

export { Reasoning, ReasoningTrigger, ReasoningContent }
