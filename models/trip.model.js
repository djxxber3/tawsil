import mongoose from "mongoose"

const tripSchema = new mongoose.Schema(
  {
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },
    title: {
      type: String,
      trim: true,
      maxlength: 120,
    },
    origin: {
      address: {
        type: String,
        required: [true, "Origin address is required"],
      },
      location: {
        type: {
          type: String,
          enum: ["Point"],
          default: "Point",
        },
        coordinates: {
          type: [Number],
          required: [true, "Origin coordinates are required"],
        },
      },
    },
    destination: {
      address: {
        type: String,
        required: [true, "Destination address is required"],
      },
      location: {
        type: {
          type: String,
          enum: ["Point"],
          default: "Point",
        },
        coordinates: {
          type: [Number],
          required: [true, "Destination coordinates are required"],
        },
      },
    },
    departureTime: {
      type: Date,
      required: true,
    },
    expectedArrivalTime: {
      type: Date,
    },
    maxDeliveries: {
      type: Number,
      default: 3,
      min: 1,
      max: 50,
    },
    availableCapacity: {
      type: Number,
      default: 3,
      min: 0,
    },
    status: {
      type: String,
      enum: ["planned", "active", "completed", "cancelled"],
      default: "planned",
    },
    notes: {
      type: String,
      maxlength: 500,
    },
  },
  {
    timestamps: true,
  },
)

tripSchema.index({ driver: 1, status: 1, createdAt: -1 })
tripSchema.index({ departureTime: 1 })
tripSchema.index({ "origin.location": "2dsphere" })
tripSchema.index({ "destination.location": "2dsphere" })

const Trip = mongoose.model("Trip", tripSchema)

export default Trip
