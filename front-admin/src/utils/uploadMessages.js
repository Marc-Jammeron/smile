
const MAX_LISTED_NAMES = 8

export const plural = (count, singular, pluralForm = `${singular}s`) => (count > 1 ? pluralForm : singular)

export function listNames(names) {
    if (names.length <= MAX_LISTED_NAMES) return names.join(', ')
    return `${names.slice(0, MAX_LISTED_NAMES).join(', ')} … et ${names.length - MAX_LISTED_NAMES} autre(s)`
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 Mo'
    const mo = bytes / (1024 * 1024)
    if (mo < 1024) return `${mo < 10 ? mo.toFixed(1) : Math.round(mo)} Mo`
    return `${(mo / 1024).toFixed(1)} Go`
}

const describeCause = (cause) => {
    switch (cause?.kind) {
        case 'network': return 'connexion interrompue'
        case 'timeout': return 'délai dépassé'
        case 'server': return cause.status ? `erreur serveur ${cause.status}` : 'erreur serveur'
        case 'expired': return 'lien d\'envoi expiré'
        case 'auth': return 'session expirée'
        case 'conflict': return 'galerie modifiée'
        case 'client': return cause.status ? `refusé (${cause.status})` : 'refusé'
        default: return 'erreur inconnue'
    }
}

export function describeFatalCause(cause) {
    if (cause?.kind === 'auth') return 'Session expirée : reconnectez-vous, puis relancez les échecs.'
    if (cause?.kind === 'conflict') {
        return 'La galerie a changé de statut pendant l\'envoi : l\'ajout n\'est plus possible.'
    }
    return null
}

export function describeFailure(failure) {
    const names = listNames(failure.filenames ?? [])
    const where = failure.batchCount > 1 ? ` (groupe ${failure.batch}/${failure.batchCount})` : ''
    const fatal = describeFatalCause(failure.cause)

    switch (failure.kind) {
        case 'reload':
            return 'Impossible de vérifier les photos déjà présentes (connexion ou serveur indisponible) : rien n\'a été envoyé.'
        case 'presign':
            if (fatal) return fatal
            if (failure.cause?.kind === 'client') {
                return `Le serveur a refusé de préparer l'envoi${where} : ${names}.`
            }
            return `Impossible de contacter le serveur pour préparer l'envoi${where}. Vérifiez la connexion puis relancez. Fichiers concernés : ${names}.`
        case 'put':
            return `Échec de l'envoi vers le stockage : ${names} (${describeCause(failure.cause)}).`
        case 'confirm':
            if (fatal) return `${fatal} Fichiers non enregistrés : ${names}.`
            return `Le serveur n'a pas enregistré : ${names}${where}.`
        case 'attachment':
            return `Photo enregistrée, mais fichier(s) associé(s) non rattaché(s) : ${names}.`
        case 'confirm-uncertain':
            if (failure.attachmentsOnly) {
                return `Résultat incertain pour le rattachement de : ${names}${where}. Le serveur n'a pas répondu ; vérifiez la photo concernée avant de renvoyer ces fichiers.`
            }
            return `Résultat incertain pour : ${names}${where}. Le serveur n'a pas répondu à la confirmation et ${failure.reloadFailed ? 'la liste n\'a pas pu être rechargée pour vérifier' : 'ces photos n\'apparaissent pas dans la liste rechargée'}. Elles peuvent encore apparaître dans quelques minutes ; sinon, « Relancer les échecs » les renverra (les photos déjà présentes sont ignorées).`
        case 'not-attempted':
            return `Non envoyés (l'envoi s'est arrêté avant) : ${names}.`
        default:
            return `Échec : ${names}.`
    }
}

export const countFailedFiles = (report) =>
    new Set(report.failed.flatMap((failure) => failure.filenames ?? [])).size

export const isCleanReport = (report) =>
    !!report
    && report.failed.length === 0
    && report.skipped.length === 0
    && report.recovered.length === 0
    && !report.fatal
    && !report.aborted
    && report.sentPhotos + report.sentAttachments > 0

export function summarizeReport(report) {
    const failedFiles = countFailedFiles(report)
    const sent = `${report.sentPhotos} ${plural(report.sentPhotos, 'photo envoyée', 'photos envoyées')}`
        + (report.sentAttachments > 0 ? ` (+ ${report.sentAttachments} ${plural(report.sentAttachments, 'fichier associé', 'fichiers associés')})` : '')
    const skipped = `${report.skipped.length} ${plural(report.skipped.length, 'ignorée', 'ignorées')} (déjà ${plural(report.skipped.length, 'présente', 'présentes')})`
    const failed = `${failedFiles} en échec`
    const headline = `${sent} · ${skipped} · ${failed}`

    const lines = []
    if (report.aborted) {
        lines.push('Envoi interrompu à votre demande : les groupes restants n\'ont pas été envoyés.')
    }
    if (report.skipped.length > 0) {
        const skippedNames = listNames(report.skipped.map((item) => item.filename))
        lines.push(`${report.skipped.length} ${plural(report.skipped.length, 'photo déjà présente ignorée', 'photos déjà présentes ignorées')} : ${skippedNames}. RAW/XMP des photos déjà présentes non revérifiés.`)
    }
    if (report.recovered.length > 0) {
        const recoveredNames = listNames(report.recovered.map((item) => item.filename))
        lines.push(`Enregistrées malgré l'erreur de réponse : ${recoveredNames}. RAW/XMP de ces photos non revérifiés.`)
    }
    for (const failure of report.failed) {
        lines.push(failure.message ?? describeFailure(failure))
    }
    return { headline, lines }
}
