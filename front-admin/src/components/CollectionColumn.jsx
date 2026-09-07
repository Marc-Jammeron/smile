import CollectionCard from './CollectionCard.jsx'
import { STATUS_LABELS } from 'front-shared/src/constants/collectionStatus.js'

export default function CollectionColumn({ status, collections, onSelectCollection, onChangeCollectionStatus }) {
    return (
        <div className="collection-column">
            <div className={`collection-column-header status-${status.toLowerCase()}`}>
                <span className="collection-column-dot" />
                <span className="collection-column-label">{STATUS_LABELS[status]}</span>
                <span className="collection-column-count">{collections.length}</span>
            </div>
            <div className="collection-column-body">
                {collections.map(collection => (
                    <CollectionCard
                        key={collection.id}
                        collection={collection}
                        onClick={() => onSelectCollection(collection)}
                        onChangeStatus={onChangeCollectionStatus}
                    />
                ))}
            </div>
        </div>
    )
}
