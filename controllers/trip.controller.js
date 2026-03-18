import Driver from "../models/driver.model.js"
import Trip from "../models/trip.model.js"
import { createError } from "../utils/error.utils.js"
import { sendSuccess } from "../utils/api-response.utils.js"

export const createTrip = async (req, res, next) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id })
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    if (!driver.isVerified || driver.status !== "approved") {
      return next(createError(403, "Driver account is not verified for trips"))
    }

    const trip = await Trip.create({
      driver: driver._id,
      title: req.body.title,
      origin: {
        address: req.body.origin.address,
        location: {
          type: "Point",
          coordinates: req.body.origin.location.coordinates,
        },
      },
      destination: {
        address: req.body.destination.address,
        location: {
          type: "Point",
          coordinates: req.body.destination.location.coordinates,
        },
      },
      departureTime: req.body.departureTime,
      expectedArrivalTime: req.body.expectedArrivalTime,
      maxDeliveries: req.body.maxDeliveries || 3,
      availableCapacity: req.body.maxDeliveries || 3,
      notes: req.body.notes,
    })

    return sendSuccess(res, 201, "Trip created successfully", { trip })
  } catch (error) {
    next(error)
  }
}

export const listDriverTrips = async (req, res, next) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id })
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const { status } = req.query
    const query = { driver: driver._id }

    if (status) {
      query.status = status
    }

    const trips = await Trip.find(query).sort({ createdAt: -1 })

    return sendSuccess(res, 200, "Trips fetched successfully", { trips })
  } catch (error) {
    next(error)
  }
}

export const listAvailableTrips = async (req, res, next) => {
  try {
    const trips = await Trip.find({
      status: { $in: ["planned", "active"] },
      availableCapacity: { $gt: 0 },
    })
      .populate({
        path: "driver",
        populate: {
          path: "user",
          select: "firstName lastName phone rating",
        },
      })
      .sort({ departureTime: 1 })

    return sendSuccess(res, 200, "Available trips fetched successfully", { trips })
  } catch (error) {
    next(error)
  }
}

export const getTripById = async (req, res, next) => {
  try {
    const { tripId } = req.params
    const trip = await Trip.findById(tripId).populate({
      path: "driver",
      populate: {
        path: "user",
        select: "firstName lastName phone rating",
      },
    })

    if (!trip) {
      return next(createError(404, "Trip not found"))
    }

    return sendSuccess(res, 200, "Trip fetched successfully", { trip })
  } catch (error) {
    next(error)
  }
}

export const updateTripStatus = async (req, res, next) => {
  try {
    const { tripId } = req.params
    const { status } = req.body

    const isAdminLike = req.user.role === "admin" || req.user.role === "authority"
    let driver = null
    if (!isAdminLike) {
      driver = await Driver.findOne({ user: req.user.id })
      if (!driver) {
        return next(createError(404, "Driver profile not found"))
      }
    }

    const trip = await Trip.findById(tripId)
    if (!trip) {
      return next(createError(404, "Trip not found"))
    }

    if (!isAdminLike && !trip.driver.equals(driver._id)) {
      return next(createError(403, "You are not authorized to update this trip"))
    }

    trip.status = status
    await trip.save()

    return sendSuccess(res, 200, "Trip status updated successfully", { trip })
  } catch (error) {
    next(error)
  }
}
