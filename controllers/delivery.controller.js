import Delivery from "../models/delivery.model.js"
import Driver from "../models/driver.model.js"
import Trip from "../models/trip.model.js"
import { createError } from "../utils/error.utils.js"
import { sendSuccess } from "../utils/api-response.utils.js"
import { calculateDeliveryMvpPrice } from "../utils/pricing.utils.js"
import { getRouteDistance } from "../utils/maps-routing.utils.js"
import { createNotification } from "../utils/notification.utils.js"
import {
  DELIVERY_STATUS,
  canTransitionDeliveryStatus,
  isTerminalDeliveryStatus,
} from "../utils/delivery-status.utils.js"

const activeDriverStatuses = [
  DELIVERY_STATUS.ACCEPTED,
  DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP,
  DELIVERY_STATUS.PICKED_UP,
  DELIVERY_STATUS.IN_TRANSIT,
  DELIVERY_STATUS.ARRIVED_DROPOFF,
]

const statusToTimelineField = {
  [DELIVERY_STATUS.ACCEPTED]: "timeline.acceptedAt",
  [DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP]: "timeline.driverArrivedPickupAt",
  [DELIVERY_STATUS.PICKED_UP]: "timeline.pickedUpAt",
  [DELIVERY_STATUS.IN_TRANSIT]: "timeline.inTransitAt",
  [DELIVERY_STATUS.ARRIVED_DROPOFF]: "timeline.arrivedDropoffAt",
  [DELIVERY_STATUS.DELIVERED]: "timeline.deliveredAt",
  [DELIVERY_STATUS.CANCELLED_BY_USER]: "timeline.cancelledAt",
  [DELIVERY_STATUS.CANCELLED_BY_DRIVER]: "timeline.cancelledAt",
  [DELIVERY_STATUS.FAILED_DELIVERY]: "timeline.failedAt",
  [DELIVERY_STATUS.REFUNDED]: "timeline.refundedAt",
}

const toLatLng = (coordinates) => ({
  lng: Number(coordinates?.[0]),
  lat: Number(coordinates?.[1]),
})

const getDeliveryForUser = async (deliveryId, userId, role) => {
  const delivery = await Delivery.findById(deliveryId)
    .populate("sender", "firstName lastName phone")
    .populate({
      path: "assignedDriver",
      populate: {
        path: "user",
        select: "firstName lastName phone rating",
      },
    })
    .populate("trip")

  if (!delivery) {
    throw createError(404, "Delivery not found")
  }

  const isOwner = delivery.sender._id.equals(userId)
  const isAdminLike = role === "admin" || role === "authority"

  let isAssignedDriver = false
  if (delivery.assignedDriver) {
    isAssignedDriver = delivery.assignedDriver.user._id.equals(userId)
  }

  if (!isOwner && !isAssignedDriver && !isAdminLike) {
    throw createError(403, "You are not authorized to access this delivery")
  }

  return delivery
}

const buildPrice = async ({ pickupCoordinates, dropoffCoordinates, packageInfo, isUrgent = false }) => {
  let distance
  try {
    const route = await getRouteDistance(toLatLng(pickupCoordinates), toLatLng(dropoffCoordinates))
    distance = route.distanceMeters
  } catch (error) {
    throw createError(503, "Delivery pricing is temporarily unavailable.", {
      code: "ROUTING_SERVICE_UNAVAILABLE",
      providerMessage: error?.message || "Routing provider unavailable",
    })
  }

  const distanceKm = distance / 1000

  const computed = calculateDeliveryMvpPrice({
    distanceKm,
    sizeCategory: packageInfo.sizeCategory,
    weightKg: packageInfo.weightKg,
    isUrgent,
  })

  return {
    ...computed,
    distanceMeters: distance,
    distanceKm: Math.round(distanceKm * 100) / 100,
  }
}

const findAttachableTrip = async ({ tripId, driverId = null }) => {
  const query = {
    _id: tripId,
    status: { $in: ["planned", "active"] },
    availableCapacity: { $gt: 0 },
  }

  if (driverId) {
    query.driver = driverId
  }

  return Trip.findOne(query)
}

const updateStatusWithGuard = async ({ delivery, nextStatus }) => {
  if (!canTransitionDeliveryStatus(delivery.status, nextStatus)) {
    throw createError(400, `Invalid status transition from ${delivery.status} to ${nextStatus}`)
  }

  delivery.status = nextStatus
  const timelineField = statusToTimelineField[nextStatus]
  if (timelineField) {
    const [root, key] = timelineField.split(".")
    if (!delivery[root]) {
      delivery[root] = {}
    }
    delivery[root][key] = new Date()
  }

  return delivery
}

const releaseAssignmentResources = async (delivery) => {
  if (delivery.assignedDriver) {
    const driver = await Driver.findById(delivery.assignedDriver)
    if (driver) {
      if (driver.currentRide && driver.currentRide.equals(delivery._id)) {
        driver.currentRide = null
      }
      driver.isAvailable = true
      await driver.save()
    }
  }

  if (delivery.trip) {
    await Trip.findByIdAndUpdate(delivery.trip, { $inc: { availableCapacity: 1 } })
  }
}

export const estimateDeliveryPrice = async (req, res, next) => {
  try {
    const pricing = await buildPrice({
      pickupCoordinates: req.body.pickup.location.coordinates,
      dropoffCoordinates: req.body.dropoff.location.coordinates,
      packageInfo: req.body.package,
      isUrgent: req.body.isUrgent,
    })

    return sendSuccess(res, 200, "Delivery price estimated successfully", {
      pricing,
    })
  } catch (error) {
    next(error)
  }
}

export const createDelivery = async (req, res, next) => {
  try {
    let attachedTrip = null
    if (req.body.tripId) {
      attachedTrip = await findAttachableTrip({ tripId: req.body.tripId })
      if (!attachedTrip) {
        return next(createError(400, "Selected trip is not available for attachment"))
      }
    }

    const pricing = await buildPrice({
      pickupCoordinates: req.body.pickup.location.coordinates,
      dropoffCoordinates: req.body.dropoff.location.coordinates,
      packageInfo: req.body.package,
      isUrgent: req.body.isUrgent,
    })

    const delivery = await Delivery.create({
      sender: req.user.id,
      pickup: {
        address: req.body.pickup.address,
        location: {
          type: "Point",
          coordinates: req.body.pickup.location.coordinates,
        },
      },
      dropoff: {
        address: req.body.dropoff.address,
        location: {
          type: "Point",
          coordinates: req.body.dropoff.location.coordinates,
        },
      },
      recipient: req.body.recipient,
      package: req.body.package,
      deliveryNote: req.body.deliveryNote,
      pricing: {
        baseFee: pricing.baseFee,
        distanceFee: pricing.distanceFee,
        weightSurcharge: pricing.weightSurcharge,
        sizeSurcharge: pricing.sizeSurcharge,
        urgentSurcharge: pricing.urgentSurcharge,
        estimatedPrice: pricing.estimatedPrice,
      },
      payment: {
        method: req.body.paymentMethod,
        status: req.body.paymentMethod === "cash" ? "cash_pending" : "pending",
      },
      trip: attachedTrip ? attachedTrip._id : null,
      status: DELIVERY_STATUS.PENDING,
      isUrgent: !!req.body.isUrgent,
    })

    return sendSuccess(res, 201, "Delivery created successfully", { delivery })
  } catch (error) {
    next(error)
  }
}

export const listUserDeliveries = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 10 } = req.query
    const skip = (Number(page) - 1) * Number(limit)

    const query = { sender: req.user.id }
    if (status) {
      query.status = status
    }

    const deliveries = await Delivery.find(query)
      .populate({
        path: "assignedDriver",
        populate: {
          path: "user",
          select: "firstName lastName phone rating",
        },
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))

    const total = await Delivery.countDocuments(query)

    return sendSuccess(res, 200, "User deliveries fetched successfully", {
      deliveries,
      pagination: {
        total,
        page: Number(page),
        pages: Math.ceil(total / Number(limit)),
        limit: Number(limit),
      },
    })
  } catch (error) {
    next(error)
  }
}

export const listAdminDeliveries = async (req, res, next) => {
  try {
    const {
      status,
      senderId,
      assignedDriverId,
      tripId,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = req.query

    const skip = (Number(page) - 1) * Number(limit)
    const query = {}

    if (status) {
      query.status = status
    }
    if (senderId) {
      query.sender = senderId
    }
    if (assignedDriverId) {
      query.assignedDriver = assignedDriverId
    }
    if (tripId) {
      query.trip = tripId
    }
    if (startDate || endDate) {
      query.createdAt = {}
      if (startDate) {
        query.createdAt.$gte = new Date(startDate)
      }
      if (endDate) {
        query.createdAt.$lte = new Date(endDate)
      }
    }

    const deliveries = await Delivery.find(query)
      .populate("sender", "firstName lastName phone")
      .populate({
        path: "assignedDriver",
        populate: {
          path: "user",
          select: "firstName lastName phone",
        },
      })
      .populate("trip")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))

    const total = await Delivery.countDocuments(query)

    return sendSuccess(res, 200, "Admin delivery list fetched successfully", {
      deliveries,
      pagination: {
        total,
        page: Number(page),
        pages: Math.ceil(total / Number(limit)),
        limit: Number(limit),
      },
    })
  } catch (error) {
    next(error)
  }
}

export const getDeliveryById = async (req, res, next) => {
  try {
    const delivery = await getDeliveryForUser(req.params.deliveryId, req.user.id, req.user.role)

    return sendSuccess(res, 200, "Delivery fetched successfully", { delivery })
  } catch (error) {
    next(error)
  }
}

export const attachDeliveryToTrip = async (req, res, next) => {
  try {
    const delivery = await Delivery.findById(req.params.deliveryId)

    if (!delivery) {
      return next(createError(404, "Delivery not found"))
    }

    if (!delivery.sender.equals(req.user.id)) {
      return next(createError(403, "Only delivery owner can attach this delivery to a trip"))
    }

    if (delivery.status !== DELIVERY_STATUS.PENDING || delivery.assignedDriver) {
      return next(createError(400, "Only unassigned pending deliveries can be attached to a trip"))
    }

    const trip = await findAttachableTrip({ tripId: req.body.tripId })
    if (!trip) {
      return next(createError(400, "Selected trip is not available for attachment"))
    }

    delivery.trip = trip._id
    await delivery.save()

    return sendSuccess(res, 200, "Delivery attached to trip successfully", { delivery })
  } catch (error) {
    next(error)
  }
}

export const cancelDelivery = async (req, res, next) => {
  try {
    const delivery = await Delivery.findById(req.params.deliveryId)

    if (!delivery) {
      return next(createError(404, "Delivery not found"))
    }

    const ownerCancelAllowed = [DELIVERY_STATUS.DRAFT, DELIVERY_STATUS.PENDING, DELIVERY_STATUS.ACCEPTED]
    const isOwner = delivery.sender.equals(req.user.id)
    const isAdminLike = req.user.role === "admin" || req.user.role === "authority"

    if (!isOwner && !isAdminLike) {
      return next(createError(403, "Only delivery owner or admin can cancel this delivery"))
    }

    if (!ownerCancelAllowed.includes(delivery.status) && !isAdminLike) {
      return next(createError(400, "Delivery cannot be cancelled in the current status"))
    }

    if (isTerminalDeliveryStatus(delivery.status)) {
      return next(createError(400, "Terminal delivery records cannot be changed"))
    }

    await updateStatusWithGuard({
      delivery,
      nextStatus: DELIVERY_STATUS.CANCELLED_BY_USER,
    })

    if (delivery.assignedDriver) {
      await releaseAssignmentResources(delivery)
      delivery.assignedDriver = null
      delivery.trip = null
    }

    delivery.cancellation = {
      reason: req.body.reason || "Cancelled by user",
      cancelledBy: isAdminLike ? "admin" : "user",
    }

    await delivery.save()

    return sendSuccess(res, 200, "Delivery cancelled successfully", { delivery })
  } catch (error) {
    next(error)
  }
}

export const listDriverAvailableDeliveries = async (req, res, next) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id })
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const driverTrips = await Trip.find({
      driver: driver._id,
      status: { $in: ["planned", "active"] },
    }).select("_id")

    const driverTripIds = driverTrips.map((trip) => trip._id)

    const deliveries = await Delivery.find({
      status: DELIVERY_STATUS.PENDING,
      assignedDriver: null,
      rejectedBy: { $ne: driver._id },
      $or: [{ trip: null }, { trip: { $in: driverTripIds } }],
    })
      .sort({ createdAt: -1 })
      .limit(100)

    return sendSuccess(res, 200, "Available deliveries fetched successfully", { deliveries })
  } catch (error) {
    next(error)
  }
}

export const acceptDelivery = async (req, res, next) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id })
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    // Legacy records may have pending status / unverified driver flag even after user email verification.
    // For MVP flow we allow driver acceptance when user account is verified and there is no active assignment.
    const hasNoActiveRide = !driver.currentRide
    const isOperationalStatus = driver.status === "approved" || driver.status === "pending"
    const isVerifiedForOperations = driver.isVerified || req.user.isVerified === true

    if (!driver.isAvailable && hasNoActiveRide) {
      driver.isAvailable = true
      await driver.save()
    }

    if (!driver.isAvailable || !isOperationalStatus || !isVerifiedForOperations) {
      return next(createError(403, "Driver is not eligible to accept deliveries"))
    }

    const targetDelivery = await Delivery.findById(req.params.deliveryId)
    if (!targetDelivery) {
      return next(createError(404, "Delivery not found"))
    }

    if (targetDelivery.status !== DELIVERY_STATUS.PENDING || targetDelivery.assignedDriver) {
      return next(createError(409, "Delivery has already been claimed by another driver"))
    }

    if (targetDelivery.rejectedBy?.some((item) => item.equals(driver._id))) {
      return next(createError(400, "Delivery is no longer available for this driver"))
    }

    const requestedTripId = req.body.tripId || (targetDelivery.trip ? String(targetDelivery.trip) : null)

    if (targetDelivery.trip && req.body.tripId && String(targetDelivery.trip) !== String(req.body.tripId)) {
      return next(createError(400, "Delivery is already attached to a different trip"))
    }

    let trip = null
    if (requestedTripId) {
      trip = await Trip.findOneAndUpdate(
        {
          _id: requestedTripId,
          driver: driver._id,
          status: { $in: ["planned", "active"] },
          availableCapacity: { $gt: 0 },
        },
        { $inc: { availableCapacity: -1 } },
        { new: true },
      )

      if (!trip) {
        return next(createError(400, "Trip is not available or has no capacity"))
      }
    }

    const updatePayload = {
      assignedDriver: driver._id,
      status: DELIVERY_STATUS.ACCEPTED,
      "timeline.acceptedAt": new Date(),
    }

    if (requestedTripId) {
      updatePayload.trip = requestedTripId
    }

    const delivery = await Delivery.findOneAndUpdate(
      {
        _id: req.params.deliveryId,
        status: DELIVERY_STATUS.PENDING,
        assignedDriver: null,
        rejectedBy: { $ne: driver._id },
        ...(targetDelivery.trip ? { trip: targetDelivery.trip } : {}),
      },
      {
        $set: updatePayload,
      },
      {
        new: true,
      },
    )

    if (!delivery) {
      if (trip) {
        await Trip.findByIdAndUpdate(trip._id, { $inc: { availableCapacity: 1 } })
      }
      return next(createError(409, "Delivery has already been claimed by another driver"))
    }

    driver.isAvailable = false
    driver.currentRide = delivery._id
    await driver.save()

    await createNotification({
      recipient: delivery.sender,
      title: "Delivery accepted",
      message: "A driver accepted your delivery request",
      type: "delivery_accepted",
      reference: delivery._id,
      referenceModel: "Delivery",
      data: {
        deliveryId: delivery._id,
      },
    })

    return sendSuccess(res, 200, "Delivery accepted successfully", { delivery })
  } catch (error) {
    next(error)
  }
}

export const rejectDelivery = async (req, res, next) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id })
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const delivery = await Delivery.findOneAndUpdate(
      {
        _id: req.params.deliveryId,
        status: DELIVERY_STATUS.PENDING,
        assignedDriver: null,
      },
      {
        $addToSet: { rejectedBy: driver._id },
      },
      { new: true },
    )

    if (!delivery) {
      return next(createError(400, "Delivery is no longer available for rejection"))
    }

    return sendSuccess(res, 200, "Delivery rejected successfully", {
      delivery,
      reason: req.body.reason || null,
    })
  } catch (error) {
    next(error)
  }
}

export const getDriverActiveDelivery = async (req, res, next) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id })
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const delivery = await Delivery.findOne({
      assignedDriver: driver._id,
      status: { $in: activeDriverStatuses },
    })
      .populate("sender", "firstName lastName phone")
      .populate("trip")

    return sendSuccess(res, 200, "Active delivery fetched successfully", { delivery })
  } catch (error) {
    next(error)
  }
}

export const updateDriverLiveLocation = async (req, res, next) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id })
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const [lng, lat] = req.body.coordinates

    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      return next(createError(400, "Invalid coordinates"))
    }

    driver.currentLocation = {
      type: "Point",
      coordinates: req.body.coordinates,
    }

    await driver.save()

    return sendSuccess(res, 200, "Driver location updated successfully", {
      currentLocation: driver.currentLocation,
    })
  } catch (error) {
    next(error)
  }
}

export const markPickupCompleted = async (req, res, next) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id })
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const delivery = await Delivery.findById(req.params.deliveryId)
    if (!delivery) {
      return next(createError(404, "Delivery not found"))
    }

    if (!delivery.assignedDriver || !delivery.assignedDriver.equals(driver._id)) {
      return next(createError(403, "Only assigned driver can update this delivery"))
    }

    if ([DELIVERY_STATUS.PICKED_UP, DELIVERY_STATUS.IN_TRANSIT, DELIVERY_STATUS.ARRIVED_DROPOFF, DELIVERY_STATUS.DELIVERED].includes(delivery.status)) {
      return next(createError(409, "Pickup has already been completed for this delivery"))
    }

    if (![DELIVERY_STATUS.ACCEPTED, DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP].includes(delivery.status)) {
      return next(createError(400, `Pickup cannot be completed from status ${delivery.status}`))
    }

    // Single-action endpoint: pickup-completed moves delivery to PickedUp exactly once.
    if (delivery.status === DELIVERY_STATUS.ACCEPTED) {
      delivery.status = DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP
      if (!delivery.timeline) {
        delivery.timeline = {}
      }
      delivery.timeline.driverArrivedPickupAt = new Date()
    }

    await updateStatusWithGuard({
      delivery,
      nextStatus: DELIVERY_STATUS.PICKED_UP,
    })
    await delivery.save()

    return sendSuccess(res, 200, "Pickup status updated successfully", { delivery })
  } catch (error) {
    next(error)
  }
}

export const updateDeliveryProgress = async (req, res, next) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id })
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const delivery = await Delivery.findById(req.params.deliveryId)
    if (!delivery) {
      return next(createError(404, "Delivery not found"))
    }

    if (!delivery.assignedDriver || !delivery.assignedDriver.equals(driver._id)) {
      return next(createError(403, "Only assigned driver can update this delivery"))
    }

    const { status } = req.body
    if (!status) {
      return next(createError(400, "status is required"))
    }

    await updateStatusWithGuard({ delivery, nextStatus: status })

    if (status === DELIVERY_STATUS.FAILED_DELIVERY) {
      await releaseAssignmentResources(delivery)
    }

    await delivery.save()

    return sendSuccess(res, 200, "Delivery progress updated successfully", { delivery })
  } catch (error) {
    next(error)
  }
}

export const markDeliveryCompleted = async (req, res, next) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id })
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const delivery = await Delivery.findById(req.params.deliveryId)
    if (!delivery) {
      return next(createError(404, "Delivery not found"))
    }

    if (!delivery.assignedDriver || !delivery.assignedDriver.equals(driver._id)) {
      return next(createError(403, "Only assigned driver can complete this delivery"))
    }

    await updateStatusWithGuard({
      delivery,
      nextStatus: DELIVERY_STATUS.DELIVERED,
    })

    delivery.proofOfDelivery = {
      ...req.body.proofOfDelivery,
      confirmedAt: new Date(),
    }

    if (typeof req.body.finalPrice === "number") {
      delivery.pricing.finalPrice = req.body.finalPrice
    } else if (!delivery.pricing.finalPrice) {
      delivery.pricing.finalPrice = delivery.pricing.estimatedPrice
    }

    if (delivery.payment.status === "pending") {
      delivery.payment.status = delivery.payment.method === "cash" ? "cash_received" : "completed"
    }

    await delivery.save()

    driver.completedDeliveries += 1
    driver.balance += Number(delivery.pricing.finalPrice || 0) * 0.8
    driver.isAvailable = true
    driver.currentRide = null
    await driver.save()

    await createNotification({
      recipient: delivery.sender,
      title: "Delivery completed",
      message: "Your delivery has been marked as delivered",
      type: "delivery_completed",
      reference: delivery._id,
      referenceModel: "Delivery",
    })

    return sendSuccess(res, 200, "Delivery completed successfully", { delivery })
  } catch (error) {
    next(error)
  }
}

export const updatePaymentStatus = async (req, res, next) => {
  try {
    const delivery = await Delivery.findById(req.params.deliveryId)
    if (!delivery) {
      return next(createError(404, "Delivery not found"))
    }

    delivery.payment.status = req.body.status
    if (req.body.transactionId) {
      delivery.payment.transactionId = req.body.transactionId
    }

    if (req.body.status === "refunded") {
      if (!canTransitionDeliveryStatus(delivery.status, DELIVERY_STATUS.REFUNDED)) {
        return next(createError(400, "This delivery cannot be refunded in the current status"))
      }
      await updateStatusWithGuard({ delivery, nextStatus: DELIVERY_STATUS.REFUNDED })
    }

    await delivery.save()

    return sendSuccess(res, 200, "Payment status updated successfully", { delivery })
  } catch (error) {
    next(error)
  }
}
