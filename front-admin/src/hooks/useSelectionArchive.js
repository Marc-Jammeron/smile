import { useCallback, useEffect, useRef, useState } from 'react'
import { ARCHIVE_POLL_INTERVAL_MS, ARCHIVE_STATUS, isArchivePending } from 'front-shared/src/archiveStatus.js'
import { getCollectionArchives, requestSelectionHdDownload, retryArchive } from '../api/archives.js'

// State of the retouching ZIP (selection in original quality) of a collection. The server
// builds it in the background: the status is read when the collection is shown, polled while
// the ZIP is prepared, and the file is downloaded by navigating to a presigned URL.
// `enabled`: only the collections being retouched have such a ZIP.
export default function useSelectionArchive(collectionId, enabled) {
    const [archive, setArchive] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const currentIdRef = useRef(collectionId)
    currentIdRef.current = collectionId

    const refresh = useCallback(async () => {
        const requestedId = collectionId
        try {
            const archives = await getCollectionArchives(requestedId)
            // Answers that arrive after the user moved to another collection are dropped.
            if (currentIdRef.current === requestedId) setArchive(archives.SELECTION_HD ?? null)
        } catch {
            // The status is a convenience: the next poll, or a click, will tell.
        }
    }, [collectionId])

    useEffect(() => {
        setArchive(null)
        setError(null)
        if (enabled) refresh()
    }, [collectionId, enabled, refresh])

    const status = archive?.status
    useEffect(() => {
        if (!enabled || !isArchivePending(status)) return undefined
        const timer = setInterval(refresh, ARCHIVE_POLL_INTERVAL_MS)
        return () => clearInterval(timer)
    }, [enabled, status, refresh])

    const download = async () => {
        setBusy(true)
        setError(null)
        try {
            const result = await requestSelectionHdDownload(collectionId)
            if (result.state === 'ready') {
                // The URL forces a download: the page stays where it is. No fetch, no CORS, no blob.
                window.location.assign(result.url)
            } else {
                // Being (re)built, or failed: show it at once, then read the details (error, size);
                // the polling takes over while it is prepared.
                const status = result.state === 'failed' ? ARCHIVE_STATUS.FAILED : result.status
                setArchive(current => ({ ...current, kind: 'SELECTION_HD', status }))
                await refresh()
            }
        } catch (downloadError) {
            console.error('Error downloading HD selection:', downloadError)
            setError(downloadError.message)
        } finally {
            setBusy(false)
        }
    }

    const retry = async () => {
        setBusy(true)
        setError(null)
        try {
            await retryArchive(collectionId, 'SELECTION_HD')
            await refresh()
        } catch (retryError) {
            console.error('Error retrying the HD selection ZIP:', retryError)
            setError(retryError.message)
        } finally {
            setBusy(false)
        }
    }

    return { archive, busy, error, clearError: () => setError(null), download, retry }
}
