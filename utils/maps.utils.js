import { getRouteDirections, getRouteDistance } from "./maps-routing.utils.js"
import {
  geocodeAddress as geocodeAddressByProvider,
  reverseGeocode as reverseGeocodeByProvider,
} from "./maps-geocode.utils.js"

const formatDistanceText = (distanceMeters) => `${(distanceMeters / 1000).toFixed(1)} km`
const formatDurationText = (durationSeconds) => `${Math.ceil(durationSeconds / 60)} mins`

export const getDistance = async (origin, destination) => {
  const { distanceMeters, durationSeconds } = await getRouteDistance(origin, destination)

  return {
    distance: distanceMeters,
    distanceText: formatDistanceText(distanceMeters),
    duration: durationSeconds,
    durationText: formatDurationText(durationSeconds),
    durationInTraffic: durationSeconds,
    durationInTrafficText: formatDurationText(durationSeconds),
  }
}

export const getDirections = async (origin, destination, waypoints = []) => {
  const route = await getRouteDirections(origin, destination, waypoints)

  return {
    distance: route.distanceMeters,
    distanceText: formatDistanceText(route.distanceMeters),
    duration: route.durationSeconds,
    durationText: formatDurationText(route.durationSeconds),
    durationInTraffic: route.durationSeconds,
    durationInTrafficText: formatDurationText(route.durationSeconds),
    polyline: route.polyline,
    geometry: route.geometry,
    routes: route.routes,
    legs: route.legs,
    steps: route.steps,
    bounds: null,
    copyrights: "OpenStreetMap contributors",
    warnings: route.warnings,
  }
}

export const geocodeAddress = async (address) => {
  const result = await geocodeAddressByProvider(address)

  return {
    coordinates: [result.lng, result.lat],
    formattedAddress: result.displayName,
    placeId: null,
    types: [],
    addressComponents: [],
    bounds: null,
    locationType: null,
  }
}

export const reverseGeocode = async (coordinates) => {
  const [lng, lat] = coordinates
  const result = await reverseGeocodeByProvider(lat, lng)

  return [
    {
      formattedAddress: result.displayName,
      placeId: null,
      types: [],
      addressComponents: [],
    },
  ]
}










