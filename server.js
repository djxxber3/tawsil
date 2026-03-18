import express from "express";
import dotenv from "dotenv";
import { connectDB } from "./lib/db.js"; 
import authRoutes from "./routes/auth.routes.js"
import mapsRoutes from "./routes/maps.routes.js"
import tripRoutes from "./routes/trip.routes.js"
import deliveryRoutes from "./routes/delivery.routes.js"
dotenv.config();

const app = express();

const isAllowedOrigin = (origin) => {
  if (!origin) {
    return false;
  }

  return (
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:")
  );
};

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json());

const PORT = process.env.PORT || 5000;

app.use("/api/auth", authRoutes);
app.use("/api/maps", mapsRoutes);
app.use("/api/trips", tripRoutes);
app.use("/api/deliveries", deliveryRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    details: null,
  })
})

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500

  res.status(statusCode).json({
    success: false,
    message: err.message || "Internal server error",
    details: err.details || null,
  })
})

const startServer = async () => {
  try {
    await connectDB();  
    app.listen(PORT, () => {
      console.log(`Serveur lancé sur le port ${PORT}`);
    });
  } catch (error) {
    console.error("Erreur lors de la connexion à la base de données :", error);
    process.exit(1);  
  }
};

startServer();
