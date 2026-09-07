import express from 'express';
import { loginController, logoutController, meController } from '../controller/auth.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

export const authRouter = express.Router();

authRouter.post('/login', loginController);
authRouter.post('/logout', logoutController);
authRouter.get('/me', requireAuth, meController);
