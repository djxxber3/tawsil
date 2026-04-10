import axios from "axios"
import { createError } from "./error.utils.js"
import { OSRM_BASE_URL } from "../config/maps.config.js"

const toNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const parseLatLngString = (value) => {
  const [latPart, lngPart] = String(value)
    .split(",")
    .map((part) => part.trim())

  const lat = toNumber(latPart)
  const lng = toNumber(lngPart)

  if (lat === null || lng === null) {
    return null
  }

  return { lat, lng }
}

const normalizePoint = (point) => {
  if (Array.isArray(point) && point.length === 2) {
    const lng = toNumber(point[0])
    const lat = toNumber(point[1])
    if (lat === null || lng === null) {
      return null
    }
    return { lat, lng }
  }

  if (typeof point === "string") {
    return parseLatLngString(point)
  }

  if (point && typeof point === "object") {
    const lat = toNumber(point.lat)
    const lng = toNumber(point.lng)

    if (lat === null || lng === null) {
      return null
    }

    return { lat, lng }
  }

  return null
}

const normalizeWaypoints = (waypoints) => {
  if (!Array.isArray(waypoints)) {
    return []
  }

  return waypoints
    .map((point) => normalizePoint(point))
    .filter((point) => point !== null)
}

const buildRoutePath = (points) => points.map((point) => `${point.lng},${point.lat}`).join(";")

const requestRoute = async ({ originPoint, destinationPoint, waypointPoints = [] }) => {
  const routePath = buildRoutePath([originPoint, ...waypointPoints, destinationPoint])

  try {
    const response = await axios.get(`${OSRM_BASE_URL}/route/v1/driving/${routePath}`, {
      params: {
        alternatives: false,
        overview: "full",
        geometries: "polyline",
        steps: true,
      },
    })

    const routes = response?.data?.routes || []
    const route = routes[0]

    if (!route || typeof route.distance !== "number" || typeof route.duration !== "number") {
      throw createError(404, "Route not found", {
        code: "ROUTE_NOT_FOUND",
      })
    }

    return {
      route,
      routes,
    }
  } catch (error) {
    if (error?.details?.code === "ROUTE_NOT_FOUND") {
      throw error
    }

    if (error?.statusCode) {
      throw error
    }

    throw createError(503, "Routing service is temporarily unavailable", {
      code: "ROUTING_SERVICE_UNAVAILABLE",
      providerMessage: error?.message || "Unknown routing provider error",
    })
  }
}

export const getRouteDistance = async (origin, destination) => {
  const originPoint = normalizePoint(origin)
  const destinationPoint = normalizePoint(destination)

  if (!originPoint || !destinationPoint) {
    throw createError(400, "Invalid origin or destination coordinates", {
      code: "INVALID_COORDINATES",
    })
  }

  const { route } = await requestRoute({
    originPoint,
    destinationPoint,
  })

  return {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
  }
}

export const getRouteDirections = async (origin, destination, waypoints = []) => {
  const originPoint = normalizePoint(origin)
  const destinationPoint = normalizePoint(destination)

  if (!originPoint || !destinationPoint) {
    throw createError(400, "Invalid origin or destination coordinates", {
      code: "INVALID_COORDINATES",
    })
  }

  const waypointPoints = normalizeWaypoints(waypoints)

  const { route, routes } = await requestRoute({
    originPoint,
    destinationPoint,
    waypointPoints,
  })

  const legs = Array.isArray(route.legs) ? route.legs : []
  const steps = legs.flatMap((leg) => (Array.isArray(leg?.steps) ? leg.steps : []))

  return {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    polyline: typeof route.geometry === "string" ? route.geometry : null,
    geometry: route.geometry || null,
    routes,
    legs,
    steps,
    warnings: waypointPoints.length !== waypoints.length ? ["Some waypoints were ignored due to invalid coordinates"] : [],
  }
}
