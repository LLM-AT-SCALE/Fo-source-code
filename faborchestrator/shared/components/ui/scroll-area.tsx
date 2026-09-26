"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

import { cn } from "@/shared/lib/utils"

type ScrollAreaOrientation = "both" | "horizontal" | "vertical"

function setRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    ref(value)
  } else if (ref) {
    ref.current = value
  }
}

function ScrollArea({
  className,
  children,
  orientation = "both",
  scrollbarGutter = false,
  viewportClassName,
  viewportProps,
  viewportRef,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  orientation?: ScrollAreaOrientation
  scrollbarGutter?: boolean
  viewportClassName?: string
  viewportProps?: React.ComponentPropsWithoutRef<
    typeof ScrollAreaPrimitive.Viewport
  > & { ref?: React.Ref<HTMLDivElement> }
  viewportRef?: React.Ref<HTMLDivElement>
}) {
  const internalViewportRef = React.useRef<HTMLDivElement | null>(null)
  const [hasOverflow, setHasOverflow] = React.useState({ x: false, y: false })
  const {
    className: suppliedViewportClassName,
    ref: suppliedViewportRef,
    style: suppliedViewportStyle,
    ...resolvedViewportProps
  } = viewportProps ?? {}
  const {
    overflow,
    overflowX: suppliedOverflowX,
    overflowY: suppliedOverflowY,
    ...resolvedViewportStyle
  } = suppliedViewportStyle ?? {}
  const normalizedOverflowX =
    suppliedOverflowX ?? (overflow as React.CSSProperties["overflowX"])
  const normalizedOverflowY =
    suppliedOverflowY ?? (overflow as React.CSSProperties["overflowY"])

  // Radix controls overflowX/overflowY on its viewport. Extend supplies the
  // equivalent `overflow` shorthand, and React warns when both forms coexist
  // across renders. Forward only the axis-specific properties.
  const viewportStyle: React.CSSProperties = {
    ...resolvedViewportStyle,
    ...(overflow !== undefined || suppliedOverflowX !== undefined
      ? { overflowX: normalizedOverflowX }
      : {}),
    ...(overflow !== undefined || suppliedOverflowY !== undefined
      ? { overflowY: normalizedOverflowY }
      : {}),
  }

  React.useEffect(() => {
    const viewport = internalViewportRef.current
    if (!viewport) return

    const updateOverflow = () => {
      setHasOverflow({
        x: viewport.scrollWidth > viewport.clientWidth,
        y: viewport.scrollHeight > viewport.clientHeight,
      })
    }

    updateOverflow()
    const resizeObserver = new ResizeObserver(updateOverflow)
    resizeObserver.observe(viewport)
    if (viewport.firstElementChild) {
      resizeObserver.observe(viewport.firstElementChild)
    }

    return () => resizeObserver.disconnect()
  }, [children])

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        data-has-overflow-x={hasOverflow.x || undefined}
        data-has-overflow-y={hasOverflow.y || undefined}
        ref={(node) => {
          internalViewportRef.current = node
          setRef(suppliedViewportRef, node)
          setRef(viewportRef, node)
        }}
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          scrollbarGutter && "[scrollbar-gutter:stable]",
          viewportClassName,
          suppliedViewportClassName
        )}
        style={viewportStyle}
        {...resolvedViewportProps}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {orientation !== "horizontal" ? <ScrollBar orientation="vertical" /> : null}
      {orientation !== "vertical" ? <ScrollBar orientation="horizontal" /> : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" &&
          "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
