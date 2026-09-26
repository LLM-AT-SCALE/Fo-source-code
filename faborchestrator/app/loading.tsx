import { PageLoadingSkeleton } from "@/shared/components/ui/skeleton-loaders"

/**
 * Global loading state shown during page transitions
 * Uses skeleton loader for a polished, professional feel
 */
export default function Loading() {
  return <PageLoadingSkeleton />
}
