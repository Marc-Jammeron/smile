export const STATUS_OPTIONS = ['DRAFT', 'SELECTING', 'EDITING', 'READY', 'ARCHIVED']

// Statuses a collection can be created in (must match CREATABLE_STATUSES in the backend).
export const CREATABLE_STATUS_OPTIONS = ['DRAFT', 'EDITING']

// Statuses a collection can be moved to from each status (must match
// ALLOWED_STATUS_TRANSITIONS in the backend). READY is only reached through the
// "Marquer comme prêt" button, and ARCHIVED is final.
export const ALLOWED_STATUS_TRANSITIONS = {
    DRAFT: ['SELECTING', 'EDITING', 'ARCHIVED'],
    SELECTING: ['DRAFT', 'EDITING', 'ARCHIVED'],
    EDITING: ['SELECTING', 'ARCHIVED'],
    READY: ['ARCHIVED'],
    ARCHIVED: []
}

export const STATUS = {
    DRAFT: 'DRAFT',
    SELECTING: 'SELECTING',
    EDITING: 'EDITING',
    READY: 'READY',
    ARCHIVED: 'ARCHIVED'
}

export const STATUS_LABELS = {
    DRAFT: 'Brouillon',
    SELECTING: 'Sélection',
    EDITING: 'Retouche',
    READY: 'Prête',
    ARCHIVED: 'Archivée'
}
