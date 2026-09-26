"use client"

import * as React from "react"
import { cn } from "@/shared/lib/utils"
import { Markdown, type MarkdownProps } from "@/shared/components/prompt-kit/markdown"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/shared/components/ui/tooltip"
import { Bot } from "lucide-react"
import { motion } from "motion/react"

interface MessageProps extends React.HTMLAttributes<HTMLDivElement> {
  role?: "user" | "assistant" | "system"
  /** Animate the message appearance */
  animate?: boolean
  /** Index for staggered animation */
  index?: number
}

const Message = React.forwardRef<HTMLDivElement, MessageProps>(
  ({ className, role, animate = true, index = 0, ...props }, ref) => {
    const content = (
      <div
        ref={ref}
        data-role={role}
        className={cn("flex w-full items-start gap-3 group", className)}
        {...props}
      />
    )

    if (!animate) return content

    return (
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -10, scale: 0.98 }}
        transition={{
          type: "spring",
          stiffness: 400,
          damping: 30,
          delay: index * 0.05,
        }}
      >
        {content}
      </motion.div>
    )
  }
)
Message.displayName = "Message"

interface MessageAvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string
  alt?: string
  fallback?: string
  /** Show Claude asterisk/sparkle icon (for assistant messages) */
  showClaudeIcon?: boolean
  /** Is the message currently streaming */
  isStreaming?: boolean
}

const MessageAvatar = React.forwardRef<HTMLDivElement, MessageAvatarProps>(
  ({ className, src, alt, fallback, showClaudeIcon, isStreaming, children, ...props }, ref) => {
    const fallbackText =
      fallback ?? (typeof alt === "string" && alt.trim().length > 0 ? alt.trim()[0]?.toUpperCase() : "?")
    const hasCustomChildren = React.Children.count(children) > 0

    const avatarContent = hasCustomChildren ? (
      children
    ) : showClaudeIcon ? (
      <Bot className="size-4" />
    ) : src ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={alt ?? "Avatar"} className="size-full object-cover" />
    ) : (
      <span>{fallbackText}</span>
    )

    return (
      <div
        ref={ref}
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground transition-colors duration-200",
          isStreaming && "bg-primary/20 text-primary",
          className
        )}
        {...props}
      >
        <div className={isStreaming ? "animate-gentle-pulse" : ""}>
          {avatarContent}
        </div>
        {/* Streaming indicator ring */}
        {isStreaming && (
          <div className="absolute inset-0 rounded-full border-2 border-primary/50 animate-ping opacity-50" />
        )}
      </div>
    )
  }
)
MessageAvatar.displayName = "MessageAvatar"

type MarkdownComponentProps = Omit<MarkdownProps, "children">

interface MessageContentProps extends React.HTMLAttributes<HTMLDivElement>, MarkdownComponentProps {
  markdown?: boolean
  /** Message role for role-based styling */
  role?: "user" | "assistant" | "system"
  /** Is the message streaming */
  isStreaming?: boolean
}

const MessageContent = React.forwardRef<HTMLDivElement, MessageContentProps>(
  ({ className, markdown, role, isStreaming, children, ...props }, ref) => {
    const isMarkdown = markdown === true && typeof children === "string"

    // Base styling - specific colors handled in globals.css for dark/light modes
    const baseClassName = cn(
      "min-w-0 break-words whitespace-normal transition-colors duration-200 rounded-2xl px-4 py-3",
      role === "user" && "message-user",
      role === "assistant" && "message-assistant",
      role === "system" && "message-system"
    )

    if (isMarkdown) {
      return (
        <Markdown
          ref={ref}
          className={cn(baseClassName, className)}
          {...props}
        >
          {children}
        </Markdown>
      )
    }

    return (
      <div ref={ref} className={cn(baseClassName, className)} {...props}>
        {children}
      </div>
    )
  }
)
MessageContent.displayName = "MessageContent"

interface MessageActionsProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Show actions on hover only */
  showOnHover?: boolean
}

const MessageActions = React.forwardRef<HTMLDivElement, MessageActionsProps>(
  ({ className, showOnHover = true, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex items-center gap-0.5 transition-opacity duration-200",
        showOnHover && "opacity-0 group-hover:opacity-100",
        className
      )}
      {...props}
    />
  )
)
MessageActions.displayName = "MessageActions"

interface MessageActionProps extends React.HTMLAttributes<HTMLDivElement> {
  tooltip?: string
  delayDuration?: number
  /** Success state for copy button etc */
  isSuccess?: boolean
}

const MessageAction = React.forwardRef<HTMLDivElement, MessageActionProps>(
  ({ className, tooltip, delayDuration = 300, isSuccess, children, onClick, ...props }, ref) => {
    const actionContent = (
      <div
        ref={ref}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md cursor-pointer",
          "text-muted-foreground hover:text-foreground hover:bg-muted",
          "transition-[transform,colors] duration-150 hover:scale-105 active:scale-95",
          isSuccess && "text-green-600 bg-green-50",
          className
        )}
        onClick={onClick}
        {...props}
      >
        {children}
      </div>
    )

    if (tooltip) {
      return (
        <TooltipProvider>
          <Tooltip delayDuration={delayDuration}>
            <TooltipTrigger asChild>
              {actionContent}
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )
    }

    return actionContent
  }
)
MessageAction.displayName = "MessageAction"

/**
 * Typing indicator component - shows dots when AI is thinking
 */
function MessageTypingIndicator({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3 animate-slide-up-fade", className)}>
      <MessageAvatar showClaudeIcon isStreaming />
      <div className="flex items-center gap-1 rounded-xl bg-secondary/50 px-4 py-3">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-2 w-2 rounded-full bg-primary/60"
            style={{
              animation: "typing 1.4s infinite ease-in-out",
              animationDelay: `${i * 0.15}s`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Message group wrapper - groups consecutive messages from same role
 */
function MessageGroup({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("group space-y-1", className)}>
      {children}
    </div>
  )
}

export {
  Message,
  MessageAvatar,
  MessageContent,
  MessageActions,
  MessageAction,
  MessageTypingIndicator,
  MessageGroup,
}
