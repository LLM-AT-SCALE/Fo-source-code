"use client"

import { cn } from "@/shared/lib/utils"
import { motion } from "motion/react"

/**
 * Enhanced skeleton with shimmer animation
 */
function ShimmerSkeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-muted",
        className
      )}
      {...props}
    >
      <div className="absolute inset-0 -translate-x-full animate-[skeleton-glow_2s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
    </div>
  )
}

/**
 * Skeleton loader for conversation list items with stagger animation
 */
export function ConversationListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-2 p-2">
      {Array.from({ length: count }).map((_, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.05, duration: 0.2 }}
          className="flex items-center gap-3 rounded-lg p-3"
        >
          <ShimmerSkeleton className="h-8 w-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <ShimmerSkeleton className="h-4 w-3/4" />
            <ShimmerSkeleton className="h-3 w-1/2" />
          </div>
        </motion.div>
      ))}
    </div>
  )
}

/**
 * Skeleton loader for a single message with direction awareness
 */
export function MessageSkeleton({ isUser = false }: { isUser?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "flex gap-3 p-4",
        isUser ? "flex-row-reverse" : "flex-row"
      )}
    >
      <ShimmerSkeleton className="h-8 w-8 shrink-0 rounded-full" />
      <div className={cn("flex-1 space-y-2", isUser && "flex flex-col items-end")}>
        <ShimmerSkeleton className={cn("h-4", isUser ? "w-1/3" : "w-1/4")} />
        <ShimmerSkeleton className={cn("h-20 rounded-lg", isUser ? "w-2/3" : "w-3/4")} />
      </div>
    </motion.div>
  )
}

/**
 * Skeleton loader for chat messages list with stagger
 */
export function ChatMessagesSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-4 p-4">
      {Array.from({ length: count }).map((_, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.1, duration: 0.3 }}
        >
          <MessageSkeleton isUser={i % 2 === 0} />
        </motion.div>
      ))}
    </div>
  )
}

/**
 * Skeleton loader for artifact panel with sections
 */
export function ArtifactPanelSkeleton() {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex h-full flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-3">
          <ShimmerSkeleton className="h-8 w-8 rounded" />
          <div className="space-y-1">
            <ShimmerSkeleton className="h-4 w-32" />
            <ShimmerSkeleton className="h-3 w-20" />
          </div>
        </div>
        <div className="flex gap-2">
          <ShimmerSkeleton className="h-8 w-8 rounded" />
          <ShimmerSkeleton className="h-8 w-8 rounded" />
        </div>
      </div>
      {/* Tabs */}
      <div className="flex gap-2 border-b p-2">
        <ShimmerSkeleton className="h-8 w-20 rounded" />
        <ShimmerSkeleton className="h-8 w-20 rounded" />
      </div>
      {/* Content */}
      <div className="flex-1 p-4">
        <ShimmerSkeleton className="h-full w-full rounded-lg" />
      </div>
    </motion.div>
  )
}

/**
 * Skeleton loader for settings card
 */
export function SettingsCardSkeleton() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border p-6 space-y-4"
    >
      <div className="space-y-2">
        <ShimmerSkeleton className="h-5 w-1/3" />
        <ShimmerSkeleton className="h-4 w-2/3" />
      </div>
      <div className="space-y-3">
        <div className="space-y-2">
          <ShimmerSkeleton className="h-4 w-24" />
          <ShimmerSkeleton className="h-10 w-full rounded-lg" />
        </div>
        <div className="space-y-2">
          <ShimmerSkeleton className="h-4 w-24" />
          <ShimmerSkeleton className="h-10 w-full rounded-lg" />
        </div>
      </div>
      <ShimmerSkeleton className="h-10 w-32 rounded-lg" />
    </motion.div>
  )
}

/**
 * Skeleton loader for MCP connection card
 */
export function McpConnectionSkeleton() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      className="rounded-lg border p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShimmerSkeleton className="h-10 w-10 rounded-full" />
          <div className="space-y-1">
            <ShimmerSkeleton className="h-4 w-32" />
            <ShimmerSkeleton className="h-3 w-48" />
          </div>
        </div>
        <ShimmerSkeleton className="h-6 w-16 rounded-full" />
      </div>
      <div className="flex gap-2">
        <ShimmerSkeleton className="h-8 w-20 rounded" />
        <ShimmerSkeleton className="h-8 w-20 rounded" />
      </div>
    </motion.div>
  )
}

/**
 * Skeleton loader for model selector
 */
export function ModelSelectorSkeleton() {
  return (
    <ShimmerSkeleton className="h-9 w-40 rounded-md" />
  )
}

/**
 * Skeleton loader for solution card with hover effect
 */
export function SolutionCardSkeleton() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border p-6 space-y-4"
    >
      <div className="flex items-center gap-3">
        <ShimmerSkeleton className="h-12 w-12 rounded-lg" />
        <div className="space-y-1">
          <ShimmerSkeleton className="h-5 w-32" />
          <ShimmerSkeleton className="h-4 w-20" />
        </div>
      </div>
      <ShimmerSkeleton className="h-16 w-full rounded" />
      <ShimmerSkeleton className="h-10 w-full rounded-md" />
    </motion.div>
  )
}

/**
 * Full page loading skeleton with animated sections
 */
export function PageLoadingSkeleton() {
  return (
    <div className="flex h-screen w-full">
      {/* Sidebar skeleton */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        className="hidden w-64 border-r md:block"
      >
        <div className="p-4 space-y-4">
          <ShimmerSkeleton className="h-10 w-full rounded-lg" />
          <ConversationListSkeleton count={8} />
        </div>
      </motion.div>
      {/* Main content skeleton */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.1 }}
        className="flex flex-1 flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b p-4">
          <ShimmerSkeleton className="h-8 w-48" />
          <div className="flex gap-2">
            <ShimmerSkeleton className="h-8 w-8 rounded" />
            <ShimmerSkeleton className="h-8 w-8 rounded" />
          </div>
        </div>
        {/* Chat area */}
        <div className="flex-1 overflow-hidden">
          <ChatMessagesSkeleton count={4} />
        </div>
        {/* Input area */}
        <div className="border-t p-4">
          <ShimmerSkeleton className="h-12 w-full rounded-lg" />
        </div>
      </motion.div>
    </div>
  )
}

/**
 * Inline loading indicator for buttons/actions with bounce
 */
export function InlineLoader({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-current"
          animate={{
            y: [0, -4, 0],
            opacity: [0.5, 1, 0.5],
          }}
          transition={{
            duration: 0.6,
            repeat: Infinity,
            delay: i * 0.1,
          }}
        />
      ))}
    </div>
  )
}

/**
 * Pulse dot loader - simple and elegant
 */
export function PulseDotsLoader({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="h-2 w-2 rounded-full bg-primary"
          animate={{
            scale: [1, 1.2, 1],
            opacity: [0.4, 1, 0.4],
          }}
          transition={{
            duration: 1,
            repeat: Infinity,
            delay: i * 0.15,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  )
}

/**
 * AI Thinking skeleton - shows AI is processing
 */
export function AIThinkingSkeleton() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-3 p-4"
    >
      <motion.div
        className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center"
        animate={{ scale: [1, 1.05, 1] }}
        transition={{ duration: 1.5, repeat: Infinity }}
      >
        <div className="h-4 w-4 rounded-full bg-primary/40" />
      </motion.div>
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <ShimmerSkeleton className="h-4 w-16" />
          <PulseDotsLoader />
        </div>
        <ShimmerSkeleton className="h-4 w-2/3" />
        <ShimmerSkeleton className="h-4 w-1/2" />
      </div>
    </motion.div>
  )
}

/**
 * Card loading skeleton with scale animation
 */
export function CardLoadingSkeleton({ className }: { className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn("rounded-xl border bg-card p-4 space-y-3", className)}
    >
      <div className="flex items-center gap-3">
        <ShimmerSkeleton className="h-10 w-10 rounded-lg" />
        <div className="flex-1 space-y-1.5">
          <ShimmerSkeleton className="h-4 w-2/3" />
          <ShimmerSkeleton className="h-3 w-1/2" />
        </div>
      </div>
      <ShimmerSkeleton className="h-20 w-full rounded-lg" />
    </motion.div>
  )
}

export { ShimmerSkeleton }
