"use client"

import { useParams } from "next/navigation"
import { ModelingChatApp } from "@/modules/master-data-load/components/modeling-chat-app"
import { ModelingAccessGate } from "@/modules/master-data-load/components/modeling-access-gate"

export default function PackageLoaderPage() {
  const params = useParams<{ id: string }>()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  return (
    <ModelingAccessGate>
      <ModelingChatApp initialView="loader" loaderPackageId={id} />
    </ModelingAccessGate>
  )
}
