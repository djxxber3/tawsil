import express from "express"
import {
  acceptDelivery,
  attachDeliveryToTrip,
  cancelDelivery,
  createDelivery,
  estimateDeliveryPrice,
  getDeliveryById,
  getDriverActiveDelivery,
  listAdminDeliveries,
  listDriverAvailableDeliveries,
  listUserDeliveries,
  markDeliveryCompleted,
  markPickupCompleted,
  rejectDelivery,
  updateDeliveryProgress,
  updateDriverLiveLocation,
  updatePaymentStatus,
} from "../controllers/delivery.controller.js"
import { authenticate } from "../middleware/auth.middleware.js"
import { authorize } from "../middleware/role.middleware.js"
import { validateRequest } from "../middleware/validation.middleware.js"
import {
  acceptDeliverySchema,
  attachDeliveryToTripSchema,
  cancelDeliverySchema,
  createDeliverySchema,
  estimateDeliveryPriceSchema,
  markDeliveredSchema,
  rejectDeliverySchema,
  updateDeliveryProgressSchema,
  updateDriverLocationSchema,
  updatePaymentStatusSchema,
} from "../validations/delivery.validation.js"

const router = express.Router()

router.use(authenticate)

router.post("/estimate", validateRequest(estimateDeliveryPriceSchema), estimateDeliveryPrice)
router.post("/", authorize("client"), validateRequest(createDeliverySchema), createDelivery)
router.get("/user", authorize("client"), listUserDeliveries)
router.get("/admin", authorize("admin", "authority"), listAdminDeliveries)
router.get("/driver/available", authorize("driver"), listDriverAvailableDeliveries)
router.get("/driver/active", authorize("driver"), getDriverActiveDelivery)
router.post("/driver/location", authorize("driver"), validateRequest(updateDriverLocationSchema), updateDriverLiveLocation)
router.post("/:deliveryId/accept", authorize("driver"), validateRequest(acceptDeliverySchema), acceptDelivery)
router.post("/:deliveryId/reject", authorize("driver"), validateRequest(rejectDeliverySchema), rejectDelivery)
router.post("/:deliveryId/cancel", validateRequest(cancelDeliverySchema), cancelDelivery)
router.patch("/:deliveryId/attach-trip", authorize("client"), validateRequest(attachDeliveryToTripSchema), attachDeliveryToTrip)
router.post("/:deliveryId/pickup-completed", authorize("driver"), markPickupCompleted)
router.post("/:deliveryId/progress", authorize("driver"), validateRequest(updateDeliveryProgressSchema), updateDeliveryProgress)
router.post("/:deliveryId/delivery-completed", authorize("driver"), validateRequest(markDeliveredSchema), markDeliveryCompleted)
router.patch("/:deliveryId/payment-status", authorize("admin", "authority"), validateRequest(updatePaymentStatusSchema), updatePaymentStatus)
router.get("/:deliveryId", getDeliveryById)

export default router
