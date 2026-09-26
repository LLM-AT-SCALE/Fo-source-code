"use client"

import { useRef, useCallback } from "react"

interface CacheEntry {
  content?: string
  blobUrl?: string
  arrayBuffer?: ArrayBuffer
  loading: boolean
  error?: string
}

// Listeners for cache updates so components can re-render
type CacheListener = () => void

export function useFileContent() {
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map())
  const _listenersRef = useRef<Set<CacheListener>>(new Set())
  const fetchingRef = useRef<Set<string>>(new Set())

  const getCache = useCallback((fileId: string): CacheEntry | null => {
    return cacheRef.current.get(fileId) ?? null
  }, [])

  // `downloadUrl` overrides where the bytes come from. Defaults to the
  // Anthropic Files API; the Modeling Agent's generated .xlsx files pass their
  // own staged-file endpoint instead.
  const fetchFileContent = useCallback(async (fileId: string, mimeType?: string, downloadUrl?: string): Promise<string> => {
    // Return cached content if available
    const cached = cacheRef.current.get(fileId)
    if (cached?.content) return cached.content
    if (cached?.blobUrl) return cached.blobUrl

    // Prevent duplicate fetches
    if (fetchingRef.current.has(fileId)) {
      // Wait for the existing fetch to complete
      return new Promise((resolve, reject) => {
        const check = () => {
          const entry = cacheRef.current.get(fileId)
          if (entry && !entry.loading) {
            if (entry.error) reject(new Error(entry.error))
            else resolve(entry.content || entry.blobUrl || '')
            return
          }
          setTimeout(check, 100)
        }
        check()
      })
    }

    fetchingRef.current.add(fileId)
    cacheRef.current.set(fileId, { loading: true })

    try {
      const token = localStorage.getItem("llmatscale_auth_token")
      const res = await fetch(downloadUrl ?? `/api/files/${fileId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}))
        throw new Error(errorData.error || `Download failed (${res.status})`)
      }

      const isBinary = mimeType?.startsWith('image/') || mimeType === 'application/pdf'
      const isTextual = !isBinary

      if (isTextual) {
        const text = await res.text()
        cacheRef.current.set(fileId, { content: text, loading: false })
        fetchingRef.current.delete(fileId)
        return text
      } else {
        const blob = await res.blob()
        const blobUrl = URL.createObjectURL(blob)
        cacheRef.current.set(fileId, { blobUrl, loading: false })
        fetchingRef.current.delete(fileId)
        return blobUrl
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to load file'
      cacheRef.current.set(fileId, { loading: false, error: errorMsg })
      fetchingRef.current.delete(fileId)
      throw err
    }
  }, [])

  const arrayBufferCacheRef = useRef<Map<string, ArrayBuffer>>(new Map())
  const arrayBufferFetchingRef = useRef<Set<string>>(new Set())

  const fetchFileArrayBuffer = useCallback(async (fileId: string, downloadUrl?: string): Promise<ArrayBuffer> => {
    // Return cached ArrayBuffer if available
    const cached = arrayBufferCacheRef.current.get(fileId)
    if (cached) return cached

    // Prevent duplicate fetches
    if (arrayBufferFetchingRef.current.has(fileId)) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const entry = arrayBufferCacheRef.current.get(fileId)
          if (entry) {
            resolve(entry)
            return
          }
          if (!arrayBufferFetchingRef.current.has(fileId)) {
            reject(new Error('Fetch failed'))
            return
          }
          setTimeout(check, 100)
        }
        check()
      })
    }

    arrayBufferFetchingRef.current.add(fileId)

    try {
      const token = localStorage.getItem("llmatscale_auth_token")
      const res = await fetch(downloadUrl ?? `/api/files/${fileId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}))
        throw new Error(errorData.error || `Download failed (${res.status})`)
      }

      const arrayBuffer = await res.arrayBuffer()
      arrayBufferCacheRef.current.set(fileId, arrayBuffer)
      arrayBufferFetchingRef.current.delete(fileId)
      return arrayBuffer
    } catch (err) {
      arrayBufferFetchingRef.current.delete(fileId)
      throw err
    }
  }, [])

  return { fetchFileContent, fetchFileArrayBuffer, getCache }
}
