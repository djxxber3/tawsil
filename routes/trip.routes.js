import express from "express"
import {
  createTrip,
  getTripById,
  listAvailableTrips,
  listDriverTrips,
  updateTripStatus,
} from "../controllers/trip.controller.js"
import { authenticate } from "../middleware/auth.middleware.js"
import { authorize } from "../middleware/role.middleware.js"
import { validateRequest } from "../middleware/validation.middleware.js"
import {
  createTripSchema,
  updateTripStatusSchema,
} from "../validations/trip.validation.js"

const router = express.Router()

router.use(authenticate)

router.get("/available", authorize("client", "driver", "admin", "authority"), listAvailableTrips)
router.get("/driver/mine", authorize("driver"), listDriverTrips)
router.post("/", authorize("driver"), validateRequest(createTripSchema), createTrip)
router.patch("/:tripId/status", authorize("driver", "admin", "authority"), validateRequest(updateTripStatusSchema), updateTripStatus)
router.get("/:tripId", getTripById)

export default router
