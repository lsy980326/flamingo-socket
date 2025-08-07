import winston from "winston";

const { combine, timestamp, printf, colorize } = winston.format;

// 로그 출력 형식 정의
const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

const logger = winston.createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), logFormat),
  transports: [
    // 프로덕션 환경이 아닐 경우에만 콘솔에 로그 출력
    new winston.transports.Console({
      format: combine(
        colorize(), // 로그 레벨에 따라 색상 적용
        logFormat
      ),
    }),
    // TODO: 프로덕션 환경에서는 파일 또는 클라우드 로깅 서비스(e.g., CloudWatch)로 로그를 보낼 수 있습니다.
    // new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    // new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

export default logger;
