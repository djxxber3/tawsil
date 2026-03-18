import jwt from "jsonwebtoken"
import { createError } from "../utils/error.utils.js"
import User from "../models/user.model.js"
 ;

const normalizeLegacyRole = (role) => {
  if (role === "passenger" || role === "user") {
    return "client"
  }

  return role
}


export const authenticate = async (req, res, next) => {
  try {
    
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next(createError(401, "Authentication required. Please login."))
    }

    const token = authHeader.split(" ")[1]

  
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    
    const user = await User.findById(decoded.id)
    if (!user) {
      return next(createError(401, "Invalid token. User not found."))
    }

    const normalizedRole = normalizeLegacyRole(user.role)
    if (normalizedRole !== user.role) {
      user.role = normalizedRole
      await user.save()
    }

    
    if (!user.isActive) {
      return next(createError(401, "Your account has been deactivated."))
    }

    
    req.user = user
    next()
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      return next(createError(401, "Invalid token."))
    }
    if (error.name === "TokenExpiredError") {
      return next(createError(401, "Token expired. Please login again."))
    }
    next(error)
  }
}


