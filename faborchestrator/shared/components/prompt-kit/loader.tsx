"use client"

import * as React from "react"
import { cn } from "@/shared/lib/utils"
import { Bot, Sparkles } from "lucide-react"

type LoaderVariant =
  | "circular"
  | "classic"
  | "pulse"
  | "pulse-dot"
  | "dots"
  | "typing"
  | "wave"
  | "bars"
  | "terminal"
  | "text-blink"
  | "text-shimmer"
  | "brain"
  | "sparkle"
  | "orbit"

type LoaderSize = "sm" | "md" | "lg" | "xl"

interface LoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: LoaderVariant
  size?: LoaderSize
  text?: string
  /** Color of the loader */
  color?: "primary" | "muted" | "current"
}

const sizeMap: Record<LoaderSize, { container: string; element: string; text: string }> = {
  sm: { container: "h-4 w-4", element: "h-1 w-1", text: "text-xs" },
  md: { container: "h-6 w-6", element: "h-1.5 w-1.5", text: "text-sm" },
  lg: { container: "h-8 w-8", element: "h-2 w-2", text: "text-base" },
  xl: { container: "h-12 w-12", element: "h-3 w-3", text: "text-lg" },
}

const colorMap: Record<string, string> = {
  primary: "text-primary",
  muted: "text-muted-foreground",
  current: "text-current",
}

const Loader = React.forwardRef<HTMLDivElement, LoaderProps>(
  ({ className, variant = "pulse-dot", size = "md", text, color = "primary", ...props }, ref) => {
    const sizes = sizeMap[size]
    const colorClass = colorMap[color]

    const renderLoader = () => {
      switch (variant) {
        case "circular":
          return (
            <div
              className={cn(
                "animate-spin rounded-full border-2 border-current border-t-transparent",
                sizes.container
              )}
            />
          )

        case "classic":
          return (
            <div className={cn("relative", sizes.container)}>
              {[...Array(8)].map((_, i) => (
                <div
                  key={i}
                  className="absolute left-1/2 top-0 h-1/3 w-0.5 -translate-x-1/2 rounded-full bg-current"
                  style={{
                    transform: `rotate(${i * 45}deg) translateY(100%)`,
                    opacity: 1 - i * 0.1,
                    animation: `spin 1s linear infinite`,
                    animationDelay: `${-i * 0.125}s`,
                  }}
                />
              ))}
            </div>
          )

        case "pulse":
          return (
            <div
              className={cn(
                "animate-pulse rounded-full bg-current",
                sizes.container
              )}
            />
          )

        case "pulse-dot":
          return (
            <div
              className={cn("rounded-full bg-current", sizes.element)}
              style={{
                animation: "pulse-dot 1.2s ease-in-out infinite",
              }}
            />
          )

        case "dots":
          return (
            <div className="flex items-center gap-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={cn("rounded-full bg-current", sizes.element)}
                  style={{
                    animation: "bounce 1.4s infinite ease-in-out both",
                    animationDelay: `${i * 0.16}s`,
                  }}
                />
              ))}
            </div>
          )

        case "typing":
          return (
            <div className="flex items-center gap-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={cn("rounded-full bg-current", sizes.element)}
                  style={{
                    animation: "typing 1.4s infinite ease-in-out",
                    animationDelay: `${i * 0.2}s`,
                  }}
                />
              ))}
            </div>
          )

        case "wave":
          return (
            <div className="flex items-end gap-0.5">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className={cn("w-1 rounded-full bg-current")}
                  style={{
                    height: size === "xl" ? "32px" : size === "lg" ? "24px" : size === "md" ? "18px" : "12px",
                    animation: "wave 1.2s infinite ease-in-out",
                    animationDelay: `${i * 0.1}s`,
                  }}
                />
              ))}
            </div>
          )

        case "bars":
          return (
            <div className="flex items-center gap-0.5">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={cn("w-1 rounded-sm bg-current")}
                  style={{
                    height: size === "xl" ? "28px" : size === "lg" ? "20px" : size === "md" ? "16px" : "12px",
                    animation: "bars 1s infinite ease-in-out",
                    animationDelay: `${i * 0.15}s`,
                  }}
                />
              ))}
            </div>
          )

        case "terminal":
          return (
            <span className="inline-block h-4 w-2 animate-smooth-blink bg-current" />
          )

        case "text-blink":
          return (
            <span className={cn("animate-gentle-pulse", sizes.text)}>{text || "Loading..."}</span>
          )

        case "text-shimmer":
          return (
            <span
              className={cn(
                "animate-shimmer bg-gradient-to-r from-current via-transparent to-current bg-[length:200%_100%] bg-clip-text text-transparent",
                sizes.text
              )}
            >
              {text || "Loading..."}
            </span>
          )

        case "brain":
          // AI brain thinking animation
          return (
            <div className={cn("relative", sizes.container)}>
              <Bot className="h-full w-full animate-gentle-pulse" />
              <div className="absolute -top-1 -right-1">
                <Sparkles className="h-3 w-3 animate-float text-primary" />
              </div>
            </div>
          )

        case "sparkle":
          // Sparkle effect animation
          return (
            <div className={cn("relative", sizes.container)}>
              <Sparkles className="h-full w-full animate-pulse" />
              <div className="absolute inset-0 animate-ping opacity-30">
                <Sparkles className="h-full w-full" />
              </div>
            </div>
          )

        case "orbit":
          // Orbiting dots
          return (
            <div className={cn("relative", sizes.container)}>
              <div className="absolute inset-0 animate-spin" style={{ animationDuration: "1.5s" }}>
                <div className={cn("absolute top-0 left-1/2 -translate-x-1/2 rounded-full bg-current", sizes.element)} />
              </div>
              <div className="absolute inset-0 animate-spin" style={{ animationDuration: "1.5s", animationDelay: "-0.5s" }}>
                <div className={cn("absolute top-0 left-1/2 -translate-x-1/2 rounded-full bg-current opacity-60", sizes.element)} />
              </div>
              <div className="absolute inset-0 animate-spin" style={{ animationDuration: "1.5s", animationDelay: "-1s" }}>
                <div className={cn("absolute top-0 left-1/2 -translate-x-1/2 rounded-full bg-current opacity-30", sizes.element)} />
              </div>
            </div>
          )

        default:
          return (
            <div className="flex items-center gap-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={cn(
                    "rounded-full bg-current",
                    sizes.element
                  )}
                  style={{
                    animation: "typing 1.4s infinite ease-in-out",
                    animationDelay: `${i * 0.15}s`,
                  }}
                />
              ))}
            </div>
          )
      }
    }

    return (
      <div
        ref={ref}
        role="status"
        aria-label="Loading"
        className={cn("flex items-center justify-center", colorClass, className)}
        {...props}
      >
        {renderLoader()}
        <span className="sr-only">Loading...</span>
      </div>
    )
  }
)

Loader.displayName = "Loader"

/**
 * PulseLoader - Three animated dots for "thinking" state
 * Convenience wrapper around Loader with pulse-dot variant
 */
type PulseLoaderProps = Omit<LoaderProps, "variant">;

const PulseLoader = React.forwardRef<HTMLDivElement, PulseLoaderProps>(
  ({ size = "md", ...props }, ref) => (
    <Loader ref={ref} variant="pulse-dot" size={size} {...props} />
  )
)
PulseLoader.displayName = "PulseLoader"

/**
 * TextShimmer - Animated text with shimmer effect
 * Convenience wrapper around Loader with text-shimmer variant
 */
interface TextShimmerLoaderProps extends Omit<LoaderProps, "variant"> {
  /** The text to display with shimmer effect */
  text: string
}

const TextShimmerLoader = React.forwardRef<HTMLDivElement, TextShimmerLoaderProps>(
  ({ text, ...props }, ref) => (
    <Loader ref={ref} variant="text-shimmer" text={text} {...props} />
  )
)
TextShimmerLoader.displayName = "TextShimmerLoader"

/**
 * AI Thinking Loader - Animated bot icon for AI processing
 */
const AIThinkingLoader = React.forwardRef<HTMLDivElement, Omit<LoaderProps, "variant">>(
  ({ size = "md", ...props }, ref) => (
    <Loader ref={ref} variant="brain" size={size} {...props} />
  )
)
AIThinkingLoader.displayName = "AIThinkingLoader"

/**
 * Inline loading text with dots
 * Shows "Loading..." with animated dots
 */
function LoadingText({
  text = "Loading",
  className,
}: {
  text?: string
  className?: string
}) {
  return (
    <span className={cn("text-muted-foreground", className)}>
      {text}
      <span className="inline-flex w-6 text-left">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="inline-block"
            style={{
              animation: "loading-dots 1.4s ease-in-out infinite",
              animationDelay: `${i * 0.2}s`,
            }}
          >
            .
          </span>
        ))}
      </span>
    </span>
  )
}

/**
 * Full screen loading overlay
 * Covers the entire viewport with a loading indicator
 */
function FullScreenLoader({
  text,
  variant = "brain",
}: {
  text?: string
  variant?: LoaderVariant
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/80 backdrop-blur-sm">
      <Loader variant={variant} size="xl" />
      {text && (
        <p className="mt-4 text-muted-foreground animate-gentle-pulse">{text}</p>
      )}
    </div>
  )
}

/**
 * Skeleton with shimmer - Premium loading placeholder
 */
function SkeletonShimmer({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-muted",
        "after:absolute after:inset-0 after:translate-x-[-100%]",
        "after:bg-gradient-to-r after:from-transparent after:via-white/20 after:to-transparent",
        "after:animate-[skeleton-glow_2s_infinite]",
        className
      )}
      {...props}
    />
  )
}

export {
  Loader,
  PulseLoader,
  TextShimmerLoader,
  AIThinkingLoader,
  LoadingText,
  FullScreenLoader,
  SkeletonShimmer,
  type LoaderVariant,
  type LoaderSize,
  type LoaderProps
}
