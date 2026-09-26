"use client"

import { ModelingChatApp } from "@/modules/master-data-load/components/modeling-chat-app"
import { ModelingAccessGate } from "@/modules/master-data-load/components/modeling-access-gate"

export default function ModelingAgentPage() {
  return (
    <ModelingAccessGate>
      <ModelingChatApp />
    </ModelingAccessGate>
  )
}
