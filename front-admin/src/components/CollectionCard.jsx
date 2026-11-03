import { useState } from 'react'
import { STATUS_OPTIONS, STATUS_LABELS, ALLOWED_STATUS_TRANSITIONS } from 'front-shared/src/constants/collectionStatus.js'

export default function CollectionCard({ collection, onClick, onChangeStatus }) {
    const [updating, setUpdating] = useState(false)

    const handleStatusChange = async (event) => {
        event.stopPropagation()
        const status = event.target.value
        setUpdating(true)
        try {
            await onChangeStatus(collection.id, status)
        } catch (error) {
            console.error('Error updating collection status:', error)
            alert('Le changement de statut a échoué')
        } finally {
            setUpdating(false)
        }
    }

    const photoCount = collection.Photos?.length ?? 0
    const reachableStatuses = ALLOWED_STATUS_TRANSITIONS[collection.status] ?? []
    const statusChoices = STATUS_OPTIONS.filter(option => option === collection.status || reachableStatuses.includes(option))

    return (
        <div className="collection-card" onClick={onClick}>
            <h4 className="collection-card-title">{collection.name}</h4>
            <p className="collection-card-client">{collection.clientName}</p>
            <div className="collection-card-footer">
                <span className="collection-card-photo-count">{photoCount} photo{photoCount > 1 ? 's' : ''}</span>
                <div className={`collection-card-status status-${collection.status?.toLowerCase()}`}>
                    <select
                        value={collection.status}
                        disabled={updating || reachableStatuses.length === 0}
                        onClick={(event) => event.stopPropagation()}
                        onChange={handleStatusChange}
                    >
                        {statusChoices.map(option => (
                            <option key={option} value={option}>{STATUS_LABELS[option]}</option>
                        ))}
                    </select>
                </div>
            </div>
        </div>
    )
}
