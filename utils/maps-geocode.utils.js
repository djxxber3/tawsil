import axios from "axios"
import { createError } from "./error.utils.js"
import {
  NOMINATIM_BASE_URL,
  NOMINATIM_USER_AGENT,
} from "../config/maps.config.js"

const requestHeaders = {
  "User-Agent": NOMINATIM_USER_AGENT,
}

const toNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const geocodeAddress = async (query) => {
  if (!query || !String(query).trim()) {
    throw createError(400, "Address query is required", {
      code: "INVALID_GEOCODE_QUERY",
    })
  }

  try {
    const response = await axios.get(`${NOMINATIM_BASE_URL}/search`, {
      params: {
        q: query,
        format: "jsonv2",
        limit: 1,
      },
      headers: requestHeaders,
    })

    const result = Array.isArray(response?.data) ? response.data[0] : null

    if (!result) {
      throw createError(404, "Address not found", {
        code: "GEOCODE_NOT_FOUND",
      })
    }

    const lat = toNumber(result.lat)
    const lng = toNumber(result.lon)

    if (lat === null || lng === null) {
      throw createError(503, "Geocoding service returned invalid coordinates", {
        code: "GEOCODING_SERVICE_UNAVAILABLE",
      })
    }

    return {
      lat,
      lng,
      displayName: result.display_name || String(query),
    }
  } catch (error) {
    if (error?.statusCode) {
      throw error
    }

    throw createError(503, "Geocoding service is temporarily unavailable", {
      code: "GEOCODING_SERVICE_UNAVAILABLE",
      providerMessage: error?.message || "Unknown geocoding provider error",
    })
  }
}

export const reverseGeocode = async (lat, lng) => {
  const safeLat = toNumber(lat)
  const safeLng = toNumber(lng)

  if (safeLat === null || safeLng === null) {
    throw createError(400, "Valid latitude and longitude are required", {
      code: "INVALID_COORDINATES",
    })
  }

  try {
    const response = await axios.get(`${NOMINATIM_BASE_URL}/reverse`, {
      params: {
        lat: safeLat,
        lon: safeLng,
        format: "jsonv2",
      },
      headers: requestHeaders,
    })

    const data = response?.data

    if (!data || (!data.display_name && !data.address)) {
      throw createError(404, "Address not found", {
        code: "REVERSE_GEOCODE_NOT_FOUND",
      })
    }

    return {
      lat: toNumber(data.lat) ?? safeLat,
      lng: toNumber(data.lon) ?? safeLng,
      displayName: data.display_name || "",
      address: {
        road: data.address?.road || null,
        city: data.address?.city || data.address?.town || data.address?.village || null,
        state: data.address?.state || null,
        postcode: data.address?.postcode || null,
        country: data.address?.country || null,
        countryCode: data.address?.country_code || null,
      },
    }
  } catch (error) {
    if (error?.statusCode) {
      throw error
    }

    throw createError(503, "Geocoding service is temporarily unavailable", {
      code: "GEOCODING_SERVICE_UNAVAILABLE",
      providerMessage: error?.message || "Unknown geocoding provider error",
    })
  }
}
