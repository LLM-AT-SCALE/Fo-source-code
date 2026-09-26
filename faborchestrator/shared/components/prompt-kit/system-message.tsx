"use client"

import * as React from "react"
import { cn } from "@/shared/lib/utils"
import { Button } from "@/shared/components/ui/button"
import {
  Info,
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  X,
} from "lucide-react"
import { motion, AnimatePresence } from "motion/react"

type SystemMessageVariant = "info" | "action" | "warning" | "error" | "success"

interface SystemMessageCTA {
  label: string
  onClick: () => void
}

interface SystemMessageProps {
  className?: string
  variant?: SystemMessageVariant
  cta?: SystemMessageCTA
  dismissible?: boolean
  onDismiss?: () => void
  icon?: React.ReactNode
  children?: React.ReactNode
}

const variantStyles: Record<
  SystemMessageVariant,
  { container: string; icon: React.ReactNode }
> = {
  info: {
    container: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200",
    icon: <Info className="h-4 w-4" />,
  },
  action: {
    container: "border-primary/30 bg-primary/5 text-primary dark:bg-primary/10",
    icon: <Info className="h-4 w-4" />,
  },
  warning: {
    container: "border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200",
    icon: <AlertTriangle className="h-4 w-4" />,
  },
  error: {
    container: "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200",
    icon: <AlertCircle className="h-4 w-4" />,
  },
  success: {
    container: "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-200",
    icon: <CheckCircle className="h-4 w-4" />,
  },
}

const SystemMessage = React.forwardRef<HTMLDivElement, SystemMessageProps>(
  (
    {
      className,
      variant = "info",
      cta,
      dismissible = false,
      onDismiss,
      icon,
      children,
    },
    ref
  ) => {
    const [isVisible, setIsVisible] = React.useState(true)

    const handleDismiss = () => {
      setIsVisible(false)
      onDismiss?.()
    }

    const styles = variantStyles[variant]

    return (
      <AnimatePresence>
        {isVisible && (
          <motion.div
            ref={ref}
            initial={{ opacity: 0, y: -10, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: -10, height: 0 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "mx-auto my-2 flex w-full max-w-3xl items-center gap-3 rounded-lg border px-4 py-3 text-sm",
              styles.container,
              className
            )}
          >
            <div className="shrink-0">{icon || styles.icon}</div>
            <div className="flex-1">{children}</div>
            {cta && (
              <Button
                variant={variant === "error" ? "destructive" : "outline"}
                size="sm"
                onClick={cta.onClick}
                className="shrink-0"
              >
                {cta.label}
              </Button>
            )}
            {dismissible && (
              <Button
                type="button"
                variant="ghost"
                onClick={handleDismiss}
                className="h-auto w-auto shrink-0 rounded border-0 bg-transparent p-1 opacity-70 transition-opacity hover:bg-transparent hover:opacity-100 active:scale-100 dark:hover:bg-transparent"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Dismiss</span>
              </Button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    )
  }
)

SystemMessage.displayName = "SystemMessage"

export { SystemMessage, type SystemMessageVariant, type SystemMessageCTA }
