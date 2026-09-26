"use client"

import { BackendAgentChat } from "@/modules/coding-agent/components/backend-agent-chat"
import { BackendAccessGate } from "@/modules/coding-agent/components/backend-access-gate"

export default function BackendAgentPage() {
  return (
    <BackendAccessGate>
      <BackendAgentChat />
    </BackendAccessGate>
  )
}
