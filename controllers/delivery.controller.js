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

const cancellationStatuses = new Set([
  DELIVERY_STATUS.CANCELLED_BY_USER,
  DELIVERY_STATUS.CANCELLED_BY_DRIVER,
])

const terminalStatusesRequiringDriverReset = new Set([
  DELIVERY_STATUS.DELIVERED,
  DELIVERY_STATUS.FAILED_DELIVERY,
  DELIVERY_STATUS.CANCELLED_BY_USER,
  DELIVERY_STATUS.CANCELLED_BY_DRIVER,
])

const toLatLng = (coordinates) => ({
  lng: Number(coordinates?.[0]),
  lat: Number(coordinates?.[1]),
})

const withSession = (options = {}, session = null) => {
  if (!session) {
    return options
  }

  return {
    ...options,
    session,
  }
}

const attachSession = (query, session = null) => {
  if (session) {
    query.session(session)
  }

  return query
}

const saveWithSession = async (document, session = null) => {
  if (session) {
    return document.save({ session })
  }

  return document.save()
}

const logDeliveryEvent = (event, payload = {}) => {
  console.info(
    JSON.stringify({
      scope: "delivery",
      event,
      at: new Date().toISOString(),
      ...payload,
    }),
  )
}

const stripInternalDeliveryState = (delivery) => {
  if (delivery && typeof delivery === "object") {
    delivery.capacityReserved = undefined
  }

  return delivery
}

const runAtomic = async (work) => {
  const session = await Delivery.startSession()

  try {
    let result
    await session.withTransaction(async () => {
      result = await work(session)
    })
    return result
  } catch (error) {
    const message = String(error?.message || "")
    const transactionUnsupported =
      message.includes("Transaction numbers are only allowed on a replica set member or mongos") ||
      message.toLowerCase().includes("transaction is not supported")

    if (transactionUnsupported) {
      return work(null)
    }

    throw error
  } finally {
    await session.endSession()
  }
}

const findDriverByUserId = async (userId, session = null) => {
  return attachSession(Driver.findOne({ user: userId }), session)
}

const findDeliveryById = async (deliveryId, session = null) => {
  return attachSession(Delivery.findById(deliveryId), session)
}

const findDeliveryByIdForMutation = async (deliveryId, session = null) => {
  return attachSession(Delivery.findById(deliveryId).select("+capacityReserved"), session)
}

const restoreTripCapacitySafely = async (tripId, session = null) => {
  if (!tripId) {
    return
  }

  await Trip.findByIdAndUpdate(
    tripId,
    [
      {
        $set: {
          availableCapacity: {
            $max: [
              0,
              {
                $min: [
                  "$maxDeliveries",
                  {
                    $add: ["$availableCapacity", 1],
                  },
                ],
              },
            ],
          },
        },
      },
    ],
    withSession({}, session),
  )
}

const enforceTerminalDriverInvariantForDelivery = async (delivery, session = null) => {
  if (!terminalStatusesRequiringDriverReset.has(delivery.status)) {
    return
  }

  if (delivery.assignedDriver) {
    const driver = await attachSession(Driver.findById(delivery.assignedDriver), session)
    if (driver) {
      driver.currentRide = null
      driver.isAvailable = true
      await saveWithSession(driver, session)
    }
    return
  }

  await Driver.findOneAndUpdate(
    { currentRide: delivery._id },
    {
      $set: {
        currentRide: null,
        isAvailable: true,
      },
    },
    withSession({}, session),
  )
}

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

const releaseAssignmentResources = async (
  delivery,
  { session = null, restoreTripCapacity = true } = {},
) => {
  if (delivery.assignedDriver) {
    const driver = await attachSession(
      Driver.findById(delivery.assignedDriver),
      session,
    )

    if (driver) {
      driver.currentRide = null
      driver.isAvailable = true
      await saveWithSession(driver, session)
    }
  }

  if (restoreTripCapacity && delivery.trip && delivery.capacityReserved === true) {
    await restoreTripCapacitySafely(delivery.trip, session)
    delivery.capacityReserved = false

    if (!session) {
      await Delivery.findByIdAndUpdate(delivery._id, {
        $set: {
          capacityReserved: false,
        },
      })
    }
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
    const delivery = await runAtomic(async (session) => {
      const targetDelivery = await findDeliveryByIdForMutation(req.params.deliveryId, session)
      if (!targetDelivery) {
        throw createError(404, "Delivery not found")
      }

      const ownerCancelAllowed = [
        DELIVERY_STATUS.DRAFT,
        DELIVERY_STATUS.PENDING,
        DELIVERY_STATUS.ACCEPTED,
      ]
      const isOwner = targetDelivery.sender.equals(req.user.id)
      const isAdminLike = req.user.role === "admin" || req.user.role === "authority"

      let isAssignedDriver = false
      if (req.user.role === "driver") {
        const actingDriver = await findDriverByUserId(req.user.id, session)
        if (!actingDriver) {
          throw createError(404, "Driver profile not found")
        }

        isAssignedDriver =
          !!targetDelivery.assignedDriver &&
          targetDelivery.assignedDriver.equals(actingDriver._id)
      }

      if (!isOwner && !isAssignedDriver && !isAdminLike) {
        throw createError(
          403,
          "Only delivery owner, assigned driver or admin can cancel this delivery",
        )
      }

      if (cancellationStatuses.has(targetDelivery.status)) {
        await enforceTerminalDriverInvariantForDelivery(targetDelivery, session)
        logDeliveryEvent("cancel_idempotent", {
          deliveryId: String(targetDelivery._id),
          actorUserId: String(req.user.id),
          status: targetDelivery.status,
        })
        return targetDelivery
      }

      if (isOwner && !ownerCancelAllowed.includes(targetDelivery.status)) {
        throw createError(400, "Delivery cannot be cancelled in the current status")
      }

      if (isTerminalDeliveryStatus(targetDelivery.status)) {
        throw createError(400, "Terminal delivery records cannot be changed")
      }

      const nextStatus = isAssignedDriver
        ? DELIVERY_STATUS.CANCELLED_BY_DRIVER
        : DELIVERY_STATUS.CANCELLED_BY_USER

      await updateStatusWithGuard({
        delivery: targetDelivery,
        nextStatus,
      })

      if (targetDelivery.assignedDriver) {
        await releaseAssignmentResources(targetDelivery, {
          session,
          restoreTripCapacity: true,
        })
        targetDelivery.assignedDriver = null
        targetDelivery.trip = null
      }

      const cancelledBy = isAdminLike ? "admin" : isAssignedDriver ? "driver" : "user"
      const defaultReason =
        cancelledBy === "driver"
          ? "Cancelled by driver"
          : cancelledBy === "admin"
          ? "Cancelled by admin"
          : "Cancelled by user"

      targetDelivery.cancellation = {
        reason: req.body.reason || defaultReason,
        cancelledBy,
      }

      await enforceTerminalDriverInvariantForDelivery(targetDelivery, session)

      await saveWithSession(targetDelivery, session)

      logDeliveryEvent("cancel_success", {
        deliveryId: String(targetDelivery._id),
        actorUserId: String(req.user.id),
        actorRole: req.user.role,
        status: targetDelivery.status,
        cancelledBy,
      })

      return targetDelivery
    })

    return sendSuccess(res, 200, "Delivery cancelled successfully", {
      delivery: stripInternalDeliveryState(delivery),
    })
  } catch (error) {
    logDeliveryEvent("cancel_failure", {
      deliveryId: req.params.deliveryId,
      actorUserId: req.user?.id ? String(req.user.id) : null,
      actorRole: req.user?.role || null,
      error: error?.message || "unknown_error",
    })
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
    const delivery = await runAtomic(async (session) => {
      const driver = await findDriverByUserId(req.user.id, session)
      if (!driver) {
        throw createError(404, "Driver profile not found")
      }

      if (driver.status !== "approved") {
        throw createError(403, "Driver is not eligible to accept deliveries")
      }

      if (driver.currentRide !== null || driver.isAvailable !== true) {
        throw createError(403, "Driver is not eligible to accept deliveries")
      }

      const targetDelivery = await findDeliveryByIdForMutation(req.params.deliveryId, session)
      if (!targetDelivery) {
        throw createError(404, "Delivery not found")
      }

      if (targetDelivery.assignedDriver && targetDelivery.assignedDriver.equals(driver._id)) {
        logDeliveryEvent("accept_idempotent", {
          deliveryId: String(targetDelivery._id),
          driverId: String(driver._id),
          status: targetDelivery.status,
        })
        return targetDelivery
      }

      if (targetDelivery.status !== DELIVERY_STATUS.PENDING || targetDelivery.assignedDriver) {
        throw createError(409, "Delivery has already been claimed by another driver")
      }

      if (targetDelivery.rejectedBy?.some((item) => item.equals(driver._id))) {
        throw createError(400, "Delivery is no longer available for this driver")
      }

      const requestedTripId = req.body.tripId || (targetDelivery.trip ? String(targetDelivery.trip) : null)

      if (targetDelivery.trip && req.body.tripId && String(targetDelivery.trip) !== String(req.body.tripId)) {
        throw createError(400, "Delivery is already attached to a different trip")
      }

      let capacityDecremented = false
      if (requestedTripId) {
        const hasExistingReservationForSameTrip =
          targetDelivery.capacityReserved === true &&
          targetDelivery.trip &&
          String(targetDelivery.trip) === String(requestedTripId)

        if (targetDelivery.capacityReserved === true && !hasExistingReservationForSameTrip) {
          throw createError(409, "Delivery capacity reservation is inconsistent")
        }

        if (!hasExistingReservationForSameTrip) {
          const trip = await Trip.findOneAndUpdate(
            {
              _id: requestedTripId,
              driver: driver._id,
              status: { $in: ["planned", "active"] },
              availableCapacity: { $gt: 0 },
            },
            { $inc: { availableCapacity: -1 } },
            withSession({ new: true }, session),
          )

          if (!trip) {
            throw createError(400, "Trip is not available or has no capacity")
          }

          capacityDecremented = true
        }
      } else if (targetDelivery.capacityReserved === true) {
        throw createError(409, "Delivery capacity reservation is inconsistent")
      }

      await updateStatusWithGuard({
        delivery: targetDelivery,
        nextStatus: DELIVERY_STATUS.ACCEPTED,
      })

      const updatePayload = {
        assignedDriver: driver._id,
        status: targetDelivery.status,
        "timeline.acceptedAt": targetDelivery.timeline?.acceptedAt || new Date(),
        capacityReserved: !!requestedTripId,
      }

      if (requestedTripId) {
        updatePayload.trip = requestedTripId
      }

      const claimedDelivery = await Delivery.findOneAndUpdate(
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
        withSession({ new: true }, session),
      )

      if (!claimedDelivery) {
        if (!session && requestedTripId && capacityDecremented) {
          await restoreTripCapacitySafely(requestedTripId)
        }
        throw createError(409, "Delivery has already been claimed by another driver")
      }

      driver.isAvailable = false
      driver.currentRide = claimedDelivery._id

      try {
        await saveWithSession(driver, session)
      } catch (error) {
        if (!session) {
          await Delivery.findByIdAndUpdate(
            claimedDelivery._id,
            {
              $set: {
                status: DELIVERY_STATUS.PENDING,
                assignedDriver: null,
                capacityReserved: false,
              },
              $unset: {
                "timeline.acceptedAt": 1,
              },
            },
          )

          if (requestedTripId && capacityDecremented) {
            await restoreTripCapacitySafely(requestedTripId)
          }
        }

        throw error
      }

      logDeliveryEvent("accept_success", {
        deliveryId: String(claimedDelivery._id),
        driverId: String(driver._id),
        tripId: requestedTripId || null,
        capacityDecremented,
        sessionEnabled: !!session,
      })

      return claimedDelivery
    })

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

    return sendSuccess(res, 200, "Delivery accepted successfully", {
      delivery: stripInternalDeliveryState(delivery),
    })
  } catch (error) {
    logDeliveryEvent("accept_failure", {
      deliveryId: req.params.deliveryId,
      actorUserId: req.user?.id ? String(req.user.id) : null,
      error: error?.message || "unknown_error",
    })
    next(error)
  }
}

export const rejectDelivery = async (req, res, next) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id })
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    // Per-driver rejection: keep delivery globally Pending and only track this driver in rejectedBy.
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

    if (delivery.status === DELIVERY_STATUS.ACCEPTED) {
      await updateStatusWithGuard({
        delivery,
        nextStatus: DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP,
      })
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
    const delivery = await runAtomic(async (session) => {
      const driver = await findDriverByUserId(req.user.id, session)
      if (!driver) {
        throw createError(404, "Driver profile not found")
      }

      const targetDelivery = await findDeliveryByIdForMutation(req.params.deliveryId, session)
      if (!targetDelivery) {
        throw createError(404, "Delivery not found")
      }

      if (!targetDelivery.assignedDriver || !targetDelivery.assignedDriver.equals(driver._id)) {
        throw createError(403, "Only assigned driver can update this delivery")
      }

      const { status } = req.body
      if (!status) {
        throw createError(400, "status is required")
      }

      if (targetDelivery.status === status) {
        await enforceTerminalDriverInvariantForDelivery(targetDelivery, session)
        logDeliveryEvent("progress_idempotent", {
          deliveryId: String(targetDelivery._id),
          driverId: String(driver._id),
          status,
        })
        return targetDelivery
      }

      await updateStatusWithGuard({ delivery: targetDelivery, nextStatus: status })

      if (status === DELIVERY_STATUS.FAILED_DELIVERY) {
        await releaseAssignmentResources(targetDelivery, {
          session,
          restoreTripCapacity: true,
        })
        await enforceTerminalDriverInvariantForDelivery(targetDelivery, session)
        logDeliveryEvent("delivery_failed", {
          deliveryId: String(targetDelivery._id),
          driverId: String(driver._id),
          status,
        })
      }

      await saveWithSession(targetDelivery, session)
      logDeliveryEvent("progress_success", {
        deliveryId: String(targetDelivery._id),
        driverId: String(driver._id),
        status,
      })
      return targetDelivery
    })

    return sendSuccess(res, 200, "Delivery progress updated successfully", {
      delivery: stripInternalDeliveryState(delivery),
    })
  } catch (error) {
    logDeliveryEvent("progress_failure", {
      deliveryId: req.params.deliveryId,
      actorUserId: req.user?.id ? String(req.user.id) : null,
      requestedStatus: req.body?.status || null,
      error: error?.message || "unknown_error",
    })
    next(error)
  }
}

export const markDeliveryCompleted = async (req, res, next) => {
  try {
    const delivery = await runAtomic(async (session) => {
      const driver = await findDriverByUserId(req.user.id, session)
      if (!driver) {
        throw createError(404, "Driver profile not found")
      }

      const targetDelivery = await findDeliveryByIdForMutation(req.params.deliveryId, session)
      if (!targetDelivery) {
        throw createError(404, "Delivery not found")
      }

      if (
        targetDelivery.status === DELIVERY_STATUS.DELIVERED &&
        targetDelivery.assignedDriver &&
        targetDelivery.assignedDriver.equals(driver._id)
      ) {
        await enforceTerminalDriverInvariantForDelivery(targetDelivery, session)
        logDeliveryEvent("complete_idempotent", {
          deliveryId: String(targetDelivery._id),
          driverId: String(driver._id),
        })
        return targetDelivery
      }

      if (!targetDelivery.assignedDriver || !targetDelivery.assignedDriver.equals(driver._id)) {
        throw createError(403, "Only assigned driver can complete this delivery")
      }

      const rollbackSnapshot = !session
        ? {
            status: targetDelivery.status,
            deliveredAt: targetDelivery.timeline?.deliveredAt || null,
            paymentStatus: targetDelivery.payment?.status || "pending",
            finalPrice: targetDelivery.pricing?.finalPrice ?? null,
            proofOfDelivery: targetDelivery.proofOfDelivery || {},
          }
        : null

      await updateStatusWithGuard({
        delivery: targetDelivery,
        nextStatus: DELIVERY_STATUS.DELIVERED,
      })

      targetDelivery.proofOfDelivery = {
        ...req.body.proofOfDelivery,
        confirmedAt: new Date(),
      }

      if (typeof req.body.finalPrice === "number") {
        targetDelivery.pricing.finalPrice = req.body.finalPrice
      } else if (!targetDelivery.pricing.finalPrice) {
        targetDelivery.pricing.finalPrice = targetDelivery.pricing.estimatedPrice
      }

      targetDelivery.payment.status =
        targetDelivery.payment.method === "cash" ? "cash_received" : "completed"

      await saveWithSession(targetDelivery, session)

      driver.completedDeliveries += 1
      driver.balance += Number(targetDelivery.pricing.finalPrice || 0) * 0.8
      driver.isAvailable = true
      driver.currentRide = null

      try {
        await saveWithSession(driver, session)
      } catch (error) {
        if (!session && rollbackSnapshot) {
          const rollbackUpdate = {
            $set: {
              status: rollbackSnapshot.status,
              proofOfDelivery: rollbackSnapshot.proofOfDelivery,
              "payment.status": rollbackSnapshot.paymentStatus,
              "pricing.finalPrice": rollbackSnapshot.finalPrice,
            },
          }

          if (rollbackSnapshot.deliveredAt) {
            rollbackUpdate.$set["timeline.deliveredAt"] = rollbackSnapshot.deliveredAt
          } else {
            rollbackUpdate.$unset = { "timeline.deliveredAt": 1 }
          }

          await Delivery.findByIdAndUpdate(targetDelivery._id, rollbackUpdate)
        }

        throw error
      }

      await enforceTerminalDriverInvariantForDelivery(targetDelivery, session)
      logDeliveryEvent("complete_success", {
        deliveryId: String(targetDelivery._id),
        driverId: String(driver._id),
      })

      return targetDelivery
    })

    await createNotification({
      recipient: delivery.sender,
      title: "Delivery completed",
      message: "Your delivery has been marked as delivered",
      type: "delivery_completed",
      reference: delivery._id,
      referenceModel: "Delivery",
    })

    return sendSuccess(res, 200, "Delivery completed successfully", {
      delivery: stripInternalDeliveryState(delivery),
    })
  } catch (error) {
    logDeliveryEvent("complete_failure", {
      deliveryId: req.params.deliveryId,
      actorUserId: req.user?.id ? String(req.user.id) : null,
      error: error?.message || "unknown_error",
    })
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
      delivery.payment.status = "refunded"
    }

    await delivery.save()

    return sendSuccess(res, 200, "Payment status updated successfully", { delivery })
  } catch (error) {
    next(error)
  }
}
