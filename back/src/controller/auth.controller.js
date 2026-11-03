import { verifyPhotographerCredentials } from '../services/auth.service.js';
import logger from '../logger.js';

const log = logger.child('auth.controller');

export const loginController = async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        log.warn('Login rejected: missing email or password', { ip: req.ip });
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const isValid = await verifyPhotographerCredentials(email, password);
        if (!isValid) {
            // L'email saisi n'est pas loggué : les gens y collent parfois leur mot de passe.
            log.warn('Login failed: invalid credentials', { ip: req.ip });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        req.session.photographerId = email;
        log.info('Photographer logged in', { ip: req.ip });
        res.json({ email });
    } catch (error) {
        log.error('Login failed with an unexpected error', error);
        res.status(500).json({ error: 'Failed to log in' });
    }
};

export const logoutController = (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            log.error('Failed to destroy session on logout', error);
            return res.status(500).json({ error: 'Failed to log out' });
        }
        res.clearCookie('connect.sid');
        log.info('Photographer logged out');
        res.status(204).send();
    });
};

export const meController = (req, res) => {
    log.debug('Current session requested');
    res.json({ email: req.session.photographerId });
};
