import { useState } from 'react'
import CollectionColumn from './CollectionColumn.jsx'
import CollectionForm from './CollectionForm.jsx'
import { STATUS_OPTIONS } from 'front-shared/src/constants/collectionStatus.js'

export default function CollectionList({ collections, onSelectCollection, onCreateCollection, onChangeCollectionStatus }) {
    const [showForm, setShowForm] = useState(false)

    const handleCreate = async (data) => {
        await onCreateCollection(data)
        setShowForm(false)
    }

    return (
        <div>
            <div className="collection-list-header">
                {!showForm && (
                    <button className="create-button" onClick={() => setShowForm(true)}>
                        + Nouvelle collection
                    </button>
                )}
            </div>
            {showForm && (
                <CollectionForm onCreate={handleCreate} onCancel={() => setShowForm(false)} />
            )}
            <div className="collection-board">
                {STATUS_OPTIONS.map(status => (
                    <CollectionColumn
                        key={status}
                        status={status}
                        collections={collections.filter(collection => collection.status === status)}
                        onSelectCollection={onSelectCollection}
                        onChangeCollectionStatus={onChangeCollectionStatus}
                    />
                ))}
            </div>
        </div>
    )
}
