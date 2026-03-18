import mongoose from "mongoose"

const deliverySchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignedDriver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      default: null,
    },
    trip: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      default: null,
    },
    pickup: {
      address: {
        type: String,
        required: [true, "Pickup address is required"],
      },
      location: {
        type: {
          type: String,
          enum: ["Point"],
          default: "Point",
        },
        coordinates: {
          type: [Number],
          required: [true, "Pickup coordinates are required"],
        },
      },
    },
    dropoff: {
      address: {
        type: String,
        required: [true, "Dropoff address is required"],
      },
      location: {
        type: {
          type: String,
          enum: ["Point"],
          default: "Point",
        },
        coordinates: {
          type: [Number],
          required: [true, "Dropoff coordinates are required"],
        },
      },
    },
    recipient: {
      name: {
        type: String,
        required: [true, "Recipient name is required"],
      },
      phone: {
        type: String,
        required: [true, "Recipient phone is required"],
        match: [/^(?:\+213[5-7]\d{8}|0[5-7]\d{8})$/, "Format de numéro de téléphone algérien invalide"],
      },
    },
    package: {
      type: {
        type: String,
        required: [true, "Package type is required"],
      },
      description: {
        type: String,
        required: [true, "Package description is required"],
      },
      weightKg: {
        type: Number,
        min: 0,
      },
      sizeCategory: {
        type: String,
        enum: ["small", "medium", "large", "xlarge"],
        required: [true, "Package size category is required"],
      },
    },
    deliveryNote: {
      type: String,
      maxlength: 500,
    },
    pricing: {
      baseFee: {
        type: Number,
        default: 0,
      },
      distanceFee: {
        type: Number,
        default: 0,
      },
      weightSurcharge: {
        type: Number,
        default: 0,
      },
      sizeSurcharge: {
        type: Number,
        default: 0,
      },
      urgentSurcharge: {
        type: Number,
        default: 0,
      },
      estimatedPrice: {
        type: Number,
        required: true,
      },
      finalPrice: {
        type: Number,
        default: null,
      },
      currency: {
        type: String,
        default: "DZD",
      },
    },
    payment: {
      method: {
        type: String,
        enum: ["card", "cash", "paypal"],
        required: true,
      },
      status: {
        type: String,
        enum: ["pending", "completed", "failed", "refunded", "cash_pending", "cash_received"],
        default: "pending",
      },
      transactionId: String,
    },
    status: {
      type: String,
      enum: [
        "Draft",
        "Pending",
        "Accepted",
        "DriverArrivedPickup",
        "PickedUp",
        "InTransit",
        "ArrivedDropoff",
        "Delivered",
        "CancelledByUser",
        "CancelledByDriver",
        "Rejected",
        "FailedDelivery",
        "Refunded",
      ],
      default: "Pending",
    },
    rejectedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Driver",
      },
    ],
    proofOfDelivery: {
      photoUrl: String,
      recipientName: String,
      recipientSignature: String,
      recipientCode: String,
      notes: String,
      confirmedAt: Date,
    },
    timeline: {
      acceptedAt: Date,
      driverArrivedPickupAt: Date,
      pickedUpAt: Date,
      inTransitAt: Date,
      arrivedDropoffAt: Date,
      deliveredAt: Date,
      cancelledAt: Date,
      failedAt: Date,
      refundedAt: Date,
    },
    cancellation: {
      reason: String,
      cancelledBy: {
        type: String,
        enum: ["user", "driver", "admin", "system"],
      },
    },
    isUrgent: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
)

deliverySchema.index({ sender: 1, createdAt: -1 })
deliverySchema.index({ assignedDriver: 1, status: 1, createdAt: -1 })
deliverySchema.index({ trip: 1, status: 1, createdAt: -1 })
deliverySchema.index({ status: 1, createdAt: -1 })
deliverySchema.index({ createdAt: -1 })
deliverySchema.index({ "pickup.location": "2dsphere" })
deliverySchema.index({ "dropoff.location": "2dsphere" })

const Delivery = mongoose.model("Delivery", deliverySchema)

export default Delivery
