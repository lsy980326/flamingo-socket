import dotenv from "dotenv";
dotenv.config();

import express, { Express, Request, Response } from "express";
import { createServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import cors from "cors";
import jwt from "jsonwebtoken";

// 서비스 및 설정 모듈
import { connectConsumer } from "./services/kafka.consumer";
import connectDB from "./config/db";
import logger from "./config/logger";
import redisClient from "./services/redis.client"; // Redis 클라이언트 import
import {
  debouncedSaveToMongo,
  flushAllPendingSaves,
} from "./services/persistence.service"; // 영속성 서비스 import

// 모델
import { ProjectModel } from "./models/project.model";
import { PageModel } from "./models/page.model";
import { CanvasModel } from "./models/canvas.model";
import { LayerModel } from "./models/layer.model";

//========================================
// 1. 초기화 (Initialization)
//========================================
connectDB();
connectConsumer();

const app: Express = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://ui-v2.greatwave.co.kr",
    ],
    methods: ["GET", "POST"],
  },
  transports: ["websocket"],
});

//========================================
// 2. Express 미들웨어 및 라우트
//========================================
app.use(cors());
app.use(express.json());
app.get("/", (req: Request, res: Response) => {
  res.send("Flamingo Socket Server is running!");
});

//========================================
// 3. 공통 JWT 인증 미들웨어 (메인 네임스페이스용)
//========================================
const mainJwtAuthMiddleware = (socket: Socket, next: (err?: Error) => void) => {
  const token =
    socket.handshake.auth.token || (socket.handshake.query.token as string);
  if (!token)
    return next(new Error("Authentication error: No token provided."));

  jwt.verify(token, process.env.JWT_SECRET!, (err: any, decoded: any) => {
    if (err) {
      logger.error("[Auth] Invalid token:", err.message);
      return next(new Error("Authentication error: Invalid token."));
    }
    socket.data.user = { id: decoded.id, email: decoded.email };
    next();
  });
};

//========================================
// 4. 메인 네임스페이스 (`/`): 메타데이터 관리
//========================================
const mainNamespace = io.of("/");
mainNamespace.use(mainJwtAuthMiddleware);
mainNamespace.on("connection", (socket) => {
  logger.info(
    `[Main] User connected: ${socket.data.user.email} (ID: ${socket.id})`
  );

  // --- 프로젝트 입장 및 초기 데이터 전송 ---
  socket.on("join-project", async (projectId: string) => {
    try {
      const project = await ProjectModel.findOne({ _id: projectId });
      const canJoin = project?.collaborators.some(
        (c) => c.userId === Number(socket.data.user.id)
      );
      if (!canJoin)
        return socket.emit("error", {
          message: "Permission denied to join project.",
        });

      socket.join(projectId);
      logger.info(
        `[Main] User ${socket.data.user.email} joined project room: ${projectId}`
      );

      const [pages, canvases, layers] = await Promise.all([
        PageModel.find({ projectId }).sort({ order: 1 }).lean(),
        CanvasModel.find({ projectId }).sort({ order: 1 }).lean(),
        LayerModel.find({ projectId }).sort({ order: 1 }).lean(), // 메타데이터만 전송
      ]);
      socket.emit("initial-data", { pages, canvases, layers });
    } catch (error) {
      socket.emit("error", { message: "Failed to join project." });
    }
  });

  // --- 페이지/캔버스/레이어 메타데이터 CRUD 핸들러들 ---
  socket.on("create-page", async ({ projectId, name }) => {
    try {
      // 권한 재확인 (editor 이상)
      const project = await ProjectModel.findOne({ _id: projectId });
      const userRole = project?.collaborators.find(
        (c) => c.userId === Number(socket.data.user.id)
      )?.role;
      if (userRole !== "owner" && userRole !== "editor") {
        socket.emit("error", {
          message: "Only owners or editors can create pages.",
        });
        return;
      }

      // 가장 마지막 순서 계산
      const lastPage = await PageModel.findOne({ projectId }).sort({
        order: -1,
      });
      const newOrder = lastPage ? lastPage.order + 1 : 0;

      const newPage = await PageModel.create({
        projectId,
        name,
        order: newOrder,
      });

      // Room에 있는 모든 클라이언트에게 브로드캐스트
      io.to(projectId).emit("page-created", newPage);
      logger.info(
        `[Page] New page created in project ${projectId} by ${socket.data.user.email}`
      );
    } catch (error) {
      socket.emit("error", { message: "Failed to create page." });
    }
  });

  // 페이지 수정
  socket.on("update-page", async ({ projectId, pageId, updates }) => {
    try {
      const project = await ProjectModel.findOne({ _id: projectId });
      const userRole = project?.collaborators.find(
        (c) => c.userId === Number(socket.data.user.id)
      )?.role;
      if (userRole !== "owner" && userRole !== "editor") {
        return socket.emit("error", {
          message: "Only owners or editors can update pages.",
        });
      }

      const updatedPage = await PageModel.findByIdAndUpdate(
        pageId,
        { $set: updates },
        { new: true }
      );

      if (updatedPage) {
        io.to(projectId).emit("page-updated", updatedPage);
        logger.info(
          `[Page] Page ${pageId} updated by ${socket.data.user.email}`
        );
      }
    } catch (error) {
      socket.emit("error", { message: "Failed to update page." });
    }
  });

  // 페이지 삭제
  socket.on("delete-page", async ({ projectId, pageId }) => {
    try {
      const project = await ProjectModel.findOne({ _id: projectId });
      const userRole = project?.collaborators.find(
        (c) => c.userId === Number(socket.data.user.id)
      )?.role;
      if (userRole !== "owner" && userRole !== "editor") {
        return socket.emit("error", {
          message: "Only owners or editors can delete pages.",
        });
      }

      // 연쇄 삭제: 이 페이지에 속한 모든 캔버스 ID 조회
      const canvasesToDelete = await CanvasModel.find({ pageId }).select("_id");
      const canvasIds = canvasesToDelete.map((c) => c._id);

      // 연쇄 삭제: 해당 캔버스들에 속한 모든 레이어 삭제
      if (canvasIds.length > 0) {
        await LayerModel.deleteMany({ canvasId: { $in: canvasIds } });
      }
      // 연쇄 삭제: 해당 페이지에 속한 모든 캔버스 삭제
      await CanvasModel.deleteMany({ pageId });
      // 최종적으로 페이지 삭제
      await PageModel.findByIdAndDelete(pageId);

      io.to(projectId).emit("page-deleted", { pageId });
      logger.info(
        `[Page] Page ${pageId} and its contents deleted by ${socket.data.user.email}`
      );
    } catch (error) {
      socket.emit("error", { message: "Failed to delete page." });
    }
  });

  socket.on(
    "create-canvas",
    async ({ pageId, projectId, name, width, height, unit }) => {
      try {
        // 권한 확인 (프로젝트 참여자인지, editor 이상인지 등)
        const project = await ProjectModel.findOne({ _id: projectId });
        const userRole = project?.collaborators.find(
          (c) => c.userId === Number(socket.data.user.id)
        )?.role;

        if (userRole !== "owner" && userRole !== "editor") {
          return socket.emit("error", {
            message: "Only owners or editors can create canvases.",
          });
        }

        // 해당 페이지가 존재하는지 확인
        const parentPage = await PageModel.findById(pageId);
        if (!parentPage) {
          return socket.emit("error", { message: "Parent page not found." });
        }

        // 순서 계산
        const lastCanvas = await CanvasModel.findOne({ pageId }).sort({
          order: -1,
        });
        const newOrder = lastCanvas ? lastCanvas.order + 1 : 0;

        const newCanvas = await CanvasModel.create({
          pageId,
          projectId, // projectId도 함께 저장
          name,
          width,
          height,
          unit,
          order: newOrder,
        });

        // 프로젝트 Room에 있는 모든 클라이언트에게 브로드캐스트
        io.to(projectId).emit("canvas-created", newCanvas);
        logger.info(
          `[Canvas] New canvas '${name}' created on page ${pageId} by ${socket.data.user.email}`
        );
      } catch (error) {
        logger.error(`[Error] Failed to create canvas:`, error);
        socket.emit("error", { message: "Failed to create canvas." });
      }
    }
  );

  socket.on("update-canvas", async ({ projectId, canvasId, updates }) => {
    try {
      // 권한 확인 (editor 이상)
      const project = await ProjectModel.findOne({ _id: projectId });
      const userRole = project?.collaborators.find(
        (c) => c.userId === Number(socket.data.user.id)
      )?.role;
      if (userRole !== "owner" && userRole !== "editor") {
        return socket.emit("error", {
          message: "Only owners or editors can update canvases.",
        });
      }

      const updatedCanvas = await CanvasModel.findByIdAndUpdate(
        canvasId,
        { $set: updates },
        { new: true }
      );

      if (updatedCanvas) {
        io.to(projectId).emit("canvas-updated", updatedCanvas);
        logger.info(
          `[Canvas] Canvas ${canvasId} updated by ${socket.data.user.email}`
        );
      }
    } catch (error) {
      socket.emit("error", { message: "Failed to update canvas." });
    }
  });

  socket.on("delete-canvas", async ({ projectId, canvasId }) => {
    try {
      // 권한 확인 (editor 이상)
      const project = await ProjectModel.findOne({ _id: projectId });
      const userRole = project?.collaborators.find(
        (c) => c.userId === Number(socket.data.user.id)
      )?.role;
      if (userRole !== "owner" && userRole !== "editor") {
        return socket.emit("error", {
          message: "Only owners or editors can delete canvases.",
        });
      }

      // 연쇄 삭제: 이 캔버스에 속한 모든 레이어 삭제
      await LayerModel.deleteMany({ canvasId: canvasId });

      // 캔버스 삭제
      await CanvasModel.findByIdAndDelete(canvasId);

      io.to(projectId).emit("canvas-deleted", { canvasId, projectId });
      logger.info(
        `[Canvas] Canvas ${canvasId} and its layers deleted by ${socket.data.user.email}`
      );
    } catch (error) {
      socket.emit("error", { message: "Failed to delete canvas." });
    }
  });

  socket.on("create-layer", async ({ canvasId, projectId, name, type }) => {
    try {
      // 권한 확인 (editor 이상)
      const project = await ProjectModel.findOne({ _id: projectId });
      const userRole = project?.collaborators.find(
        (c) => c.userId === Number(socket.data.user.id)
      )?.role;
      if (userRole !== "owner" && userRole !== "editor") {
        return socket.emit("error", {
          message: "Only owners or editors can create layers.",
        });
      }

      // 부모 캔버스 존재 확인
      const parentCanvas = await CanvasModel.findById(canvasId);
      if (!parentCanvas) {
        return socket.emit("error", { message: "Parent canvas not found." });
      }

      // 순서 계산
      const lastLayer = await LayerModel.findOne({ canvasId }).sort({
        order: -1,
      });
      const newOrder = lastLayer ? lastLayer.order + 1 : 0;

      const newLayer = await LayerModel.create({
        canvasId,
        projectId,
        name,
        type,
        order: newOrder,
      });

      // 프로젝트 Room에 브로드캐스트
      io.to(projectId).emit("layer-created", newLayer);
      logger.info(`[Layer] New layer '${name}' created on canvas ${canvasId}`);
    } catch (error) {
      logger.error(`[Error] Failed to create layer:`, error);
      socket.emit("error", { message: "Failed to create layer." });
    }
  });

  socket.on("update-layer", async ({ projectId, layerId, updates }) => {
    try {
      // 권한 확인 (editor 이상)
      const project = await ProjectModel.findOne({ _id: projectId });
      const userRole = project?.collaborators.find(
        (c) => c.userId === Number(socket.data.user.id)
      )?.role;
      if (userRole !== "owner" && userRole !== "editor") {
        return socket.emit("error", {
          message: "Only owners or editors can update layers.",
        });
      }

      // 'data' 필드는 이 이벤트로 수정할 수 없도록 방지
      if (updates.data) {
        delete updates.data;
      }

      const updatedLayer = await LayerModel.findByIdAndUpdate(
        layerId,
        { $set: updates },
        { new: true }
      );

      if (updatedLayer) {
        io.to(projectId).emit("layer-updated", updatedLayer);
        logger.info(
          `[Layer] Layer ${layerId} updated by ${socket.data.user.email}`
        );
      }
    } catch (error) {
      socket.emit("error", { message: "Failed to update layer." });
    }
  });

  socket.on("delete-layer", async ({ projectId, layerId }) => {
    try {
      // 권한 확인 (editor 이상)
      const project = await ProjectModel.findOne({ _id: projectId });
      const userRole = project?.collaborators.find(
        (c) => c.userId === Number(socket.data.user.id)
      )?.role;
      if (userRole !== "owner" && userRole !== "editor") {
        return socket.emit("error", {
          message: "Only owners or editors can delete layers.",
        });
      }

      await LayerModel.findByIdAndDelete(layerId);

      io.to(projectId).emit("layer-deleted", { layerId, projectId });
      logger.info(
        `[Layer] Layer ${layerId} deleted by ${socket.data.user.email}`
      );
    } catch (error) {
      socket.emit("error", { message: "Failed to delete layer." });
    }
  });

  socket.on("disconnect", () => {
    logger.info(`[Socket.IO] user disconnected: ${socket.id}`);
  });
});

//========================================
// 5. 동적 레이어 네임스페이스 (`/layer-*`): Yjs/WebRTC 및 데이터 영속성
//========================================
const layerNamespace = io.of(/^\/layer-.+$/);
// 레이어 네임스페이스용 인증/인가 미들웨어
layerNamespace.use(async (socket, next) => {
  try {
    const token =
      socket.handshake.auth.token || (socket.handshake.query.token as string);
    if (!token)
      return next(new Error("Authentication error: No token provided."));

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: number;
      email: string;
    };
    socket.data.user = { id: decoded.id, email: decoded.email };

    const layerId = socket.nsp.name.replace("/layer-", "");
    const layer = await LayerModel.findById(layerId).select("projectId").lean();
    if (!layer) return next(new Error("Permission denied: Layer not found."));

    const project = await ProjectModel.findOne({ _id: layer.projectId })
      .select("collaborators")
      .lean();
    if (!project)
      return next(new Error("Permission denied: Project not found."));

    const userRole = project.collaborators.find(
      (c) => c.userId === Number(socket.data.user.id)
    )?.role;
    if (userRole !== "owner" && userRole !== "editor") {
      return next(new Error("Permission denied: Not an editor."));
    }

    next();
  } catch (error) {
    logger.error("[AuthZ] Error during layer permission check:", error);
    return next(new Error("Permission check failed."));
  }
});
layerNamespace.on("connection", (socket) => {
  const layerId = socket.nsp.name.substring("/layer-".length);
  const user = socket.data.user;
  logger.info(`[Layer Namespace] User connected to layer: ${layerId}`);
  logger.info(`User connected: ${user.email}`);

  // --- ▼▼▼▼▼ Y-WebRTC v13+ 표준 시그널링 서버 로직 ▼▼▼▼▼ ---

  /**
   * 클라이언트가 시그널링 Room에 참여를 요청.
   * Room에 이미 있는 다른 피어들의 목록을 요청한 클라이언트에게 보내줌.
   */
  socket.on("y-webrtc-join", async (roomName: string) => {
    if (roomName !== layerId) {
      // 클라이언트가 접속한 네임스페이스와 다른 Room에 참여하려고 하면 거부 (보안 강화)
      return;
    }
    socket.join(roomName);

    // 현재 Room에 있는 다른 소켓들의 ID 목록을 가져옴
    const otherSockets = await layerNamespace.in(roomName).fetchSockets();
    const otherPeerIds = otherSockets
      .map((s) => s.id)
      .filter((id) => id !== socket.id); // 자기 자신은 제외

    // 요청한 클라이언트에게만 기존 피어 목록을 알려줌
    socket.emit("y-webrtc-joined", { room: roomName, peers: otherPeerIds });

    logger.info(
      `[WebRTC] User ${user.email} joined y-webrtc room: ${roomName}`
    );
  });

  /**
   * WebRTC 시그널링 메시지를 특정 피어에게 전달(relay).
   */
  socket.on("y-webrtc-signal", (payload) => {
    const { to, from, signal } = payload;
    // 'to' 소켓 ID를 가진 특정 클라이언트에게만 메시지 전송
    layerNamespace.to(to).emit("y-webrtc-signal", { from, signal });
    // logger.info(`[WebRTC] Relaying signal from ${from} to ${to}`);
  });

  /**
   * 클라이언트 연결이 끊겼을 때, Room에 있던 다른 피어들에게 알림.
   */
  socket.on("disconnecting", () => {
    socket.rooms.forEach((room) => {
      if (room !== socket.id) {
        // `y-webrtc-left` 이벤트로 변경
        socket.to(room).emit("y-webrtc-left", { room, peerId: socket.id });
        logger.info(`[WebRTC] User ${user.email} left y-webrtc room: ${room}`);
      }
    });
  });

  // --- ▲▲▲▲▲ Y-WebRTC v13+ 표준 시그널링 서버 로직 끝 ▲▲▲▲▲ ---

  // y-socket.io Provider가 보내는 업데이트 메시지를 릴레이
  socket.on("yjs-update", (update) => {
    // 자신을 제외한 Room의 다른 클라이언트에게 브로드캐스트
    socket.to(layerId).emit("yjs-update", update);
  });

  // y-socket.io Provider가 보내는 awareness 업데이트를 릴레이
  socket.on("yjs-awareness", (update) => {
    socket.to(layerId).emit("yjs-awareness", update);
  });

  /**
   * 클라이언트가 특정 레이어의 최신 데이터 스냅샷을 요청
   */
  socket.on("request-layer-data", async (callback) => {
    if (typeof callback !== "function") return;

    const redisKey = `yjs-doc:${layerId}`;

    try {
      const dataFromRedis = await redisClient.getBuffer(redisKey);

      if (dataFromRedis) {
        // Redis 데이터는 이미 순수한 Buffer이므로 그대로 전송
        callback(dataFromRedis);
        return;
      }

      logger.warn(
        `[Yjs] Cache miss for layer ${layerId}. Loading from MongoDB.`
      );
      const layerFromMongo = await LayerModel.findById(layerId)
        .select("data")
        .lean();

      if (layerFromMongo && layerFromMongo.data) {
        const mongoBinaryData = layerFromMongo.data as Binary;

        // Mongoose/MongoDB의 Binary 객체에서 순수한 Buffer를 추출
        const dataBuffer = mongoBinaryData.buffer;

        // 클라이언트에게는 순수한 Buffer만 전달
        callback(dataBuffer);

        // Redis에도 순수한 Buffer를 저장
        await redisClient.set(redisKey, dataBuffer, "EX", 86400);
        logger.info(`[Yjs] Warmed up Redis cache for layer ${layerId}.`);
      } else {
        callback(null);
      }
    } catch (error) {
      logger.error(`[Yjs] Failed to load data for layer ${layerId}:`, error);
      callback(null);
    }
  });

  // 클라이언트로부터 데이터 저장 요청 수신
  socket.on("save-layer-data", async (docUpdate: Buffer) => {
    console.log(`[Yjs] Received save-layer-data event.`);
    console.log(`[Yjs] Data type: ${typeof docUpdate}`);
    console.log(`[Yjs] Is Buffer? ${Buffer.isBuffer(docUpdate)}`);
    console.log(`[Yjs] Received data content:`, docUpdate);

    const key = `yjs-doc:${layerId}`;
    try {
      await redisClient.set(key, docUpdate, "EX", 86400); // 24시간 만료
      logger.info(`[Yjs] Saved data for layer ${layerId} to Redis.`);
      debouncedSaveToMongo(layerId);
    } catch (error) {
      logger.error(`[Yjs] Failed to save data for layer ${layerId}:`, error);
      socket.emit("error", {
        message: `Failed to save layer data for ${layerId}`,
      });
    }
  });
});

//========================================
// 6. Y-WebRTC 시그널링 전용 네임스페이스
//========================================
// --- 6. Y-WebRTC 시그널링 전용 네임스페이스 ---
const webrtcNamespace = io.of("/webrtc");

webrtcNamespace.use((socket, next) => {
  try {
    const token =
      socket.handshake.auth.token || (socket.handshake.query.token as string);
    if (!token)
      return next(new Error("Authentication error: No token provided."));

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: number;
      email: string;
    };
    socket.data.user = { id: decoded.id, email: decoded.email };
    next();
  } catch (err: any) {
    logger.error("[WebRTC-Signaling Auth] Invalid token:", err.message);
    return next(new Error("Authentication error: Invalid token."));
  }
});

webrtcNamespace.on("connection", (socket) => {
  const user = socket.data.user;
  logger.info(
    `[WebRTC-Signaling] User connected: ${user.email} (ID: ${socket.id})`
  );

  // y-webrtc v13+ 표준 이벤트 핸들러들
  socket.on("y-webrtc-join", async (roomName) => {
    socket.join(roomName);

    // 현재 Room에 있는 다른 소켓들의 ID 목록을 가져옴
    const otherSockets = await webrtcNamespace.in(roomName).fetchSockets();
    const otherPeerIds = otherSockets
      .map((s) => s.id)
      .filter((id) => id !== socket.id);

    // 요청한 클라이언트에게만 기존 피어 목록을 알려줌
    socket.emit("y-webrtc-joined", { room: roomName, peers: otherPeerIds });
    logger.info(
      `[WebRTC-Signaling] User ${user.email} joined room: ${roomName}`
    );
  });

  socket.on("y-webrtc-signal", ({ to, signal }) => {
    // 이 네임스페이스 내에서 특정 소켓에게만 메시지 전송
    webrtcNamespace.to(to).emit("y-webrtc-signal", { from: socket.id, signal });
  });

  socket.on("y-webrtc-awareness-update", (payload) => {
    socket.rooms.forEach((room) => {
      if (room !== socket.id) {
        socket
          .to(room)
          .emit("y-webrtc-awareness-update", { ...payload, peerId: socket.id });
      }
    });
  });

  socket.on("disconnecting", () => {
    socket.rooms.forEach((room) => {
      if (room !== socket.id) {
        socket.to(room).emit("y-webrtc-left", { room, peerId: socket.id });
      }
    });
  });
});

//========================================
// 7. 5. Graceful Shutdown Logic
//========================================
const gracefulShutdown = () => {
  logger.info("Received kill signal, initiating graceful shutdown...");

  // 현재 Debounce 대기열에 있는 모든 DB 저장 작업을 즉시 실행
  flushAllPendingSaves();

  // 서버가 새로운 연결을 더 이상 받지않음음
  httpServer.close(() => {
    logger.info("All connections closed. Server is shutting down.");
    // 모든 작업이 완료되면 프로세스를 종료.
    process.exit(0);
  });

  setTimeout(() => {
    logger.error(
      "Could not close connections in time, forcefully shutting down."
    );
    process.exit(1);
  }, 5000); // 5초
};

// 종료 신호 리스너 등록
process.on("SIGTERM", gracefulShutdown); // 예: `kill` 명령어, AWS ECS, Kubernetes
process.on("SIGINT", gracefulShutdown); // 예: `Ctrl+C` in terminal

//========================================
// 8. 서버 실행
//========================================
const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  logger.info(`[Server] Server is running at http://localhost:${PORT}`);
});
