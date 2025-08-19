import { Redis } from "ioredis";
import dotenv from "dotenv";
import logger from "../config/logger";

dotenv.config();

const redisOptions = {
  // AWS ElastiCache 등 외부 Redis 연결 시 필요한 옵션들
  // 예: tls: {}, password: '...'
  lazyConnect: true, // 필요할 때만 연결
};

// 1. 일반 명령을 위한 메인 클라이언트
const redisClient = new Redis(process.env.REDIS_URL!, redisOptions);

redisClient.on("connect", () => {
  logger.info("✅ Redis (Main Client) connected");
});
redisClient.on("error", (err) => {
  logger.error("Redis (Main Client) connection error:", err);
});
redisClient
  .connect()
  .catch((err) => logger.error("Main Redis client connection failed", err));

// 2. Socket.IO 어댑터의 Publisher 역할을 할 클라이언트
export const pubClient = new Redis(process.env.REDIS_URL!, redisOptions);
// 3. Socket.IO 어댑터의 Subscriber 역할을 할 클라이언트
export const subClient = pubClient.duplicate(); // pubClient를 복제하여 생성

Promise.all([pubClient.connect(), subClient.connect()])
  .then(() =>
    logger.info("✅ Redis Pub/Sub clients connected for Socket.IO Adapter")
  )
  .catch((err) => logger.error("Redis Pub/Sub client connection failed", err));

// 일반적인 CRUD 작업에는 이 메인 클라이언트를 export하여 사용
export default redisClient;
