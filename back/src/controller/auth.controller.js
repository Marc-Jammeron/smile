import { verifyPhotographerCredentials } from '../services/auth.service.js';

export const loginController = async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const isValid = await verifyPhotographerCredentials(email, password);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        req.session.photographerId = email;
        res.json({ email });
    } catch (error) {
        res.status(500).json({ error: 'Failed to log in' });
    }
};

export const logoutController = (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            return res.status(500).json({ error: 'Failed to log out' });
        }
        res.clearCookie('connect.sid');
        res.status(204).send();
    });
};

export const meController = (req, res) => {
    res.json({ email: req.session.photographerId });
};
