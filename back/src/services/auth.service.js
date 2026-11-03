import argon2 from 'argon2';
import logger from '../logger.js';

const log = logger.child('auth.service');

export const verifyPhotographerCredentials = async (email, password) => {
    const expectedEmail = process.env.PHOTOGRAPHER_EMAIL;
    const expectedHash = process.env.PHOTOGRAPHER_PASSWORD_HASH;

    if (!expectedEmail || !expectedHash) {
        log.error('Photographer credentials are not configured (PHOTOGRAPHER_EMAIL / PHOTOGRAPHER_PASSWORD_HASH)');
        throw new Error('Photographer credentials are not configured');
    }

    if (email !== expectedEmail) {
        log.debug('Credentials check failed: unknown email');
        return false;
    }

    const isValid = await argon2.verify(expectedHash, password);
    log.debug('Credentials check done', { isValid });
    return isValid;
};
