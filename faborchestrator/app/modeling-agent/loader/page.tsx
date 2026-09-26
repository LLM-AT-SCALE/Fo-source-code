"use client"

import { useSearchParams } from "next/navigation"
import { ModelingChatApp } from "@/modules/master-data-load/components/modeling-chat-app"
import { ModelingAccessGate } from "@/modules/master-data-load/components/modeling-access-gate"

export default function MasterDataLoaderPage() {
  const draft = useSearchParams().get("draft") ?? undefined
  return (
    <ModelingAccessGate>
      <ModelingChatApp initialView="loader" loaderDraftId={draft} />
    </ModelingAccessGate>
  )
}
