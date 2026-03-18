import User from "../models/user.model.js";
import Driver from "../models/driver.model.js";
import { createError } from "../utils/error.utils.js";
import { sendSuccess } from "../utils/api-response.utils.js";
import crypto from "crypto";
import { sendVerificationEmail , sendPasswordResetEmail } from "../utils/email.utils.js";

const normalizeRole = (role) => {
  if (role === "passenger" || role === "user") {
    return "client"
  }

  return role
}

const buildVerificationCodePayload = () => {
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const codeHash = crypto.createHash("sha256").update(code).digest("hex")
  const codeExpires = new Date(Date.now() + 15 * 60 * 1000)

  return {
    code,
    codeHash,
    codeExpires,
  }
}

export const register = async (req, res, next) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      phone,
      role,
      licenseNumber,
      licenseExpiry,
      idCard,
      vehicleType,
      vehicleMake,
      vehicleModel,
      vehicleYear,
      vehicleColor,
      vehicleLicensePlate,
      vehicleInsuranceNumber,
      vehicleInsuranceExpiry,
    } = req.body;

    const normalizedRole = normalizeRole(role)

    
    if (!firstName || !lastName || !email || !password || !phone || !role) {
      return next(createError(400, "Tous les champs sont obligatoires"));
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return next(createError(400, "Un utilisateur avec cet email existe déjà"));
    }

    const { code, codeHash, codeExpires } = buildVerificationCodePayload()

    const user = new User({
      firstName,
      lastName,
      email,
      password,
      phone,
      role: normalizedRole,
      verificationCodeHash: codeHash,
      verificationCodeExpires: codeExpires,
    });

    await user.save();

    
    if (user.role === "driver") {
      if (
        !licenseNumber ||
        !licenseExpiry ||
        !idCard ||
        !vehicleType ||
        !vehicleMake ||
        !vehicleModel ||
        !vehicleYear ||
        !vehicleColor ||
        !vehicleLicensePlate ||
        !vehicleInsuranceNumber ||
        !vehicleInsuranceExpiry
      ) {
        return next(
          createError(400, "Tous les champs du conducteur sont obligatoires")
        );
      }

      const driver = new Driver({
        user: user._id,
        licenseNumber,
        licenseExpiry,
        idCard,
        vehicle: {
          type: vehicleType,
          make: vehicleMake,
          model: vehicleModel,
          year: vehicleYear,
          color: vehicleColor,
          licensePlate: vehicleLicensePlate,
          insuranceNumber: vehicleInsuranceNumber,
          insuranceExpiry: vehicleInsuranceExpiry,
        },
      });

      await driver.save();
    }

    const codeSent = await sendVerificationEmail(user.email, code)
    if (!codeSent) {
      return next(createError(503, "Unable to send verification code. Please retry."))
    }

    const userWithoutPassword = { ...user.toObject() }
    delete userWithoutPassword.password
    delete userWithoutPassword.verificationCodeHash
    delete userWithoutPassword.verificationCodeExpires

    return sendSuccess(
      res,
      201,
      "Registration successful. Please verify your email code before logging in.",
      { user: userWithoutPassword },
    )
  } catch (error) {
    next(error);
  }
};


export const login = async(req , res , next)=>{
  console.log("Données reçues dans req.body:", req.body);
  try{
    const {email , password} = req.body;
    if(!email || !password){
      return next(createError(401, "toute le champ oblogatoire"))
    }

    const user = await User.findOne({email}).select("+password")
    if(!user){
      return next(createError(401 , "Invalid email or password"))
    }

    const isPasswordValide = await user.comparePassword(password)
    if(!isPasswordValide){
      return next(createError(401 , "Invalid email or password"))
    }

 
    if (!user.isVerified) {
      return next(createError(403, "Please verify your email before logging in. Check your inbox for a verification code."))
    }

    const normalizedRole = normalizeRole(user.role)
    if (normalizedRole !== user.role) {
      user.role = normalizedRole
    }

    user.lastLogin = Date.now();
    await user.save();

    const token = user.generateAuthToken();

    const userWithoutPassword = { ...user.toObject() }
    delete userWithoutPassword.password
    delete userWithoutPassword.verificationCodeHash
    delete userWithoutPassword.verificationCodeExpires

    return sendSuccess(res, 201, "Login successful", {
      token,
      user: userWithoutPassword,
    })

  }catch(error){
    next(error)
  }
}


export const verifyEmail = async (req, res, next) => {
  try {
    const { email, code } = req.body

    const codeHash = crypto.createHash("sha256").update(String(code)).digest("hex")

    const user = await User.findOne({
      email,
      verificationCodeHash: codeHash,
      verificationCodeExpires: { $gt: new Date() },
    })

    if (!user) {
      return next(createError(400, "Invalid or expired verification code"))
    }

    user.isVerified = true
    user.verificationCodeHash = undefined
    user.verificationCodeExpires = undefined
    await user.save()

    return sendSuccess(res, 200, "Email verified successfully")
  } catch (error) {
    next(error)
  }
}

export const resendVerificationEmail = async(req , res , next)=>{

  try {
    const {email} = req.body;

    if (!email) {
      return next(createError(400, "EMAIL_REQUIRED"))
    }
    const user = await User.findOne({email})
    if(!user){
      return next(createError(404 , "EMAIL_NOT_FOUND"))
    }
    if(user.isVerified){
      return next(createError(400 , "EMAIL_ALREADY_VERIFIED"))
    }


    const { code, codeHash, codeExpires } = buildVerificationCodePayload()

    user.verificationCodeHash = codeHash
    user.verificationCodeExpires = codeExpires
    await user.save();

    const codeSent = await sendVerificationEmail(user.email, code)
    if (!codeSent) {
      return next(createError(503, "Unable to send verification code. Please retry."))
    }
    
    return sendSuccess(res, 201, "Verification code sent successfully")
  } catch (error) {
    next(error)
  }

}

export const forgotPassword = async(req , res , next)=>{
  try{
    const {email} = req.body;
    if(!email){
      return next(createError(400 , "EMAIL_REQUIRED"))
    }

    const user = await User.findOne({email})
    if(!user){
      return next(createError(404 , "EMAIL_NOT_FOUND"))
    }

    const resetToken = crypto.randomBytes(32).toString("hex")
    const resetTokenExpires = new Date(Date.now() + 1 * 60 * 60 * 1000)


    user.resetPasswordToken = resetToken
    user.resetPasswordExpires = resetTokenExpires
    await user.save();


    await sendPasswordResetEmail(user.email , resetToken);


    return sendSuccess(res, 200, "Password reset email sent successfully")
  }catch(error){
    next(error)

  }
}

export const resetPassword = async (req, res, next) => {
  try {
    const { token } = req.params
    const { password } = req.body

    
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    })

    if (!user) {
      return next(createError(400, "Invalid or expired reset token"))
    }

 
    user.password = password
    user.resetPasswordToken = undefined
    user.resetPasswordExpires = undefined
    await user.save()

    return sendSuccess(res, 200, "Password reset successfully")
  } catch (error) {
    next(error)
  }
}


export const getCurrentUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id)
    if (!user) {
      return next(createError(404, "User not found"))
    }

    return sendSuccess(res, 200, "Current user fetched successfully", { user })
  } catch (error) {
    next(error)
  }
}

export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body

    
    const user = await User.findById(req.user.id).select("+password")
    if (!user) {
      return next(createError(404, "User not found"))
    }

    
    const isPasswordValid = await user.comparePassword(currentPassword)
    if (!isPasswordValid) {
      return next(createError(401, "Current password is incorrect"))
    }

  
    user.password = newPassword
    await user.save()

    return sendSuccess(res, 200, "Password changed successfully")
  } catch (error) {
    next(error)
  }
}


export const logout = (req, res) => {
  return sendSuccess(res, 200, "Logged out successfully")
}