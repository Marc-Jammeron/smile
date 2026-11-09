export class StepError extends Error {
    constructor(message, { kind, status = null, retryable = false, serverMessage = null, cause } = {}) {
        super(message, cause ? { cause } : undefined)
        this.name = 'StepError'
        this.kind = kind
        this.status = status
        this.retryable = retryable
        this.serverMessage = serverMessage
    }
}

export function classifyHttpStatus(status) {
    if (status === 401) return { kind: 'auth', retryable: false }
    if (status === 409) return { kind: 'conflict', retryable: false }
    if (status >= 500) return { kind: 'server', retryable: true }
    return { kind: 'client', retryable: false }
}

export const isAmbiguousKind = (kind) => kind === 'network' || kind === 'timeout' || kind === 'server'
