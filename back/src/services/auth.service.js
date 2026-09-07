import argon2 from 'argon2';

export const verifyPhotographerCredentials = async (email, password) => {
    const expectedEmail = process.env.PHOTOGRAPHER_EMAIL;
    const expectedHash = process.env.PHOTOGRAPHER_PASSWORD_HASH;

    if (!expectedEmail || !expectedHash) {
        throw new Error('Photographer credentials are not configured');
    }

    if (email !== expectedEmail) {
        return false;
    }

    return argon2.verify(expectedHash, password);
};
