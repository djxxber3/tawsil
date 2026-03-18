
export const calculateRidePrice = (distance, duration, vehicleType) => {
    
    const basePrices = {
      standard: 180,
      comfort: 250,
      premium: 380,
      van: 320,
    }
  
    
    const pricePerKm = {
      standard: 42,
      comfort: 55,
      premium: 75,
      van: 68,
    }
  
    const pricePerMinute = {
      standard: 4,
      comfort: 5,
      premium: 7,
      van: 6,
    }
  
    const base = basePrices[vehicleType] || basePrices.standard
    const distancePrice = (pricePerKm[vehicleType] || pricePerKm.standard) * distance
    const timePrice = (pricePerMinute[vehicleType] || pricePerMinute.standard) * duration
  
    const total = base + distancePrice + timePrice
  
  
    const roundedTotal = Math.round(total * 100) / 100
  
    return {
      base,
      distance: distancePrice,
      time: timePrice,
      total: roundedTotal,
    }
  }
  
 
  export const calculateDeliveryPrice = (distance, packageSize, packageWeight) => {
    
    const basePrices = {
      small: 220,
      medium: 320,
      large: 460,
    }
  
    
    const pricePerKm = 35
  
    const weightPrices = {
      "0-1": 0,
      "1-5": 90,
      "5-10": 170,
      "10-20": 290,
      "20+": 450,
    }
  
    const base = basePrices[packageSize] || basePrices.medium
    const distancePrice = pricePerKm * distance
    const weightPrice = weightPrices[packageWeight] || weightPrices["1-5"]
  
   
    const total = base + distancePrice + weightPrice

    const roundedTotal = Math.round(total * 100) / 100
  
    return {
      base,
      distance: distancePrice,
      weight: weightPrice,
      total: roundedTotal,
    }
  }

export const DEFAULT_DELIVERY_PRICING_CONFIG = {
  baseFee: 220,
  perKmFee: 35,
  sizeSurcharge: {
    small: 0,
    medium: 90,
    large: 170,
    xlarge: 260,
  },
  urgentSurcharge: 180,
  weightFeePerKg: 45,
  maxWeightFee: 500,
}

export const calculateDeliveryMvpPrice = ({
  distanceKm,
  sizeCategory,
  weightKg = 0,
  isUrgent = false,
  config = DEFAULT_DELIVERY_PRICING_CONFIG,
}) => {
  const safeDistance = Math.max(0, Number(distanceKm) || 0)
  const safeWeight = Math.max(0, Number(weightKg) || 0)

  const baseFee = config.baseFee
  const distanceFee = safeDistance * config.perKmFee
  const sizeSurcharge = config.sizeSurcharge[sizeCategory] || 0
  const weightSurcharge = Math.min(safeWeight * config.weightFeePerKg, config.maxWeightFee)
  const urgentSurcharge = isUrgent ? config.urgentSurcharge : 0

  const estimatedPrice = Math.round((baseFee + distanceFee + sizeSurcharge + weightSurcharge + urgentSurcharge) * 100) / 100

  return {
    baseFee,
    distanceFee: Math.round(distanceFee * 100) / 100,
    sizeSurcharge,
    weightSurcharge: Math.round(weightSurcharge * 100) / 100,
    urgentSurcharge,
    estimatedPrice,
  }
}
  