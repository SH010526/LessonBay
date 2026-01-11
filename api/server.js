const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const dotenv = require('dotenv');
const db = require('./config/database');
const logger = require('./config/logger');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// Performance Optimization: Cache Configuration
// ============================================
const cacheStore = new Map();
const CACHE_TTL = process.env.CACHE_TTL || 3600000; // 1 hour default

// Cache middleware for GET requests
const cacheMiddleware = (req, res, next) => {
  // Only cache GET requests
  if (req.method !== 'GET') {
    return next();
  }

  const cacheKey = `${req.method}:${req.originalUrl}`;
  const cachedResponse = cacheStore.get(cacheKey);

  if (cachedResponse && Date.now() - cachedResponse.timestamp < CACHE_TTL) {
    logger.info(`Cache hit for: ${cacheKey}`);
    res.set('X-Cache', 'HIT');
    return res.json(cachedResponse.data);
  }

  res.set('X-Cache', 'MISS');
  
  // Store original json method
  const originalJson = res.json.bind(res);
  
  // Override json method to cache response
  res.json = function(data) {
    cacheStore.set(cacheKey, {
      data,
      timestamp: Date.now()
    });
    
    // Clean up old cache entries periodically
    if (cacheStore.size > 100) {
      const now = Date.now();
      for (const [key, value] of cacheStore.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
          cacheStore.delete(key);
        }
      }
    }
    
    return originalJson(data);
  };
  
  next();
};

// ============================================
// Performance Optimization: Early DB Connection
// ============================================
const initializeDatabase = async () => {
  try {
    await db.connect();
    logger.info('Database connected successfully');
    return true;
  } catch (error) {
    logger.error('Failed to connect to database:', error);
    process.exit(1);
  }
};

// ============================================
// Middleware Configuration (Optimized Order)
// ============================================

// Security middleware - early in chain
app.use(helmet());

// Compression middleware - before parsing
app.use(compression({
  level: 6, // Balance between speed and compression ratio
  threshold: 1024, // Only compress responses larger than 1KB
}));

// Logging middleware
app.use(morgan('combined', { stream: logger.stream }));

// CORS middleware with options
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parsing middleware with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Response caching middleware - after body parsing
app.use(cacheMiddleware);

// ============================================
// Health Check Endpoint (lightweight)
// ============================================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ============================================
// API Routes
// ============================================
app.use('/api/users', require('./routes/users'));
app.use('/api/lessons', require('./routes/lessons'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/payments', require('./routes/payments'));

// ============================================
// Error Handling Middleware
// ============================================

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `The requested resource ${req.originalUrl} was not found`,
    timestamp: new Date().toISOString(),
  });
});

// Global error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  
  logger.error(`Error [${status}]: ${message}`, {
    url: req.originalUrl,
    method: req.method,
    stack: err.stack,
  });

  res.status(status).json({
    error: true,
    status,
    message,
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// Server Startup
// ============================================

const startServer = async () => {
  try {
    // Initialize database connection first
    await initializeDatabase();

    // Start Express server
    const server = app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received. Shutting down gracefully...');
      server.close(async () => {
        await db.disconnect();
        logger.info('Server shut down successfully');
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      logger.info('SIGINT received. Shutting down gracefully...');
      server.close(async () => {
        await db.disconnect();
        logger.info('Server shut down successfully');
        process.exit(0);
      });
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Start the server
startServer();

module.exports = app;
