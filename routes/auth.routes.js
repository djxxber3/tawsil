import express from "express";
import {
  register,
  login,
  verifyEmail,
  resendVerificationEmail,
  forgotPassword,
  resetPassword,
  getCurrentUser,
  changePassword,
  logout,
} from "../controllers/auth.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { validateRequest } from "../middleware/validation.middleware.js";
import {
  registerSchema,
  loginSchema,
  resetPasswordSchema,
  emailSchema,
  changePasswordSchema,
  verifyEmailCodeSchema,
} from "../validations/auth.validation.js";

const router = express.Router();

router.post("/register", validateRequest(registerSchema), register);
router.post("/login", validateRequest(loginSchema), login);
router.post("/verify-email", validateRequest(verifyEmailCodeSchema), verifyEmail);
router.post("/resend-verification", validateRequest(emailSchema), resendVerificationEmail);
router.post("/forgot-password", validateRequest(emailSchema), forgotPassword);
router.post("/reset-password/:token", validateRequest(resetPasswordSchema), resetPassword);

router.get("/verify", authenticate, getCurrentUser);
router.get("/me", authenticate, getCurrentUser);
router.put("/change-password", authenticate, validateRequest(changePasswordSchema), changePassword);
router.post("/logout", authenticate, logout);

export default router;
