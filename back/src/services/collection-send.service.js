import { Op } from "sequelize";
import db from "../repository/db.repository.js";
import { updateCollection } from "./collection.service.js";
import logger from "../logger.js";

const log = logger.child("collection-send");

export const SEND_DEFERRED_MESSAGE = "Le lien sera disponible dès que toutes les photos seront prêtes.";

// Photos that still prevent the client link from being sent: anything not DONE (queued,
// being processed, or FAILED). Archived photos are soft-deleted, they don't count.
const countUnfinishedPhotos = (collectionId) => db.Photo.count({
    where: {
        collectionId,
        status: { [Op.ne]: 'ARCHIVED' },
        processingStatus: { [Op.ne]: 'DONE' }
    }
});

// Performs the DRAFT -> SELECTING transition of a collection whose link was requested,
// once every photo is DONE. Same service as the manual action (updateCollection), so the
// transition rules and the accessToken generation are identical. Idempotent: called after
// each photo goes DONE, by the periodic sweep and when the request is made.
// Returns true when the transition happened.
export const completeSendIfReady = async (collectionId) => {
    try {
        const collection = await db.Collection.findByPk(collectionId);
        if (!collection?.sendRequestedAt) {
            return false;
        }
        if (collection.status !== 'DRAFT') {
            // The collection was moved by hand while the request was pending: it is obsolete.
            await db.Collection.update({ sendRequestedAt: null }, { where: { id: collectionId } });
            log.info("Pending send request dropped: collection is no longer a DRAFT", { collectionId, status: collection.status });
            return false;
        }

        const unfinished = await countUnfinishedPhotos(collectionId);
        if (unfinished > 0) {
            log.debug("Send request still waiting for photos", { collectionId, unfinished });
            return false;
        }

        await updateCollection(collectionId, { status: 'SELECTING', sendRequestedAt: null });
        log.info("Pending send request completed: collection moved to SELECTING", { collectionId });
        return true;
    } catch (error) {
        log.failure("Could not complete the pending send request", error, { collectionId });
        return false;
    }
};

// Safety net for the cases the per-photo check can miss: worker interrupted between a
// photo going DONE and the check, FAILED photos retried or archived, request made while
// the last photo finished.
export const sweepSendRequests = async () => {
    const collections = await db.Collection.findAll({
        where: { sendRequestedAt: { [Op.ne]: null } },
        attributes: ['id']
    });
    let completed = 0;
    for (const { id } of collections) {
        if (await completeSendIfReady(id)) {
            completed += 1;
        }
    }
    if (collections.length > 0) {
        log.debug("Send requests swept", { pending: collections.length, completed });
    }
    return completed;
};

// The photographer's "send the link" action (PUT with status SELECTING). Resolves to
// { collection, deferred }: deferred is true when photos are still being processed, in
// which case the collection stays DRAFT with sendRequestedAt set. Any other change goes
// through updateCollection untouched.
export const updateCollectionOrDeferSend = async (id, changes) => {
    if (changes.status !== 'SELECTING') {
        return { collection: await updateCollection(id, changes), deferred: false };
    }

    const current = await db.Collection.findByPk(id);
    if (!current) {
        return { collection: null, deferred: false };
    }
    // Only the first link of a DRAFT is deferred; coming back to SELECTING from EDITING
    // works on photos that are already processed.
    if (current.status !== 'DRAFT') {
        return { collection: await updateCollection(id, changes), deferred: false };
    }

    if (await countUnfinishedPhotos(id) === 0) {
        return { collection: await updateCollection(id, { ...changes, sendRequestedAt: null }), deferred: false };
    }

    const { status, ...otherChanges } = changes;
    if (Object.keys(otherChanges).length > 0) {
        await updateCollection(id, otherChanges);
    }
    await db.Collection.update({ sendRequestedAt: new Date() }, { where: { id } });
    log.info("Send request deferred: photos are still being processed", { collectionId: id });

    // The last photos may have finished since the count above.
    if (await completeSendIfReady(id)) {
        return { collection: await db.Collection.findByPk(id), deferred: false };
    }
    return { collection: await db.Collection.findByPk(id), deferred: true };
};

// Returns the collection, or null when it does not exist. Harmless when nothing is pending.
export const cancelSendRequest = async (id) => {
    const [updatedRows] = await db.Collection.update({ sendRequestedAt: null }, { where: { id } });
    if (updatedRows === 0) {
        return null;
    }
    log.info("Send request cancelled", { collectionId: id });
    return db.Collection.findByPk(id);
};
