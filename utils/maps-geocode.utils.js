import axios from "axios"
import { createError } from "./error.utils.js"
import {
  LOCATIONIQ_API_KEY,
  LOCATIONIQ_BASE_URL,
} from "../config/maps.config.js"

const ensureLocationIqKey = () => {
  if (!LOCATIONIQ_API_KEY) {
    throw createError(500, "Geocoding service is not configured", {
      code: "GEOCODING_PROVIDER_NOT_CONFIGURED",
    })
  }
}

const toNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const isAlgeriaAddress = (address) => String(address?.country_code || "").toLowerCase() === "dz"

export const geocodeAddress = async (query) => {
  if (!query || !String(query).trim()) {
    throw createError(400, "Address query is required", {
      code: "INVALID_GEOCODE_QUERY",
    })
  }

  ensureLocationIqKey()

  try {
    const response = await axios.get(`${LOCATIONIQ_BASE_URL}/search.php`, {
      params: {
        key: LOCATIONIQ_API_KEY,
        q: query,
        format: "json",
        addressdetails: 1,
        limit: 1,
        countrycodes: "dz",
      },
    })

    const result = Array.isArray(response?.data) ? response.data[0] : null

    if (!result) {
      throw createError(404, "Address not found", {
        code: "GEOCODE_NOT_FOUND",
      })
    }

    if (!isAlgeriaAddress(result.address)) {
      throw createError(400, "Only Algerian addresses are supported", {
        code: "ADDRESS_OUTSIDE_ALGERIA",
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

  ensureLocationIqKey()

  try {
    const response = await axios.get(`${LOCATIONIQ_BASE_URL}/reverse.php`, {
      params: {
        key: LOCATIONIQ_API_KEY,
        lat: safeLat,
        lon: safeLng,
        format: "json",
        addressdetails: 1,
      },
    })

    const data = response?.data

    if (!data || (!data.display_name && !data.address)) {
      throw createError(404, "Address not found", {
        code: "REVERSE_GEOCODE_NOT_FOUND",
      })
    }

    if (!isAlgeriaAddress(data.address)) {
      throw createError(400, "Only Algerian addresses are supported", {
        code: "ADDRESS_OUTSIDE_ALGERIA",
      })
    }

    return {
      lat: toNumber(data.lat) ?? safeLat,
      lng: toNumber(data.lon) ?? safeLng,
      displayName: data.display_name || "",
      address: {
        road: data.address?.road || null,
        city: data.address?.city || data.address?.town || data.address?.village || data.address?.county || null,
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
